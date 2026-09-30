# MCP connectors

MCP servers add external tools such as databases, reference managers and lab
software. Kady uses Pi's MCP support in both lead and specialist sessions.

## Add a connector

Open **Settings → Connectors → Add server**, then choose **This project** or
**All projects**. Project configuration lives in `sandbox/.pi/mcp.json`; global
configuration defaults to `~/.kady/pi-agent/mcp.json`. A same-named project entry
wins over the global entry.

| Connection | Fields |
|---|---|
| Remote HTTP | Name, server URL and optional bearer token. SSE-only servers are unsupported. |
| Local command | Executable, arguments and environment variables. Each session starts its own process. |

Environment/token values can reference the host environment with `${VAR}`.
Use **Test connection** before saving and **Check status** to inspect tools and
errors. Configuration changes apply to **new chat tabs**. Disable keeps the
entry; removal deletes it.

For OAuth, save the remote server without a token, check status and choose
**Sign in** when required. Tokens are stored in the shared Pi directory's
`mcp-auth.json`; existing sessions pick up a completed login on their next turn.
**Sign out** removes the stored login.

## Tool exposure

| Setting | How tools are called |
|---|---|
| Codemode (default) | Short scripts can combine tool calls and return selected results. |
| Codemode (searched) | Scripts discover tools by search. |
| On demand | Tool search exposes tools for direct calls. |
| Direct | Tools are listed alongside built-ins. |
| Hidden | Connected, but tools cannot be called. |

Use Direct when the selected model struggles with codemode. Nested calls appear
in chat and pass through tool hooks such as the raw-data guard and provenance.
Those hooks do not inspect every external tool's internal effects.

## Specialist access and trust

Specialists connect through the required child runtime. The parent's capability
ceiling and the specialist's own allowlist both apply. Restricted specialists
may need `mcp__…` tool names, `codemode` or `tool_search` explicitly allowed.
Each lead/child session owns and closes its connections; a local server can
therefore run once per session.

A failed connector leaves other tools available. Local servers run with the
host user's permissions; remote servers receive the data sent to them. Connector
`env`, headers and OAuth client secrets are currently shown unmasked in Settings.

Direct edits use `mcpServers` in the files above. Kady preserves additional Pi
options when editing supported fields and refuses to rewrite malformed files.
Implementation: [`mcp.ts`](../server/src/agent/mcp.ts) and
[`kady-child-runtime`](../server/pi-packages/kady-child-runtime/).
