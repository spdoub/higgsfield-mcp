# Lighthouse MCP

MCP server that runs [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) against any URL you choose (production, staging, or `http://localhost:...`). It spawns headless Chrome, runs the audit, and returns JSON you can use in Cursor.

## Requirements

- **Node.js ≥ 22.19** (required by Lighthouse 13)
- **Google Chrome** installed, or set `CHROME_PATH` to your Chromium/Chrome binary

## Tool

- **`run_lighthouse`**: audit a URL  
  - `url` (required)  
  - `form_factor`: `mobile` (default) or `desktop`  
  - `categories`: optional subset of `performance`, `accessibility`, `best-practices`, `seo`  
  - `output_mode`: `summary` (default) or `full` (entire LHR JSON; can be large)  
  - `max_wait_for_load_ms`, `extra_headers`, `save_report_path` optional  

Logging is forced to **silent** so Lighthouse does not break MCP stdio.

## Setup

```bash
cd lighthouse-mcp
npm install
npm run build
```

## Cursor MCP config

Use the compiled `dist/index.js` in your global or project MCP settings (same pattern as your Higgsfield MCP):

```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "node",
      "args": ["/Users/samwudel/Higgsfield mcp/lighthouse-mcp/dist/index.js"]
    }
  }
}
```

If Chrome is not on the default path:

```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "node",
      "args": ["/Users/samwudel/Higgsfield mcp/lighthouse-mcp/dist/index.js"],
      "env": {
        "CHROME_PATH": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      }
    }
  }
}
```

After editing MCP config, reload MCP / restart Cursor as you normally do.

## Privacy / safety

The tool loads real URLs in a real browser from your machine. Only audit URLs you trust. Optional `save_report_path` writes the full JSON to disk under your chosen path.
