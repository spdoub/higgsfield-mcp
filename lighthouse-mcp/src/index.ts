#!/usr/bin/env node
import { dirname, resolve, isAbsolute } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import lighthouse, { desktopConfig, type Result } from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const CATEGORY_IDS = ["performance", "accessibility", "best-practices", "seo"] as const;

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(title: string, value: unknown): CallToolResult {
  return textResult(`${title}\n\n${JSON.stringify(value, null, 2)}`);
}

function summarizeReport(lhr: Result) {
  const categories: Record<string, { score: number | null; title: string }> = {};
  for (const [id, cat] of Object.entries(lhr.categories)) {
    categories[id] = {
      score: cat.score === null ? null : Math.round(cat.score * 1000) / 10,
      title: cat.title,
    };
  }

  const failedOrPartial: Array<{
    id: string;
    title: string;
    score: number | null;
    displayValue?: string;
  }> = [];

  for (const [id, audit] of Object.entries(lhr.audits)) {
    if (audit.scoreDisplayMode === "notApplicable") continue;
    if (audit.scoreDisplayMode === "manual") continue;
    if (audit.scoreDisplayMode === "informative") continue;
    if (audit.score === null) continue;
    if (audit.score < 1) {
      failedOrPartial.push({
        id,
        title: audit.title,
        score: audit.score,
        displayValue: audit.displayValue,
      });
    }
  }

  failedOrPartial.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  return {
    lighthouseVersion: lhr.lighthouseVersion,
    requestedUrl: lhr.requestedUrl,
    finalUrl: lhr.finalUrl,
    fetchTime: lhr.fetchTime,
    userAgent: lhr.userAgent,
    environment: lhr.environment,
    categories,
    runtimeError: lhr.runtimeError,
    runWarnings: lhr.runWarnings?.length ? lhr.runWarnings : undefined,
    auditsNeedingAttention: failedOrPartial.slice(0, 35),
  };
}

const server = new McpServer({
  name: "lighthouse-mcp",
  version: "1.0.0",
});

server.registerTool(
  "run_lighthouse",
  {
    title: "Run Lighthouse audit",
    description:
      "Run Google Lighthouse against a URL (local or public). Launches headless Chrome, audits the page, and returns scores plus failing audits. Uses the same engine as https://github.com/GoogleChrome/lighthouse",
    inputSchema: {
      url: z
        .string()
        .min(1)
        .describe('Full URL to audit (e.g. "https://example.com" or "http://localhost:3000").'),
      form_factor: z
        .enum(["mobile", "desktop"])
        .default("mobile")
        .describe("Device emulation: mobile (default) or desktop preset."),
      categories: z
        .array(z.enum(CATEGORY_IDS))
        .optional()
        .describe(
          "Subset of categories to run. Omit for all default categories (performance, accessibility, best-practices, seo).",
        ),
      output_mode: z
        .enum(["summary", "full"])
        .default("summary")
        .describe(
          "summary: category scores and top failing audits. full: complete Lighthouse JSON report (large).",
        ),
      max_wait_for_load_ms: z
        .number()
        .int()
        .min(5000)
        .max(240_000)
        .optional()
        .describe("Max time to wait for page load (ms). Default uses Lighthouse defaults."),
      extra_headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("HTTP headers to send with the navigation (e.g. Authorization)."),
      save_report_path: z
        .string()
        .optional()
        .describe(
          "If set, writes the full JSON report to this absolute or workspace-relative path (parent dirs created).",
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    url,
    form_factor,
    categories,
    output_mode,
    max_wait_for_load_ms,
    extra_headers,
    save_report_path,
  }) => {
    const flags: Parameters<typeof lighthouse>[1] = {
      logLevel: "silent",
      output: "json",
      ...(categories?.length ? { onlyCategories: [...categories] } : {}),
      ...(max_wait_for_load_ms !== undefined ? { maxWaitForLoad: max_wait_for_load_ms } : {}),
      ...(extra_headers && Object.keys(extra_headers).length > 0 ? { extraHeaders: extra_headers } : {}),
      ...(form_factor === "mobile" ? { formFactor: "mobile" as const } : {}),
    };

    const config = form_factor === "desktop" ? desktopConfig : undefined;

    let chrome: chromeLauncher.LaunchedChrome | undefined;
    try {
      chrome = await chromeLauncher.launch({
        chromePath: process.env.CHROME_PATH,
        logLevel: "silent",
        chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"],
      });

      flags.port = chrome.port;

      const runnerResult = await lighthouse(url, flags, config);
      await chrome.kill();
      chrome = undefined;

      if (!runnerResult?.lhr) {
        return textResult("Lighthouse finished without a report. The run may have been cancelled or failed.");
      }

      const { lhr } = runnerResult;

      if (save_report_path) {
        const outPath = isAbsolute(save_report_path)
          ? save_report_path
          : resolve(process.cwd(), save_report_path);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, JSON.stringify(lhr, null, 2), "utf8");
      }

      if (output_mode === "full") {
        return jsonResult("Lighthouse full report (JSON).", lhr);
      }

      return jsonResult("Lighthouse summary.", summarizeReport(lhr));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`Lighthouse failed: ${message}`);
    } finally {
      if (chrome) {
        try {
          await chrome.kill();
        } catch {
          /* ignore */
        }
      }
    }
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
