# Connecting external tools (MCP servers)

Out of the box, Kady can read and write files, run code, search the web, and delegate to [sub-agents](./sub-agents.md). **MCP servers** let you give it more abilities - querying a database, reading your reference manager, controlling lab software, and so on.

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) is an open standard for connecting AI assistants to external tools. Many services publish an MCP server, and there are hundreds of community-built ones. Kady connects them through the MCP support built into its agent engine, [Pi](https://pi.dev/docs/latest/mcp), so the configuration format is the same one Claude Desktop, Claude Code, and Cursor use.

## Adding a server

Open **Settings (gear icon) → Connectors** and click *Add server*. First pick where it lives:

- **This project** - only this project's chats use it. Stored in the project at `sandbox/.pi/mcp.json`.
- **All projects** - every project uses it. Stored in `~/.kady/pi-agent/mcp.json`. Pi recommends this for personal servers and servers that need your credentials. If a project has a server with the same name, the project one wins there.

There are two kinds of server:

### Remote (HTTP)

A server hosted somewhere on the internet.

- **Name**: anything you like (letters, digits, `-` and `_`), e.g. `linear`
- **Server URL**: e.g. `https://mcp.example.com/mcp`. Servers that only offer the older SSE transport are not supported; most also serve the current transport, often at `/mcp` instead of `/sse`.
- **Bearer token**: the access token, if the service uses one. Leave it empty for services that sign in through the browser (see [Signing in](#signing-in-oauth)).

#### Example: Parallel Search

To add optional web search and URL fetching through Parallel Search MCP, use:

- **Name**: `parallel-search`
- **Server URL**: `https://search.parallel.ai/mcp`
- **Bearer token**: leave blank

The default endpoint requires no account or API key. After you test and save it, its `web_search` and `web_fetch` tools are available in new chat tabs.

### Local (command)

A small program that runs on your own computer when needed. These are typically published as npm or Python packages and need no hosting.

- **Command**: usually `npx` or `uvx`
- **Arguments**: e.g. `-y @modelcontextprotocol/server-github`
- **Environment variables**: any keys the server needs, one per line, e.g. `GITHUB_TOKEN=ghp_…`

Values can refer to environment variables instead of holding the secret itself: `GITHUB_TOKEN=${GITHUB_TOKEN}` reads it from Kady's environment (for example your `.env` file). The same works in a bearer token.

Click **Test connection** before saving - it dials the server and lists the tools it offers, so you catch a typo'd URL or token immediately.

## How Kady reaches the tools

Each server has an **exposure** setting (the dropdown next to it):

| Exposure | What it means |
|---|---|
| **Codemode** (default) | Kady calls the tools from short scripts it writes, several at once if useful, and only the part of each result it needs reaches its context. Large servers don't crowd the agent's tool list. |
| **Codemode (searched)** | Like codemode, but the tools are not even listed; scripts search for them. For big servers you rarely need. |
| **On demand** | Hidden until Kady looks them up with its tool search, then called directly. |
| **Direct** | Listed alongside Kady's built-in tools and called directly. Best for small servers, and for smaller or local models that struggle with scripts. |
| **Hidden** | Connected, but no tool can be called. |

If a model has trouble using a server's tools, switch that server to **Direct**.

## Signing in (OAuth)

Some remote servers (Sentry, Linear, and others) sign you in through your browser instead of a token. Add the server with no bearer token, save it, then click **Check status**: the server shows **Needs sign-in**. Click **Sign in**, approve access in the browser window that opens (a link is shown too), and you're done. The sign-in is stored in `~/.kady/pi-agent/mcp-auth.json`, shared by all projects, and refreshed automatically. Chats that are already open pick it up on their next turn. **Sign out** deletes the stored sign-in.

## Checking servers

**Check status** connects every server the current project's chats would see and shows whether it is connected (and how many tools it has), needs sign-in, or failed, with the error. Starting local servers can take a few seconds.

## Using the tools

Nothing special required. Once a server is saved, its tools are available to Kady in **new chat tabs**. Ask naturally - "search our GitHub issues for failed CI runs" - and Kady picks the right tool. Tool calls, including the ones Kady makes from a codemode script, appear in the chat and are checked by the [raw-data guard](./data-guard.md) like any other tool.

## Good to know

- **Disabling is non-destructive.** Toggling a server off keeps its entry (marked `"enabled": false`); toggle it back on when you need it again.
- **A broken server never blocks you.** If a server is down or misconfigured, Kady starts without it and everything else works normally; **Check status** shows what went wrong.
- **Changes apply to new chat tabs.** Already-open tabs keep the servers they started with (a completed sign-in is the exception, see above).
- **Each open chat tab has its own connections.** A local server runs once per open tab that uses it, and stops when the tab closes.
- **Sub-agents don't see MCP tools yet.** Tools from MCP servers are currently available to Kady itself but not to the sub-agents it spawns. This is on the roadmap.
- **Editing the files directly works too.** Both files use the standard `mcpServers` format, with Pi's extra options (`exposure`, per-tool `toolExposure`, `timeout`, `cwd`, `oauth`) described in [Pi's MCP documentation](https://pi.dev/docs/latest/mcp). Kady keeps options it doesn't show when you edit a server in Settings.
- **Trust matters.** A local (command) server is a program running on your computer with your permissions, and a remote server receives whatever Kady sends it. Only connect servers you trust.

## Specialist access

New specialist runs connect to the same project and global MCP configuration
through the required child runtime. The parent's tool ceiling and the
specialist's explicit tool allowlist both apply. Scientific specialists inherit
tools by default; a restricted builtin may need individual `mcp__…` tool names,
`codemode` or `tool_search` added to its allowlist. Each child owns its MCP
connections and closes them with its session.
