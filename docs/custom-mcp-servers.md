# Custom MCP Servers

K-Dense BYOK comes with built-in [MCP](https://modelcontextprotocol.io/) servers: Docling for document conversion, and two optional web-search providers — Exa and Parallel — each enabled by supplying the corresponding API key in `.env` (get an Exa key at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)). You can add your own MCP servers to give Kady's expert agents more tools - for example, connecting to internal databases, custom APIs, or specialised scientific tooling.

## Adding a server through the UI

1. Click the **gear icon** in the top-right corner of the app to open Settings.
2. Open the **MCP Servers** tab.
3. Enter a JSON object where each key is a server name and the value is its configuration.

## Example configuration

```json
{
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"]
  },
  "remote-api": {
    "httpUrl": "https://mcp.example.com/api",
    "headers": { "Authorization": "Bearer your-token" }
  }
}
```

Two transport types are supported:

- **stdio** - a local command, configured with `command` and `args`.
- **HTTP** - a remote MCP server, configured with `httpUrl` and optional `headers`.

## How it's stored

- Your custom servers are **merged** with the built-in defaults (Docling, plus Exa and/or Parallel when their API keys are set) and passed to the Gemini CLI.
- The configuration is saved **per project** in `projects/<project-id>/custom_mcps.json` (outside the `sandbox/` folder) so it survives sandbox deletion and app restarts.
- Switching projects automatically swaps the MCP set - each project has its own.
