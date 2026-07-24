#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });
loadEnv();

const DEFAULT_BASE_URL = "https://platform.higgsfield.ai";
const DEFAULT_IMAGE_MODEL_ID = "higgsfield-ai/soul/standard";
const DEFAULT_VIDEO_MODEL_ID = "dop-standard";
const DOP_VIDEO_ENDPOINT = "/v1/image2video/dop";
const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 180000;
const ACTIVE_STATUSES = new Set(["queued", "in_progress"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "nsfw"]);

type JsonObject = Record<string, unknown>;

type HiggsfieldResponse = JsonObject & {
  status?: string;
  request_id?: string;
  status_url?: string;
  cancel_url?: string;
  images?: Array<{ url?: string }>;
  video?: { url?: string };
};

function env(names: string[]): string {
  const found = names.find((name) => process.env[name]);
  const value = found ? process.env[found] : undefined;

  if (!value) {
    throw new Error(`Missing required environment variable. Set one of: ${names.join(", ")}`);
  }

  return value;
}

function optionalEnv(names: string[], fallback: string): string {
  const found = names.find((name) => process.env[name]);
  return found ? process.env[found] ?? fallback : fallback;
}

function positiveIntegerFromEnv(names: string[], fallback: number): number {
  const raw = optionalEnv(names, String(fallback));
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for ${names.join(" or ")}, got: ${raw}`);
  }

  return parsed;
}

const defaultImageModelId = optionalEnv(["HF_IMAGE_MODEL", "HIGGSFIELD_IMAGE_MODEL"], DEFAULT_IMAGE_MODEL_ID);
const defaultVideoModelId = optionalEnv(["HF_VIDEO_MODEL", "HIGGSFIELD_VIDEO_MODEL"], DEFAULT_VIDEO_MODEL_ID);
const defaultFirstLastVideoModelId = optionalEnv(
  ["HF_FIRST_LAST_VIDEO_MODEL", "HIGGSFIELD_FIRST_LAST_VIDEO_MODEL"],
  defaultVideoModelId,
);
const defaultPollSeconds = Math.ceil(
  positiveIntegerFromEnv(["HF_POLL_MS", "HIGGSFIELD_POLL_MS"], DEFAULT_POLL_MS) / 1000,
);
const defaultTimeoutSeconds = Math.ceil(
  positiveIntegerFromEnv(["HF_TIMEOUT_MS", "HIGGSFIELD_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS) / 1000,
);

function baseUrl(): string {
  return optionalEnv(["HF_API_BASE_URL", "HIGGSFIELD_BASE_URL"], DEFAULT_BASE_URL).replace(/\/$/, "");
}

function authHeader(): string {
  return `Key ${env(["HF_API_KEY", "HIGGSFIELD_API_KEY"])}:${env(["HF_API_SECRET", "HIGGSFIELD_API_SECRET"])}`;
}

function stripUndefined(input: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function inputImage(imageUrl: string): JsonObject {
  return {
    type: "image_url",
    image_url: imageUrl,
  };
}

function dopVideoBody({
  imageUrl,
  endImageUrl,
  prompt,
  modelId,
  extraParams,
}: {
  imageUrl: string;
  endImageUrl?: string;
  prompt: string;
  modelId: string;
  extraParams?: JsonObject;
}): JsonObject {
  return stripUndefined({
    ...(extraParams ?? {}),
    model: modelId,
    prompt,
    input_images: [inputImage(imageUrl), ...(endImageUrl ? [inputImage(endImageUrl)] : [])],
  });
}

function directVideoModelBody({
  imageUrl,
  endImageUrl,
  prompt,
  duration,
  extraParams,
}: {
  imageUrl: string;
  endImageUrl?: string;
  prompt: string;
  duration?: number;
  extraParams?: JsonObject;
}): JsonObject {
  return stripUndefined({
    ...(extraParams ?? {}),
    image_url: imageUrl,
    prompt,
    duration,
    end_image_url: endImageUrl,
  });
}

function endpoint(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }

  return `${baseUrl()}/${pathOrUrl.replace(/^\//, "")}`;
}

async function readJsonResponse(response: Response): Promise<HiggsfieldResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : { message: await response.text() };

  if (!response.ok) {
    throw new Error(`Higgsfield API returned ${response.status}: ${JSON.stringify(body)}`);
  }

  return body as HiggsfieldResponse;
}

async function higgsfieldRequest(
  method: "GET" | "POST",
  pathOrUrl: string,
  body?: JsonObject,
): Promise<HiggsfieldResponse> {
  const response = await fetch(endpoint(pathOrUrl), {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return readJsonResponse(response);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilDone(
  statusUrl: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
): Promise<HiggsfieldResponse> {
  const startedAt = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const intervalMs = pollIntervalSeconds * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await higgsfieldRequest("GET", statusUrl);
    const state = status.status;

    if (state && TERMINAL_STATUSES.has(state)) {
      return status;
    }

    if (state && !ACTIVE_STATUSES.has(state)) {
      return status;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutSeconds}s while waiting for Higgsfield generation.`);
}

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function jsonResult(title: string, value: unknown): CallToolResult {
  return textResult(`${title}\n\n${JSON.stringify(value, null, 2)}`);
}

const server = new McpServer({
  name: "higgsfield-mcp",
  version: "1.0.0",
});

server.registerTool(
  "generate_higgsfield_image",
  {
    title: "Generate Higgsfield Image",
    description:
      "Generate an image with the Higgsfield API. This tool calls Higgsfield directly and may spend API credits.",
    inputSchema: {
      prompt: z.string().min(1).describe("Text prompt for the generated image."),
      model_id: z
        .string()
        .default(defaultImageModelId)
        .describe(`Higgsfield model id. Defaults to ${defaultImageModelId}.`),
      aspect_ratio: z.string().default("16:9").describe('Aspect ratio, for example "16:9", "1:1", or "9:16".'),
      resolution: z.string().default("720p").describe('Resolution, for example "720p".'),
      poll: z.boolean().default(true).describe("Poll until the request completes and return image URLs."),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(900)
        .default(defaultTimeoutSeconds)
        .describe("Polling timeout in seconds."),
      poll_interval_seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(defaultPollSeconds)
        .describe("Seconds between status polls."),
      extra_params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Additional Higgsfield model parameters to include in the JSON request body."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    prompt,
    model_id,
    aspect_ratio,
    resolution,
    poll,
    timeout_seconds,
    poll_interval_seconds,
    extra_params,
  }) => {
    const body = stripUndefined({
      ...(extra_params ?? {}),
      prompt,
      aspect_ratio,
      resolution,
    });

    const submitted = await higgsfieldRequest("POST", model_id, body);

    if (!poll) {
      return jsonResult("Higgsfield request submitted.", submitted);
    }

    const statusUrl =
      submitted.status_url ??
      (submitted.request_id ? `${baseUrl()}/requests/${submitted.request_id}/status` : undefined);

    if (!statusUrl) {
      return jsonResult("Higgsfield request submitted, but no status URL was returned.", submitted);
    }

    const completed = await pollUntilDone(statusUrl, timeout_seconds, poll_interval_seconds);
    return jsonResult("Higgsfield generation result.", completed);
  },
);

server.registerTool(
  "generate_higgsfield_image_to_video",
  {
    title: "Generate Higgsfield Image To Video",
    description:
      "Generate a video from one image, or from first and last frame images, with the Higgsfield API. This tool calls Higgsfield directly and may spend API credits.",
    inputSchema: {
      image_url: z.string().url().describe("Public URL for the first/source image."),
      prompt: z.string().min(1).describe("Motion prompt for the generated video."),
      model_id: z
        .string()
        .default(defaultVideoModelId)
        .describe(
          `Higgsfield image-to-video model id. Defaults to ${defaultVideoModelId}. Use dop-lite, dop-standard, or dop-turbo for the DoP endpoint, or pass a full model path such as higgsfield-ai/dop/standard.`,
        ),
      duration: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Requested video duration in seconds, when supported by the selected model."),
      end_image_url: z
        .string()
        .url()
        .optional()
        .describe("Optional public URL for the final frame image for first/last-frame models."),
      poll: z.boolean().default(true).describe("Poll until the request completes and return video URLs."),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(1800)
        .default(defaultTimeoutSeconds)
        .describe("Polling timeout in seconds."),
      poll_interval_seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(defaultPollSeconds)
        .describe("Seconds between status polls."),
      extra_params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Additional Higgsfield model parameters to include in the JSON request body."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    image_url,
    prompt,
    model_id,
    duration,
    end_image_url,
    poll,
    timeout_seconds,
    poll_interval_seconds,
    extra_params,
  }) => {
    const isDopModel = model_id.startsWith("dop-");
    const pathOrUrl = isDopModel ? DOP_VIDEO_ENDPOINT : model_id;
    const body = isDopModel
      ? dopVideoBody({
          imageUrl: image_url,
          endImageUrl: end_image_url,
          prompt,
          modelId: model_id,
          extraParams: extra_params,
        })
      : directVideoModelBody({
          imageUrl: image_url,
          endImageUrl: end_image_url,
          prompt,
          duration,
          extraParams: extra_params,
        });

    const submitted = await higgsfieldRequest("POST", pathOrUrl, body);

    if (!poll) {
      return jsonResult("Higgsfield image-to-video request submitted.", submitted);
    }

    const statusUrl =
      submitted.status_url ??
      (submitted.request_id ? `${baseUrl()}/requests/${submitted.request_id}/status` : undefined);

    if (!statusUrl) {
      return jsonResult("Higgsfield image-to-video request submitted, but no status URL was returned.", submitted);
    }

    const completed = await pollUntilDone(statusUrl, timeout_seconds, poll_interval_seconds);
    return jsonResult("Higgsfield image-to-video generation result.", completed);
  },
);

server.registerTool(
  "generate_higgsfield_first_last_frame_video",
  {
    title: "Generate Higgsfield First Last Frame Video",
    description:
      "Generate a video transition from a required start image to a required ending image with the Higgsfield DoP first/last-frame workflow. This tool calls Higgsfield directly and may spend API credits.",
    inputSchema: {
      start_image_url: z.string().url().describe("Public URL for the first/start frame image."),
      end_image_url: z.string().url().describe("Public URL for the final/end frame image."),
      prompt: z.string().min(1).describe("Motion and transition prompt for the generated video."),
      model_id: z
        .string()
        .default(defaultFirstLastVideoModelId)
        .describe(
          `Higgsfield first/last-frame model id. Defaults to ${defaultFirstLastVideoModelId}. Use dop-standard for best DoP quality, dop-turbo for faster iteration, or dop-lite for cheaper drafts.`,
        ),
      poll: z.boolean().default(true).describe("Poll until the request completes and return video URLs."),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(1800)
        .default(defaultTimeoutSeconds)
        .describe("Polling timeout in seconds."),
      poll_interval_seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(defaultPollSeconds)
        .describe("Seconds between status polls."),
      extra_params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Additional Higgsfield model parameters to include in the JSON request body."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    start_image_url,
    end_image_url,
    prompt,
    model_id,
    poll,
    timeout_seconds,
    poll_interval_seconds,
    extra_params,
  }) => {
    const isDopModel = model_id.startsWith("dop-");
    const pathOrUrl = isDopModel ? DOP_VIDEO_ENDPOINT : model_id;
    const body = isDopModel
      ? dopVideoBody({
          imageUrl: start_image_url,
          endImageUrl: end_image_url,
          prompt,
          modelId: model_id,
          extraParams: extra_params,
        })
      : directVideoModelBody({
          imageUrl: start_image_url,
          endImageUrl: end_image_url,
          prompt,
          extraParams: extra_params,
        });

    const submitted = await higgsfieldRequest("POST", pathOrUrl, body);

    if (!poll) {
      return jsonResult("Higgsfield first/last-frame video request submitted.", submitted);
    }

    const statusUrl =
      submitted.status_url ??
      (submitted.request_id ? `${baseUrl()}/requests/${submitted.request_id}/status` : undefined);

    if (!statusUrl) {
      return jsonResult("Higgsfield first/last-frame video request submitted, but no status URL was returned.", submitted);
    }

    const completed = await pollUntilDone(statusUrl, timeout_seconds, poll_interval_seconds);
    return jsonResult("Higgsfield first/last-frame video generation result.", completed);
  },
);

server.registerTool(
  "get_higgsfield_request_status",
  {
    title: "Get Higgsfield Request Status",
    description: "Check the status of a Higgsfield request. This is read-only and does not require approval.",
    inputSchema: {
      request_id: z.string().min(1).describe("Higgsfield request id returned by a generation call."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ request_id }) => {
    const status = await higgsfieldRequest("GET", `/requests/${request_id}/status`);
    return jsonResult("Higgsfield request status.", status);
  },
);

server.registerTool(
  "cancel_higgsfield_request",
  {
    title: "Cancel Higgsfield Request",
    description:
      "Cancel a queued Higgsfield request directly.",
    inputSchema: {
      request_id: z.string().min(1).describe("Higgsfield request id to cancel."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ request_id }) => {
    const cancelled = await higgsfieldRequest("POST", `/requests/${request_id}/cancel`);
    return jsonResult("Higgsfield cancellation result.", cancelled);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
