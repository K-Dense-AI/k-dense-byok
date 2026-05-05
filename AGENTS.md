# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

K-Dense BYOK is a local AI research-assistant app ("Kady") that brings the user's own API keys. It is one repo with three runtime services started together by `./start.sh`:

| Service | Port | Code |
|---|---|---|
| Frontend (Next.js 16 / React 19) | 3000 | `web/` |
| Backend (FastAPI + Google ADK agent) | 8000 | `server.py`, `kady_agent/` |
| LiteLLM proxy (routes LLM calls) | 4000 | `litellm_config.yaml`, `litellm_callbacks.py` |

Everything runs locally; user data lives in `projects/` and the Python venv in `.venv/`.

## Commands

Backend / agent (Python, uv-managed, requires Python ≥ 3.13):

```bash
uv sync                              # install / refresh deps
uv run pytest                        # run all backend tests (matches CI)
uv run pytest tests/test_agent_callbacks.py::test_name -v    # single test
uv run pytest -m integration         # run only the FastAPI/multi-module integration tests
uv run pytest --cov                  # coverage report (fails under 70%)
uv run python prep_sandbox.py        # init/refresh the project sandbox (skills download)
```

Frontend (`cd web` first):

```bash
npm install
npm run dev                          # Next.js dev server (port 3000)
npm run build                        # production build
npm run lint                         # eslint
npm run test                         # vitest run
npm run test:watch                   # vitest watch mode
```

Full app (all three services together):

```bash
./start.sh                           # bootstraps deps, starts litellm + backend + frontend
```

`start.sh` runs `uvicorn` with `--reload-dir kady_agent` only — **edits to `server.py` require restarting `start.sh` manually**, but edits inside `kady_agent/` hot-reload. The reload watcher is intentionally scoped this way so that writes inside `projects/<project>/sandbox/` (made by the Gemini CLI subprocess during `delegate_task`) do not bounce uvicorn mid-stream.

## Architecture: how a turn flows

1. **UI → backend.** A chat tab posts to the ADK web server inside `server.py`. Each tab carries its own `sessionId`; up to 10 tabs share the same project sandbox.
2. **Project session service.** `kady_agent/project_session_service.py` overrides ADK's default in-memory session store so messages persist to `projects/<project>/sessions.db` (one row per chat tab).
3. **Orchestrator (Kady).** `kady_agent/agent.py` builds the `LlmAgent` (`root_agent`) using `LiteLlm` pointed at the LiteLLM proxy. Instructions come from `kady_agent/instructions/main_agent.md` plus the skills catalogue (`utils.list_skill_summaries`).
4. **Per-turn callbacks.** Before each turn `_open_turn_manifest` writes `manifest.json` under `projects/<p>/sandbox/.kady/runs/<sessionId>/<turnId>/` for reproducibility; `_inject_tracking_headers` stamps `X-Kady-*` headers + LiteLLM metadata so the cost callback can correlate streamed responses back to a session/turn/project.
5. **Delegation.** For heavier work the orchestrator calls the `delegate_task` tool (`kady_agent/tools/gemini_cli.py`), which spawns the Gemini CLI as a subprocess in the project sandbox. The CLI talks to OpenRouter (or local Ollama) **through the same LiteLLM proxy** — workspace `settings.json` is generated from `kady_agent/gemini_settings.py` and only honored when the folder is in `GEMINI_CLI_TRUSTED_FOLDERS_PATH`.
6. **Cost ledger.** `_OrchestratorCostLogger` (a LiteLLM `CustomLogger`) writes one row per LLM call to `projects/<p>/sandbox/.kady/runs/<sessionId>/costs.jsonl`. For streaming OpenRouter responses cost arrives later, so the logger fires an async backfill that polls `https://openrouter.ai/api/v1/generation?id=<gen_id>` for ~60s and rewrites the row in place via `cost_ledger.update_cost_entry`.
7. **MCPs.** `kady_agent/mcps.py` builds the orchestrator's MCP toolset (built-in servers in `kady_agent/mcp_servers/` plus per-project entries from `projects/<p>/custom_mcps.json`). OAuth-flow servers are handled by `kady_agent/mcp_oauth.py`; tokens are injected into the workspace settings before each Gemini CLI run via `gemini_settings.refresh_oauth_tokens` + `write_merged_settings`.

## LiteLLM proxy gotchas (`litellm_config.yaml`)

- The repo pins `litellm<=1.82.6` (transitively via `google-adk`). That version has the #24234 regression where the proxy forwards a literal `openrouter/<vendor>/<model>` to OpenRouter and fails. **`litellm_callbacks.py` backports the fix from PR #24282** and is registered via `litellm_settings.callbacks`. Don't drop the import — it patches by side effect.
- The `openrouter/*` model entry intentionally does NOT merge the `*openrouter_shared` YAML alias. That alias would set `custom_llm_provider: openai`, breaking the prefix-stripping; the wildcard relies on LiteLLM's native `openrouter/` provider instead.
- `model_group_alias` re-maps Gemini CLI's hard-coded internal model IDs (`gemini-2.5-pro`, `gemini-3-pro-preview`, `*-customtools` suffix from ADK) onto the actual deployments — touch with care.
- `_cli_can_route` in `tools/gemini_cli.py` enforces the same set: only `gemini-*`, `ollama/*`, `openrouter/*` are passed via `-m`; anything else makes the CLI hang on a 404 from the proxy, so the flag is dropped.

## Testing notes

- `pytest.ini_options` (in `pyproject.toml`) sets `asyncio_mode = "auto"` — async test functions don't need `@pytest.mark.asyncio`.
- `integration` is a custom marker for end-to-end FastAPI/multi-module tests (e.g. `tests/test_server_integration.py`). They run by default; use `-m "not integration"` to skip.
- Coverage source is `kady_agent`, `server`, `litellm_callbacks`, `prep_sandbox` (see `tool.coverage.run`); MCP server stubs in `kady_agent/mcp_servers/` are excluded.
- CI (`.github/workflows/tests.yml`) runs `uv run pytest` on Python 3.13. The frontend has its own vitest suite but is not run in CI.

## Project / sandbox layout

```
projects/
├── index.json                        # project registry (names, tags, archived flag)
└── <projectId>/
    ├── project.json                  # metadata
    ├── custom_mcps.json              # per-project MCP servers (UI-edited)
    ├── sessions.db                   # SQLite, one row per chat tab
    └── sandbox/                      # files visible to all tabs in the project
        └── .kady/runs/<sessionId>/
            ├── costs.jsonl           # cost ledger (one row per LLM call)
            └── <turnId>/manifest.json   # reproducibility manifest per turn
```

Project state in `kady_agent/projects.py` is the source of truth for "which project is active"; `active_paths()` / `current_project_id()` are how other modules find the right `sandbox/` and ledger.

## Caveats worth knowing

- **Expert (delegated) tasks always run via the Gemini CLI**, even when the orchestrator dropdown is set to a non-Gemini model. The exception is Ollama: if the dropdown picks an `ollama/*` model, both orchestrator and expert use Ollama. See `docs/limitations.md` for known rough edges of the Gemini CLI path (skill activation drift, tool-calling fidelity).
- **Don't bypass the cost-tracking headers.** The whole cost ledger depends on `_inject_tracking_headers` running before every orchestrator LLM call. New code paths that call `litellm.acompletion` directly (instead of going through the ADK `LlmAgent`) need to stamp the same `X-Kady-*` headers + metadata or their cost won't be recorded.
- **OAuth MCPs need token refresh before delegation.** `gemini_settings.refresh_oauth_tokens` must be called before writing the merged workspace `settings.json`, otherwise the spawned Gemini CLI sees stale tokens.
