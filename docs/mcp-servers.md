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
| Remote HTTP | Name, server URL and authentication (below). SSE-only servers are unsupported. |
| Local command | Executable, arguments and environment variables. Each session starts its own process. |

Both kinds take an optional **Description**: one sentence on what the server
offers. Kady's agent sees it next to the server's name and tool search uses it
to rank the server's tools, so a clear description helps the agent find them.

Environment/token values can reference the host environment with `${VAR}`.
Use **Test connection** before saving and **Check status** to inspect tools and
errors. Configuration changes apply to **new chat tabs**. Disable keeps the
entry; removal deletes it.

Names are letters, digits, `-` and `_`. Tool names replace `-` with `_`
(`lab-tools` becomes `mcp__lab_tools__…`), so two servers whose names differ
only in `-` and `_` are refused.

### Authentication

| Option | Use it for |
|---|---|
| Sign in with OAuth (default) | Servers that sign in through the browser, such as Sentry or Linear. Save, check status and choose **Sign in**. |
| Bearer token | A fixed token sent as `Authorization: Bearer …`. |
| Use a signed-in provider | **All projects** only. Sends a provider login from Settings → Providers (for example Radius) as the bearer token, refreshed on every request. Requires https (or http on localhost). |

OAuth tokens are stored per server in the shared Pi directory's
`mcp-auth.json`; existing sessions pick up a completed login on their next turn.
**Sign out** removes the stored login. Under **Advanced OAuth**, *Client name*
helps with servers that only accept known OAuth clients, and *Authorization
server metadata URL* fixes servers that advertise a wrong authorization server
or none.

Provider logins are never allowed in a project's `mcp.json`, so a project
cannot choose where your credentials are sent.

**Radius.** When you are signed in to Radius, Connectors offers **Add Radius
connector**, which adds `https://radius.pi.dev/mcp` to the connectors for all
projects, authenticated with that sign-in.

**Paperclip.** Saving a Paperclip API key (from
[paperclip.gxl.ai/keys](https://paperclip.gxl.ai/keys)) under **Settings →
Services** gives the agent Paperclip's literature search: papers, preprints,
clinical trials, FDA documents and patents. Kady checks the key with Paperclip,
stores it in `.env`, and adds a `paperclip` connector for all projects that
sends it as `X-API-Key: ${PAPERCLIP_API_KEY}`. Only that reference is written
to `mcp.json`: Pi reads the key from the environment when it connects, so
subagents get it too and a new key needs no connector edit. An existing
connector at `https://paperclip.gxl.ai/mcp` is reused, keeping its settings
but not its old credential. Clearing the key turns the connector off without
deleting it. Without a key, add the same URL here and sign in with OAuth.
Paperclip usage counts against Paperclip's own rate limits, not Kady's spend
cap. New chat tabs pick up the connector.

## Tool exposure

| Setting | How tools are called |
|---|---|
| Codemode (default) | Short scripts find the tools by search, combine calls and return selected results. The server connects in the background and does not delay the first reply. |
| On demand | Tool search exposes tools for direct calls. |
| Direct | Tools are listed alongside built-ins. |
| Hidden | Connected, but tools cannot be called. |

Older configurations may say `codemode-deferred`; Pi treats it as Codemode.
Use Direct when the selected model struggles with codemode. Nested calls appear
in chat and pass through tool hooks such as the raw-data guard and provenance.
Those hooks do not inspect every external tool's internal effects.

## Specialist access and trust

Specialists connect through the required child runtime. The parent's capability
ceiling and the specialist's own allowlist both apply. A restricted specialist
can be granted connector tools with `mcp:<server>` or `mcp:<server>/<tool>` in
its **Tools** list (the child then gets exactly those tools), or with
`mcp__…` tool names, `codemode` or `tool_search`.
Each lead/child session owns and closes its connections; a local server can
therefore run once per session.

A failed connector leaves other tools available. Local servers run with the
host user's permissions; remote servers receive the data sent to them. Connector
`env`, headers and OAuth client secrets are currently shown unmasked in Settings.

Direct edits use `mcpServers` in the files above. Kady preserves additional Pi
options when editing supported fields and refuses to rewrite malformed files.
Implementation: [`mcp.ts`](../server/src/agent/mcp.ts) and
[`kady-child-runtime`](../server/pi-packages/kady-child-runtime/).
