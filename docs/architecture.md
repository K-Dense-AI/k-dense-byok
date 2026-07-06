# Architecture

This page explains how K-Dense BYOK runs on your computer. You do not need to read this to use the app - it is here if you are curious or troubleshooting.

![K-Dense BYOK Architecture](k-dense-byok-architecture.png)

## The two services

The start script (`start.sh` on macOS/Linux, `start.cmd` on Windows — both thin wrappers around the cross-platform `start.mjs` launcher) launches two local services that work together:

| Service | Port | What it does |
|---------|------|--------------|
| **Frontend** (Next.js) | 3000 | The web interface in your browser - chat, file browser, and file previews |
| **Backend** (TypeScript + Pi SDK) | 8000 | The "brain" - runs Kady (a single Pi agent), manages your sandbox, files, sessions, and cost ledger |

The backend embeds the [Pi coding-agent SDK](https://pi.dev) and runs **one flat agent** with built-in file/shell tools plus a `subagent` delegation tool (the [pi-subagents](https://github.com/nicobailon/pi-subagents) extension — see [Sub-agents](./sub-agents.md)) and any external tools you've connected via [MCP servers](./mcp-servers.md). Model calls go directly to **OpenRouter** (built-in Pi provider) or **Ollama** (local) — there is no separate proxy.

When you send a message:

1. The frontend POSTs to the backend, tagged with the project id (`X-Project-Id`) and the chat tab's session id.
2. The backend runs the Pi agent for that session; the agent uses its tools and may delegate to sub-agents (each sub-agent runs as its own short-lived `pi` process in the same sandbox, with its spend counted toward the project budget).
3. Model calls go straight to OpenRouter or Ollama.
4. Events (text, tool calls, cost) stream back to your browser over SSE in real time.

## Chat tabs and sessions

Every chat tab in the UI is backed by its own backend **session**. A session
is a single conversation: an id, an ordered list of messages, and a cost
ledger. You can open up to 10 tabs in a project; the list of tabs lives only
in the browser, but each tab's session is persistent on disk under that
project.

What a tab owns (per-tab):

- Message history (a Pi JSONL session file under `projects/<project>/sandbox/.pi/sessions/`).
- The selected model.
- Attached files for the next message and the queued-message buffer.
- Cost ledger (`projects/<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`).
- The streaming connection — closing a tab aborts the in-flight turn for
  that session only.

What every tab in a project shares:

- The sandbox (`projects/<project>/sandbox/`) — files written by one tab are
  immediately visible to the others.
- Project settings: the budget cap (`spendLimitUsd`) and the project-level
  cost total shown in the header pill.
- API keys and global preferences from the repo-root `.env`.

Switching tabs in the UI is purely client-side; the backend doesn't need to
know which tab is "active" because each request already carries its own
session id. Inactive tabs stay mounted in the DOM (hidden with CSS) so a
streaming turn keeps producing output even when you're looking at another
tab.

## First-run setup

The first time you start the app (`./start.sh` or `start.cmd`), it will automatically:

- Install backend dependencies (`server/`) and frontend dependencies (`web/`)
- Install [uv](https://docs.astral.sh/uv/) if missing - the Python manager Kady uses to run analyses in each sandbox
- Create your `.env` from `.env.example` if you haven't yet, and warn if no API key (or local Ollama) is configured
- Download the scientific skills catalogue into each project's `sandbox/.pi/skills/`

Subsequent starts are much faster.

## Project layout

```
k-dense-byok/
├── start.mjs             ← The launcher that starts everything (cross-platform)
├── start.sh / start.cmd  ← Thin macOS-Linux / Windows wrappers around it
├── .env                  ← Your API keys (copy from .env.example; gitignored)
├── server/               ← Backend (TypeScript, Pi SDK)
│   └── src/
│       ├── index.ts          ← Fastify app, CORS, project-scope hook
│       ├── projects.ts       ← Project registry + path resolution
│       ├── agent/            ← Pi wiring: models, sessions, tools, events, skills
│       ├── api/              ← Routes: projects, sessions (SSE), sandbox, system
│       └── cost/ledger.ts    ← Cost ledger + budget caps
├── web/                  ← Frontend (the UI you see in your browser)
├── docs/                 ← Extended documentation (this folder)
└── projects/             ← All user work, one subdirectory per named project
    ├── index.json        ← Project registry (names, tags, archived flag)
    └── default/          ← The "Default" project
        ├── project.json      ← Project metadata
        └── sandbox/          ← Workspace (the Pi agent's cwd)
            ├── .pi/skills/        ← Per-project scientific skills
            ├── .pi/agents/        ← Sub-agent definitions (one .md per specialist)
            ├── .pi/mcp.json       ← MCP server connections for this project
            ├── .pi/sessions/      ← Pi JSONL session files (one per chat tab)
            └── .kady/runs/<sessionId>/costs.jsonl  ← Per-session cost ledger
```

## Model selection and routing

Each chat tab picks one model. Model refs from the picker look like
`openrouter/<vendor>/<model>` or `ollama/<name>`. The backend resolves these to
Pi `Model` objects (`server/src/agent/models.ts`): OpenRouter is a built-in Pi
provider (key from `OPENROUTER_API_KEY`), and Ollama points at your local daemon
(`OLLAMA_BASE_URL`). There is no proxy — Pi calls the provider directly. See
[Local models with Ollama](./local-models-ollama.md) and
[Model selection](./model-selection.md).
