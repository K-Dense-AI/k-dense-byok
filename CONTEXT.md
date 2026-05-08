# CONTEXT

Domain language for K-Dense BYOK. Every term here names something a contributor (human or agent) needs in their head before reading the code. The owning module is the source of truth — definitions here are deliberately short.

## Core terms

- **Project** — A user-owned workspace with its own sandbox, sessions, MCP config, and budget. Identified by a slug under `projects/<id>/`. Owned by `kady_agent/projects.py`.
- **ProjectPaths** — The dataclass naming all on-disk locations a project owns (`sandbox`, `kady_dir`, `gemini_settings_dir`, `citation_cache`, etc.) and the methods that perform path-bound I/O against them. Owned by `kady_agent/projects.py`.
- **Session** — One chat tab's conversation: a stable id, an ordered message history, and a cost ledger. Multiple sessions share a project's sandbox. Owned by `kady_agent/projects.py` (storage) and `kady_agent/runtime.py` (lifecycle).
- **Sandbox** — The per-project filesystem area where Kady and the expert read/write files. `projects/<id>/sandbox/`. Visibility rules (hide dot-files and `.gemini.md`) live in `kady_agent/sandbox_visibility.py`.
- **Expert** — The Gemini CLI subprocess Kady delegates concrete tool work to. Routed through the local LiteLLM proxy. Spawned by `kady_agent/tools/gemini_cli.py`.
- **TrackingTag** — A correlation tag (session id, turn id, role, delegation id, project id) attached to every LLM request so the cost ledger can attribute spend. Owned by `kady_agent/tracking.py` (single source of truth for the wire format).

## Invariants

- **`ProjectPaths` rule**: methods may own *path-bound I/O* (read/write bytes at a path it computes). Methods must NOT own *domain logic over the loaded content*. `load_citation_cache() -> dict` is OK; `merge_citation_caches()` or `find_citations_for_query()` is not. Enforced by structural test in `tests/test_project_paths.py`.
- **One module owns one rule**: changing how a tracking tag, a project path, or a visibility rule is encoded should require editing exactly one place.

## Architecture

See `docs/architecture.md` for the runtime layout (frontend / backend / LiteLLM proxy) and `docs/adr/` for load-bearing decisions.
