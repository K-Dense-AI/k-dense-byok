# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

K-Dense BYOK is a local AI research-assistant app ("Kady") that brings the user's own API keys. It is one repo with **two** runtime services started together by `./start.sh`:

| Service | Port | Code |
|---|---|---|
| Frontend (Next.js 16 / React 19) | 3000 | `web/` |
| Backend (TypeScript + Pi coding-agent SDK) | 8000 | `server/` |

The backend embeds the **Pi SDK** (`@earendil-works/pi-coding-agent`) and runs a **single flat agent** with built-in tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`), a `subagent` delegation tool (the [pi-subagents](https://github.com/nicobailon/pi-subagents) extension package), and per-project MCP tools (`.pi/mcp.json`). There is no orchestrator/expert split, no Gemini CLI, and no LiteLLM proxy (all removed in the Pi migration). Models go directly to **OpenRouter** (built-in Pi provider) or **Ollama** (local). Everything runs locally; user data lives in `projects/`.

## Commands

Backend (`cd server` first; Node ≥ 22.19 recommended):

```bash
npm install                 # install deps
npm run dev                 # tsx watch on port 8000
npm run start               # run backend (tsx)
npm run prep                # ensure default project + seed scientific skills
npm run typecheck           # tsc --noEmit
npm test                    # vitest
```

Frontend (`cd web` first):

```bash
npm install
npm run dev                 # Next.js dev server (port 3000)
npm run build               # production build
npm run test                # vitest
```

Full app (both services):

```bash
./start.sh                  # installs deps, seeds skills, starts backend + frontend
```

## Architecture: how a turn flows

1. **UI → backend.** A chat tab posts to the TS backend. Each tab carries its own `sessionId` (a Pi JSONL session); requests are scoped to a project via the `X-Project-Id` header (→ `?project` → `kady-project` cookie → `default`), resolved in an `onRequest` hook using `AsyncLocalStorage` (`server/src/scope.ts`).
2. **Sessions.** `server/src/agent/session-registry.ts` holds live Pi `AgentSession` objects (one per tab, ≤10 per project) and persists each as a JSONL file under `projects/<id>/sandbox/.pi/sessions/`. `AuthStorage` + `ModelRegistry` are process singletons (shared OpenRouter key).
3. **Models.** `server/src/agent/models.ts` resolves a model ref (`openrouter/<vendor>/<model>` or `ollama/<name>`) to a Pi `Model`, synthesizing OpenRouter models from `web/src/data/models.json` pricing when not built in.
4. **Streaming.** `POST /sessions/:id/run` calls `session.prompt()` and streams an SSE schema mapped from Pi's `AgentSessionEvent` (`server/src/agent/events.ts`): `text_delta`, `thinking_delta`, `tool_start/update/end`, `turn_start/end`, `error`, a terminal `cost` frame, and `done`.
5. **Cost ledger + budgets.** Pi reports `usage.cost` inline (no async backfill). `server/src/cost/ledger.ts` snapshots `getSessionStats()` before/after each run and appends a row to `projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl` (role `agent`|`subagent`). A project `spendLimitUsd` blocks runs once cumulative spend reaches it.
6. **Skills.** Seeded per-project into `sandbox/.pi/skills/` from `K-Dense-AI/scientific-agent-skills` (`server/src/agent/skills.ts`); Pi's `DefaultResourceLoader` (cwd = sandbox) auto-discovers and the agent activates them. `SKILL.md` frontmatter is unchanged.
7. **Sandbox API.** `server/src/api/sandbox.ts` ports all file ops (tree/read/write/move/upload/zip/raw/download), annotation sidecars, LaTeX compile, and `.h5ad` previews (the last via a small standalone Python helper, `server/src/helpers/anndata_helper.py` — the only Python left).

## Project / sandbox layout

```
projects/
├── index.json                        # registry
└── <projectId>/
    ├── project.json                  # metadata (ProjectMeta)
    └── sandbox/                       # Pi agent cwd; files visible to all tabs
        ├── user_data/                # uploads
        ├── .pi/skills/               # per-project skills (Pi-discovered)
        ├── .pi/sessions/             # Pi JSONL session files (one per tab)
        └── .kady/runs/<sessionId>/costs.jsonl   # cost ledger
```

## Configuration

- API keys come from `process.env`, auto-loaded by `server/src/env.ts` from (in order) repo-root `.env`, the legacy `kady_agent/.env` if present, and `server/.env`. Set `OPENROUTER_API_KEY` (required) and optionally `OLLAMA_BASE_URL`, `DEFAULT_MODEL_ID`, `KADY_PORT`, `KADY_PROJECTS_ROOT`.
- A full credentials Settings UI, MCP servers, Modal compute, provenance/manifests, citation verification, and first-party web search (Exa/Parallel/Paperclip) / document conversion are **deferred** in this migration. Web search etc. will return as native Pi custom tools.

## Testing notes

- Backend tests: `cd server && npm test` (vitest, in `server/test/`). `KADY_PROJECTS_ROOT` is pointed at a temp dir via `vitest.config.ts`.
- Frontend tests: `cd web && npm test` (vitest). `npx tsc --noEmit` currently passes clean for the frontend too.

## Caveats worth knowing

- **One flat agent.** For independent/parallel subtasks the agent calls the `subagent` tool from the **pi-subagents** package, which spawns child `pi` CLI processes in the sandbox (the binary resolves from `server/node_modules/.bin`). Specialist scientific agents are seeded into each project's `sandbox/.pi/agents/*.md` from `server/src/agent/subagents.ts` (write-if-missing; user edits win). Budget gating + cost ledgering for child runs lives in `server/src/agent/subagent-bridge.ts`.
- **OpenRouter cost** is read from Pi's `usage.cost` (computed from `model.cost`). For synthesized OpenRouter models the pricing comes from `web/src/data/models.json`; keep that catalogue current for accurate cost.
- **Node ≥ 22.19** is what Pi targets; lower 22.x usually works but emits an `EBADENGINE` warning.
- **Don't run our source through `tsc` for emit** — both dev and prod run via `tsx`; `tsconfig.json` is `noEmit` for typechecking only.
