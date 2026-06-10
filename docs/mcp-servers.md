# Connecting external tools (MCP servers)

Out of the box, Kady can read and write files, run code, and delegate to [sub-agents](./sub-agents.md). **MCP servers** let you give it more abilities - searching the web, querying a database, reading your reference manager, controlling lab software, and so on.

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) is an open standard for connecting AI assistants to external tools. Many services publish an MCP server, and there are hundreds of community-built ones. When you connect one, every tool it provides shows up in Kady's toolbox automatically.

## Adding a server

Open **Settings (gear icon) → MCP servers** and click *Add server*. There are two kinds:

### Remote (HTTP)

A server hosted somewhere on the internet. You need its URL and, usually, an access token from your account on that service.

- **Name**: anything you like, e.g. `linear`
- **Server URL**: e.g. `https://mcp.example.com/mcp`
- **Bearer token**: the access token, if the service requires one

### Local (command)

A small program that runs on your own computer when needed. These are typically published as npm packages and need no hosting.

- **Command**: usually `npx`
- **Arguments**: e.g. `-y @modelcontextprotocol/server-github`
- **Environment variables**: any keys the server needs, one per line, e.g. `GITHUB_TOKEN=ghp_…`

Click **Test connection** before saving - it dials the server and lists the tools it offers, so you catch a typo'd URL or token immediately.

## Using the tools

Nothing special required. Once a server is saved, its tools are available to Kady in **new chat tabs** in that project. Ask naturally - "search our GitHub issues for failed CI runs" - and Kady picks the right tool.

## Good to know

- **Per project.** Each project has its own server list, stored in the project at `sandbox/.pi/mcp.json`. Tokens stay on your machine.
- **A broken server never blocks you.** If a server is down or misconfigured, Kady starts without it (you'll see a warning in the backend logs) and everything else works normally.
- **Changes apply to new chat tabs.** Already-open tabs keep the toolset they started with.
- **Sub-agents don't see MCP tools yet.** Tools from MCP servers are currently available to Kady itself but not to the sub-agents it spawns. This is on the roadmap.
- **Trust matters.** A local (command) server is a program running on your computer with your permissions, and a remote server receives whatever Kady sends it. Only connect servers you trust.
