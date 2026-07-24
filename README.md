# Higgsfield MCP

MCP server for generating images and image-to-video clips with the Higgsfield API from any MCP-compatible client.

The server calls Higgsfield directly for generation and cancellation. It does not request separate MCP elicitation approval before spending API credits.

## Tools

- `generate_higgsfield_image`: submits a Higgsfield image generation request and optionally polls for final image URLs.
- `generate_higgsfield_image_to_video`: submits a Higgsfield image-to-video request and optionally polls for final video URLs.
- `generate_higgsfield_first_last_frame_video`: submits a first-frame/last-frame image-to-video request with required start and ending image URLs.
- `get_higgsfield_request_status`: checks an existing Higgsfield request.
- `cancel_higgsfield_request`: cancels a queued Higgsfield request.

## Setup

```bash
npm install
npm run build
```

Set these environment variables in your MCP client config:

```bash
HF_API_KEY=your_api_key
HF_API_SECRET=your_api_key_secret
HF_API_BASE_URL=https://platform.higgsfield.ai
HF_IMAGE_MODEL=higgsfield-ai/soul/standard
HF_VIDEO_MODEL=dop-standard
HF_FIRST_LAST_VIDEO_MODEL=dop-standard
HF_POLL_MS=3000
HF_TIMEOUT_MS=180000
```

The server also loads a local `.env` file if present. `.env` is gitignored.

## Cursor MCP Config

For access from every project, add this server to your global Cursor MCP config:

```json
{
  "mcpServers": {
    "higgsfield": {
      "command": "node",
      "args": ["/Users/samwudel/Higgsfield mcp/dist/index.js"]
    }
  }
}
```

Keep real credentials out of project repos. This server loads `/Users/samwudel/Higgsfield mcp/.env` when Cursor starts it.

## Higgsfield Defaults

By default, image generation uses:

- Model: `higgsfield-ai/soul/standard`
- Aspect ratio: `16:9`
- Resolution: `720p`
- Poll interval: `3000ms`
- Timeout: `180000ms`

You can override `model_id`, `aspect_ratio`, `resolution`, and pass model-specific `extra_params` per request.

By default, image-to-video generation uses:

- Endpoint: `/v1/image2video/dop`
- Model: `dop-standard`
- Source images payload key: `input_images`
- Optional final frame: pass `end_image_url`, which is sent as a second `input_images` entry

You can override `model_id`, `duration`, `end_image_url`, and pass model-specific `extra_params` per request. Official Higgsfield SDK DoP model values are `dop-lite`, `dop-turbo`, and `dop-standard`. Official Higgsfield docs also mention direct model paths such as `higgsfield-ai/dop/standard`, `higgsfield-ai/dop/preview`, `bytedance/seedance/v1/pro/image-to-video`, and `kling-video/v2.1/pro/image-to-video`.

For first/last-frame generation, use `generate_higgsfield_first_last_frame_video` with required `start_image_url` and `end_image_url`. It defaults to `dop-standard` for best DoP quality, while `dop-turbo` is a good per-request override for faster iteration.
