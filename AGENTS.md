# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

K-Dense BYOK is a local AI research-assistant app ("Kady") that brings the user's own API keys. It is one repo with **two** runtime services started together by `./start.sh`:

| Service | Port | Code |
|---|---|---|
| Frontend (Next.js 16 / React 19) | 3000 | `web/` |
| Backend (TypeScript + Pi coding-agent SDK) | 8000 | `server/` |

The backend embeds the **Pi SDK** (`@earendil-works/pi-coding-agent`) and runs a **single flat agent** with built-in tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`), a `subagent` delegation tool (the [pi-subagents](https://github.com/nicobailon/pi-subagents) extension package), an `interview` clarifying-questions tool (a native re-implementation of [pi-interview](https://pi.dev/packages/pi-interview) — see `server/src/agent/interview.ts`; the form renders inline in the chat UI instead of the package's own browser window), the [pi-web-access](https://pi.dev/packages/pi-web-access) web tools (`web_search`/`code_search`/`fetch_content`/`get_search_content`), a `modal_run` remote-compute tool (offloads a command/script to an on-demand Modal sandbox — CPU→GPU — when `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` are set; `server/src/agent/modal-tool.ts`), and per-project MCP tools (`.pi/mcp.json`). There is no orchestrator/expert split, no Gemini CLI, and no LiteLLM proxy (all removed in the Pi migration). Models go directly to **OpenRouter** (built-in Pi provider) or **Ollama** (local). Everything runs locally; user data lives in `projects/`.

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
5. **Cost ledger + budgets.** Pi reports `usage.cost` inline (no async backfill). `server/src/cost/ledger.ts` snapshots `getSessionStats()` before/after each run and appends a row to `projects/<id>/sandbox/.kady/runs/<sessionId>/costs.jsonl` (role `agent`|`subagent`|`compute`). Modal `modal_run` jobs carry no model tokens, so they are metered by wall-time × the instance's hourly rate and ledgered as `compute` rows (`recordModalRun`). A project `spendLimitUsd` blocks runs (and Modal jobs) once cumulative spend reaches it.
6. **Skills.** Seeded per-project into `sandbox/.pi/skills/` from `K-Dense-AI/scientific-agent-skills` (`server/src/agent/skills.ts`); Pi's `DefaultResourceLoader` (cwd = sandbox) auto-discovers and the agent activates them. `SKILL.md` frontmatter is unchanged.
7. **Sandbox API + scientific previews.** `server/src/api/sandbox.ts` ports all file ops (tree/read/write/move/upload/zip/raw/download), annotation sidecars, LaTeX compile (async latexmk/multi-pass with SyncTeX), `/sandbox/synctex` (source<->PDF mapping), and the budget-gated `/sandbox/latex-assist` one-shot AI endpoint (ledgered under session id `latex-assist`). It also serves rich previews for many scientific formats. The frontend has an extensible viewer registry: `web/src/lib/viewers/registry.ts` maps a `FileCategory` (`web/src/lib/use-sandbox.ts`) to a lazy-loaded viewer in `web/src/components/viewers/*`; `FileViewer` in `file-preview-panel.tsx` checks the registry first and falls back to its built-in chain for the original categories (image/pdf/markdown/csv/notebook/fasta/biotable/latex/text). Binary/parse-heavy formats decode in **standalone Python helpers** under `server/src/helpers/` (`anndata_helper.py`, `chem_helper.py`, `structure_helper.py`, `massspec_helper.py`, `arrays_helper.py`, `imaging_helper.py`) — no longer just anndata. They run in a dedicated **uv-managed helper venv** (`server/src/helpers/pyproject.toml`, `.venv`), resolved via `helperPython()` and pre-warmed by `syncHelperVenv()` (`server/src/helpers-env.ts`) at `prep`/boot. A generic dispatcher (`server/src/api/sci-helpers.ts`, `sciHelperFor`/`runSciHelper`) routes a `kind` param to a helper's `summarize`/`render` subcommands over two endpoints: `GET /sandbox/sci-summary?path=&kind=` (JSON) and `GET /sandbox/sci-render.png?path=&kind=&index=&axis=` (image); all helpers share the exit-code contract `0` ok / `3` deps-missing / `4` not-found / `5` bad-value / `1` other, mapped to HTTP by the routes. 3D structures also use a client-side WebGL viewer (3Dmol.js) and spectra use chart.js. New scientific viewers are view-only; user-facing coverage is in `docs/file-previews.md`; the phased design/plans live under `docs/superpowers/`.

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
- A live credentials Settings UI (`web/src/components/settings-dialog.tsx` ↔ `/credentials` in `server/src/api/credentials.ts`), MCP servers, native web search (pi-web-access), and **Modal remote compute** (the `modal_run` tool + per-chat compute selector) are all implemented. Still **deferred** from the pre-Pi stack: provenance/manifests and the "Copy as Methods" export, citation verification, and first-party literature search (Paperclip) / document conversion.

**Capability hub.** The **Skills**, **Specialists** (subagents), and **Connectors** (MCP) capability panels live as tabs inside the **Settings** dialog (`web/src/components/settings-dialog.tsx`, opened from the header gear), alongside API keys / Fusion / Appearance — one dialog, not a separate Customize surface. Enable/disable is non-destructive: skills move between `sandbox/.pi/skills/` and `sandbox/.pi/skills-disabled/`, project specialists between `sandbox/.pi/agents/` and `sandbox/.pi/agents-disabled/`, and MCP entries between `sandbox/.pi/mcp.json` and `sandbox/.pi/mcp-disabled.json`. Builtin (pi-subagents package) specialists are disabled via `subagents.agentOverrides.<name>.disabled` in `sandbox/.pi/settings.json`. Sessions read only the canonical locations, so toggles apply to new chat tabs/subagent runs (live sessions keep their set).

## Releases

- `server/package.json` `version` is the single source of truth for the app version. The web build reads it at build time (`web/next.config.ts` injects `NEXT_PUBLIC_APP_VERSION`); `web/package.json` deliberately has no `version` field.
- Releasing = bump `server/package.json` version and push/merge to `main`. The `Release` workflow (`.github/workflows/release.yml`) runs on every push to `main`, and if the tag `v<version>` doesn't exist yet it creates it plus a GitHub release with auto-generated notes. No manual tagging.

## Testing notes

- Backend tests: `cd server && npm test` (vitest, in `server/test/`). `KADY_PROJECTS_ROOT` is pointed at a temp dir via `vitest.config.ts`.
- Frontend tests: `cd web && npm test` (vitest). `npx tsc --noEmit` currently passes clean for the frontend too.

## Caveats worth knowing

- **One flat agent.** For independent/parallel subtasks the agent calls the `subagent` tool from the **pi-subagents** package, which spawns child `pi` CLI processes in the sandbox (the binary resolves from `server/node_modules/.bin`). Specialist scientific agents are seeded into each project's `sandbox/.pi/agents/*.md` from `server/src/agent/subagents.ts` (write-if-missing; user edits win). Budget gating + cost ledgering for child runs lives in `server/src/agent/subagent-bridge.ts`.
- **Interview tool (clarifying questions).** The `interview` custom tool (`server/src/agent/interview.ts`) blocks the run on a pending-answer promise; the questions ride the normal `tool_start` SSE frame and the chat UI renders them as an inline form (`web/src/components/interview-form.tsx`), POSTing answers to `/sessions/:id/interview/:toolCallId`. Tool `promptGuidelines` + the seeded `AGENTS.md` push the agent to interview liberally before assuming. Question schema mirrors pi-interview (single/multi/text/image/info, recommended/conviction/weight, code `content`, image/table/mermaid/chart/html `media`); user-uploaded images return to the model as image blocks. Deliberately NOT exposed to sub-agent child processes — they are headless and must not block on user input.
- **Thinking level.** Each chat tab has a per-run thinking-level selector (`web/src/components/thinking-selector.tsx`, default `high`); the run body's `thinkingLevel` is validated by `server/src/agent/thinking.ts` and applied via Pi's `session.setThinkingLevel()` after `setModel`. Ollama and Fusion runs send no level (chip disabled). Caveat: like `setModel`, Pi's `setThinkingLevel` also persists the value as the **global default** in `~/.pi/agent/settings.json` — so the last level picked in any tab becomes the starting level for subagent child `pi` processes and for the user's own `pi` CLI. Pin a `thinking` level in a specialist's frontmatter if a subagent must not inherit it.
- **Modal remote compute (`modal_run`).** Gated on `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (managed live via `/credentials`; `modalConfigured()` in `server/src/config.ts`). `server/src/agent/modal-tool.ts` is an in-process custom tool, registered in `session-registry.ts` only when configured. It uses the `modal` JS SDK to create an isolated Sandbox on a chosen instance (`server/src/agent/modal-instances.ts` catalogue — `cpu`→`h100`, with GPU string + hourly rate), stages `files_in`, runs the command, copies `files_out` back into the local sandbox (which stays the canonical filesystem — no split-brain), and ledgers wall-time × rate as a `compute` row. The per-chat instance is picked in the UI (`web/src/components/compute-selector.tsx`, gated on `modalConfigured`) and threaded through the run body → `setSessionComputeTarget` → the tool's session default. Like `interview`, it is an in-process custom tool, so it is NOT seen by sub-agent child `pi` processes; promoting it to a Pi package (mirroring web-access) would extend it to them. No secrets are injected into the sandbox by default.
- **Living Lab Notebook (`notebook`).** The lead agent uses an in-process `notebook` custom tool (like `interview` and `modal_run`) to write entries live to the notebook. Subagents get the tool via the vendored `kady-notebook` Pi package (referenced from `sandbox/.pi/settings.json`, like pi-web-access); the package registers the tool only in child processes (gated on `PI_SUBAGENT_CHILD` env var) so it never collides with the lead's tool. When a subagent finishes, its notebook entries are harvested from its session JSONL file, role-stamped with the agent name, and appended to the parent notebook (the parent is the single writer). Subagent entries appear batch-on-completion, not live token-by-token; for asynchronous/background subagents, entries may appear on the next notebook fetch if the child finishes after the parent run ends. Nested subagents (depth > 1) are not harvested in this version.
- **OpenRouter cost** is read from Pi's `usage.cost` (computed from `model.cost`). For synthesized OpenRouter models the pricing comes from `web/src/data/models.json`; keep that catalogue current for accurate cost.
- **Node ≥ 22.19** is what Pi targets; lower 22.x usually works but emits an `EBADENGINE` warning. Node < 22 (e.g. v20) fails to build/install the packages, so `start.sh` refuses to run on it.
- **Don't run our source through `tsc` for emit** — both dev and prod run via `tsx`; `tsconfig.json` is `noEmit` for typechecking only.
