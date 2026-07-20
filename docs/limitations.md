# Known Limitations

K-Dense BYOK is in beta. The agent now runs on the [Pi coding-agent SDK](https://pi.dev) - a single flat agent with file/shell tools and a `subagent` delegation tool (pi-subagents) - which removed the old orchestrator/expert/Gemini-CLI stack and its biggest rough edges. The remaining limitations worth knowing are below.

## Skills depend on model quality

Scientific skills are markdown procedures (`SKILL.md`) the agent discovers in its sandbox and follows with its tools. How faithfully that happens depends on the selected model:

- **Skill activation is not always reliable.** Models sometimes skip a relevant skill, use it partially, or misinterpret the skill's instructions - especially complex multi-step skills that require strict adherence to a procedure.
- **Tool-calling consistency varies across models.** Some models occasionally drop tool calls or call tools with incorrect arguments, which can stall a task or produce incomplete results.
- **Long-context degradation.** When a skill injects a large amount of context (detailed protocols, multiple reference databases), models may lose track of earlier instructions.
- **Structured output can drift.** For skills that require specific output formats (tables, JSON, citations), models sometimes deviate from the requested structure.

These are limitations of the selected model, not of K-Dense BYOK itself; as model tool calling improves, skill execution improves automatically.

**Workarounds:**

- If a skill isn't behaving as expected, try **re-running the task** - results can vary between runs.
- Try a different model in the dropdown. The picker is limited to OpenRouter models that advertise `tools` support, but tool-calling quality still varies across providers.

## Ollama / small local models

Local models served through Ollama are supported end-to-end, but they amplify the caveats above:

- Tool-calling fidelity is noticeably weaker on sub-frontier models.
- Skills that rely on multi-tool choreography (running scripts, chaining edits, structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken. See [Local models with Ollama](./local-models-ollama.md).

## Tabbed chats

- **Hard cap of 10 tabs per project.** This keeps the browser snappy and
  bounds the number of parallel SSE streams to the backend. Close an
  existing tab before opening a new one once you hit the limit.
- **Refresh recovery requires the backend to stay running.** Browser refreshes
  and browser-tab closes preserve project workspaces, chat tabs, drafts,
  queues, and live turns. Stopping or restarting the Kady backend still ends
  in-flight turns; completed conversation history remains on disk and can be
  reopened from Chat history.
- **Workflows launch into the active tab.** If you have a long-running
  turn streaming in tab A and click Launch on a workflow while tab B is
  active, the workflow runs in tab B. Switch to the tab you want to
  receive the workflow before launching.

## Web access

Native web access ([pi-web-access](https://github.com/nicobailon/pi-web-access)) gives Kady and the sub-agents `web_search`, `code_search`, and `fetch_content` (pages, PDFs, GitHub repos, YouTube). A few edges:

- **No key = shared fallback.** Without an Exa / Perplexity / Gemini key (Settings → API keys), searches go through a free Exa fallback that can rate-limit under heavy use. Adding any one key removes that bottleneck.
- **Video understanding needs a Gemini key.** YouTube and local-video analysis are only available once `GEMINI_API_KEY` is set.
- **PDF extraction is text-only.** Scanned PDFs without a text layer are not OCRed.
- **Web access for sub-agents applies to new chat tabs**, same as agent and MCP edits below.

## Sub-agents

Sub-agent delegation ([docs](./sub-agents.md)) works end-to-end, with a couple of edges:

- **Sub-agents can't use MCP tools yet.** Tools from connected [MCP servers](./mcp-servers.md) are available to Kady itself but not to the sub-agents it spawns. Making them available to sub-agents is on the roadmap.
- **Per-agent model overrides must name an available model.** If you set a model on an agent in Settings → Sub-agents, use an id from the model dropdown; an unrecognized id falls back to the default model rather than failing.
- **Changes apply to new chat tabs.** Agents edited in Settings (and MCP server changes) take effect in tabs opened afterwards; already-running tabs keep the setup they started with.

## Modal compute

Modal jobs are durable, restart-recoverable, available to sub-agents, and
tracked in the center-panel Compute tab. The remaining boundaries are:

- **Displayed cost is an estimate.** Modal does not expose a generally available
  per-sandbox final invoice API. K-Dense reserves worst-case estimated cost and
  reconciles it to elapsed resource time on every terminal path.
- **Multi-GPU is single-sandbox.** K-Dense can request multiple GPUs and run
  bounded groups of independent jobs, but it does not orchestrate multi-node
  distributed training.
- **The local sandbox remains canonical.** Remote Volumes cache dependencies,
  models, and reference data; they are not a second copy of the project
  workspace.
- **Security and provenance have separate scopes.** Remote jobs do not receive
  model credentials by default. Fine-grained egress policy, per-job secrets,
  and full scientific provenance manifests remain future work.

See [Durable Modal compute](./modal-compute.md) for lifecycle and recovery details.

## Native Windows support is new

The app now runs natively on Windows 10/11 (no WSL needed) as of this release. It goes through the same test suite as macOS/Linux, but has had less real-world mileage — if you hit something Windows-specific, please [open a GitHub issue](https://github.com/K-Dense-AI/k-dense-byok/issues). WSL remains a supported alternative.

## Features deferred during the Pi migration

First-party literature/regulatory search (Paperclip), document conversion, browser automation, citation verification, and the provenance-aware "Copy as Methods" export are not available yet in the Pi-based backend. Web research and Modal remote compute are available now. In the meantime, many additional capabilities (GitHub, reference managers, databases, and more) can be added by connecting an [MCP server](./mcp-servers.md).
