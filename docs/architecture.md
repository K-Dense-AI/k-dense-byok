# Architecture

This page explains how K-Dense BYOK runs on your computer. You do not need to read this to use the app - it is here if you are curious or troubleshooting.

## The two services

The launcher (`kady` on macOS/Linux, `kady.cmd` on Windows; `start.sh` / `start.cmd` remain compatibility aliases around the same cross-platform `start.mjs`) launches two local services that work together:

| Service | Port | What it does |
|---------|------|--------------|
| **Frontend** (Next.js) | 3000 | The web interface in your browser - chat, file browser, and file previews |
| **Backend** (TypeScript + Pi SDK) | 8000 | The "brain" - runs Kady (a single Pi agent), manages your sandbox, files, sessions, and cost ledger |

The backend embeds the [Pi coding-agent SDK](https://pi.dev) and runs **one flat agent** with built-in file/shell tools, a `subagent` delegation tool (the [pi-subagents](https://github.com/nicobailon/pi-subagents) extension — see [Sub-agents](./sub-agents.md)), web search and fetch tools (pi-web-access), an `interview` tool for clarifying questions, the `notebook` tool behind the [Living Lab Notebook](./lab-notebook.md), PDF annotation tools, the durable [Modal compute](./modal-compute.md) tools, and any external tools you've connected via [MCP servers](./mcp-servers.md). Model calls go directly to **OpenRouter**, **NVIDIA NIM**, **Ollama** or another local OpenAI-compatible server, or a connected Pi OAuth provider (**OpenAI Codex, Anthropic, GitHub Copilot, or xAI**) — there is no separate proxy.

When you send a message:

1. The frontend POSTs to the backend, tagged with the project id (`X-Project-Id`) and the chat tab's session id.
2. The backend runs the Pi agent for that session; the agent uses its tools and may delegate to sub-agents (each sub-agent is a native Pi session inside a detached runner process that pi-subagents starts, working in the same sandbox, with usage ledgered under the parent session).
3. Model calls go straight to the selected OpenRouter, NVIDIA NIM, Ollama, or authenticated Pi provider.
4. A backend run broker sequences and buffers events (text, tool calls, cost)
   and streams them to the browser over SSE. The broker, rather than an
   individual browser connection, owns the live turn.
5. Alongside the stream, a provenance recorder watches the same events and
   appends one observed step per tool call (files read and written, with
   hashes) — see [Provenance](./provenance.md).

Heavy remote commands follow a separate durable path. The lead agent or a
sub-agent submits a project-scoped Modal job to the backend job manager. The
manager reserves budget, persists the job under `.kady/modal/`, owns the remote
sandbox, streams bounded logs, and atomically brings declared outputs back into
the local sandbox. Because the sandbox id and lifecycle are persisted, the
manager can reconnect after a backend restart. See
[Durable Modal compute](./modal-compute.md).

## Chat tabs and sessions

Every chat tab in the UI is backed by its own backend **session**. A session
is a single conversation: an id, an ordered list of messages, and a cost
ledger. You can open up to 10 tabs in a project. The browser persists the tab
layout and recoverable workspace state locally, while each tab's conversation
is persisted on disk under that project.

What a tab owns (per-tab):

- Message history (a Pi JSONL session file under `projects/<project>/sandbox/.pi/sessions/`).
- The selected model.
- Attached files for the next message and the queued-message buffer.
- Cost ledger (`projects/<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`).
- The live run subscription. Refreshing or closing the browser only detaches
  that subscriber; reopening replays buffered frames and resumes the same
  turn. Clicking Stop (or closing the chat tab inside Kady) explicitly aborts
  that session's turn.

What every tab in a project shares:

- The sandbox (`projects/<project>/sandbox/`) — files written by one tab are
  immediately visible to the others.
- Project settings: the budget cap (`spendLimitUsd`) and the project-level
  cost total shown in the header pill.
- API keys and global preferences from the repo-root `.env`, plus the process-wide Kady Pi OAuth store shared by lead and child agents.
- The Living Lab Notebook (project view), provenance log, and Modal job list — all read across every tab's session.

### System-initiated runs

Not every turn starts with a message you typed. The pi-subagents extension
loaded into each session can inject a message on its own — a background
specialist asking for a decision through `contact_supervisor`, a scheduled
run's completion notice, a watchdog finding — and Pi then runs a turn on the
idle session. A per-session observer (`server/src/agent/session-observer.ts`)
adopts such a turn as a **system run**: it claims the session exactly like
`POST /sessions/:id/run` does, opens a run in the broker with `origin:
"system"`, and hands it to the same pipeline (`server/src/agent/run-pipeline.ts`),
so it is streamed, provenance-recorded, cost-ledgered and abortable like any
other run. Over the project cap the run is aborted (and its partial spend
ledgered) instead of continuing unattended. A custom message appended without
a turn is published as a short `kind: "notice"` run. Idle chat tabs probe
`GET /sessions/:id/run/state?frames=0` every few seconds and attach when a run
they did not start appears; those messages render as cards between the
bubbles (and as `role: "system"` items in `GET /sessions/:id/history`).

Two details keep system runs affordable and possible at all. Pi emits
`session_start` only from `AgentSession.bindExtensions()`, so Kady calls it
(headless `mode: "print"`) right after creating every session; without it
pi-subagents never starts its supervisor channel, never registers the
parent-side `subagent_supervisor` tool, and never resets per-session state.
And a session that is cold-opened after a restart starts on the model it last
ran with (a brand-new one on the model most recently used in a chat of the
project) rather than the global default — user runs set the model per request
anyway, but a system run uses whatever the session holds. A send that lands
while a system run is streaming is not rejected: the tab adopts the live run
and queues the message as a follow-up.

Switching tabs in the UI is purely client-side; the backend doesn't need to
know which tab is "active" because each request already carries its own
session id. Inactive tabs stay mounted in the DOM (hidden with CSS) so a
streaming turn keeps producing output even when you're looking at another
tab. Browser refreshes remount the saved workspaces and reattach each active
session through the run broker. This recovery boundary is process-local:
restarting the backend ends active turns, while completed JSONL history and
cost ledgers remain durable.

## First-run setup

The first time you start the app (`./kady` or `kady.cmd`), it will automatically:

- Install backend dependencies (`server/`) and frontend dependencies (`web/`)
- Install [uv](https://docs.astral.sh/uv/) if missing - the Python manager Kady uses to run analyses in each sandbox
- Create your `.env` from `.env.example` if you haven't yet, and warn if no OpenRouter key, NVIDIA key, stored subscription login, or local Ollama is immediately detectable (the UI still opens for provider setup)
- Download the scientific skills catalogue into each project's `sandbox/.pi/skills/`

Subsequent starts are much faster.

## Project layout

```
k-dense-byok/
├── start.mjs             ← The launcher that starts everything (cross-platform)
├── kady / kady.cmd      ← Memorable macOS-Linux / Windows entry points
├── start.sh / start.cmd ← Compatibility wrappers around the same launcher
├── .env                  ← Optional API keys and overrides (gitignored)
├── server/               ← Backend (TypeScript, Pi SDK)
│   └── src/
│       ├── index.ts          ← Fastify app, CORS, project-scope hook
│       ├── projects.ts       ← Project registry + path resolution
│       ├── agent/            ← Pi wiring: models, sessions, tools, events, skills, notebook
│       ├── modal/            ← Durable Modal jobs, storage, resources, transfers
│       ├── provenance/       ← Observed step recorder, sandbox scanner, lineage lookup
│       ├── evidence/         ← Reviewer evidence packages
│       ├── latex/            ← LaTeX compile, SyncTeX, AI assist
│       ├── helpers/          ← Python helpers (uv venv) for scientific file previews
│       ├── api/              ← Routes: projects, sessions (SSE), sandbox, notebook, skills, system
│       └── cost/             ← Billing policy, ledger, and budget caps
├── web/                  ← Frontend (the UI you see in your browser)
├── docs/                 ← Extended documentation (this folder)
└── projects/             ← All user work, one subdirectory per named project
    ├── index.json        ← Project registry (names, tags, archived flag)
    └── default/          ← The "Default" project
        ├── project.json      ← Project metadata
        └── sandbox/          ← Workspace (the Pi agent's cwd)
            ├── .pi/skills/        ← Per-project scientific skills (disabled ones sit in .pi/skills-disabled/)
            ├── .pi/agents/        ← Sub-agent definitions (one .md per specialist; disabled ones in .pi/agents-disabled/)
            ├── .pi/mcp.json       ← MCP server connections for this project
            ├── .pi/sessions/      ← Pi JSONL session files (one per chat tab)
            ├── .kady/runs/<sessionId>/costs.jsonl        ← Per-session cost ledger
            ├── .kady/notebook/<sessionId>.jsonl          ← Living Lab Notebook entries (+ annotation sidecars, plans)
            ├── .kady/provenance/<sessionId>/steps.jsonl  ← Observed step provenance
            ├── .kady/environments/<id>.json              ← Content-addressed environment snapshots
            ├── .kady/evidence/                           ← Reviewer evidence packages and version vault
            └── .kady/modal/jobs/<jobId>/                 ← Durable compute state + logs
```

The OAuth store intentionally sits outside this tree at `~/.kady/pi-agent/auth.json` by default, so tokens are not copied into projects or session files.

## Provider authentication

**Settings → Model providers** drives Pi's OAuth implementations through backend flow endpoints. Depending on the provider, the dialog presents a browser link, device code, or manual prompt. Connected models are read from Pi's live provider registry. Providers that also take an API key (Anthropic, xAI, Kimi) accept either credential; OpenAI Codex, GitHub Copilot, and Radius are OAuth-only.

The backend creates one process-wide Pi `ModelRuntime` with its auth path set to Kady's store. `server/src/env.ts` defaults `PI_CODING_AGENT_DIR` to `~/.kady/pi-agent`, or to `KADY_PI_AGENT_DIR` when that override is set. An explicitly supplied `PI_CODING_AGENT_DIR` takes precedence and can intentionally point Kady at the same directory as a standalone Pi installation. The subagent runner process inherits it, so lead agents and subagents use the same file-locked `auth.json`.

## Model selection and routing

Each chat tab picks one model. Model refs from the picker look like
`openrouter/<vendor>/<model>`, `ollama/<name>`, `openai-compatible/<id>`, or
`<pi-provider>/<model-id>` for every other built-in Pi provider — `nvidia/…`,
`anthropic/…`, `openai/…`, `groq/…`, `amazon-bedrock/…`, `cloudflare-workers-ai/@cf/…`,
and so on; the id after the prefix is kept verbatim because many contain slashes.
These canonical `provider/model` refs are also used by ledgers and subagents.
The backend resolves them to Pi `Model` objects (`server/src/agent/models.ts`):
OpenRouter uses `OPENROUTER_API_KEY` (or an OpenRouter sign-in), Ollama points at
`OLLAMA_BASE_URL`, and every other provider uses the credential Pi resolves for it —
an API key or cloud configuration from `server/src/agent/provider-catalog.ts`
(managed in Settings → API keys), or an OAuth login from `provider-auth.ts`.
There is no proxy — Pi calls the provider directly. OpenRouter
Fusion and the server-side speech transcription fallback remain OpenRouter-only.
See
[Local models with Ollama](./local-models-ollama.md) and
[Model selection](./model-selection.md).

## Usage accounting and budgets

Pi supplies token usage and a model-price-derived USD value for lead and child runs. The central billing policy records OpenRouter and Anthropic OAuth (`metered_oauth`) values as spend. OpenAI Codex, GitHub Copilot, and xAI OAuth runs instead record tokens and a list-price reference with `costUsd: 0`, so they do not consume the Kady project cap; their real quotas and overages remain provider-managed. NVIDIA NIM and the prepaid Qwen/Xiaomi token plans are classified the same way — they bill provider-managed credits or a plan quota rather than per-token USD, so tokens are recorded without cap-counted spend. Every other direct API-key provider (Anthropic, OpenAI, Google, Azure, Bedrock, Groq, …) is `payg` at Pi's list price and counts toward the cap; an OpenRouter or Radius OAuth sign-in bills like a key. Ollama and OpenAI-compatible local servers are `local` at $0, while Modal compute reserves and then settles its estimated cost. This accounting avoids calling subscription usage free while keeping the project cap limited to charges Kady can meter.
