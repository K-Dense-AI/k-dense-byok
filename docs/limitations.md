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
- **Tab list isn't persisted across reloads.** Refreshing the page resets
  you to a single new chat tab. The underlying sessions and their message
  history are still on disk under the project — you just can't currently
  reopen them all at once into tabs from the UI. Re-opening a session by
  id from the UI is on the roadmap.
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

## Features deferred during the Pi migration

Literature search (Paperclip), document conversion, remote compute (Modal), browser automation, and citation verification / "Copy as Methods" provenance export are not available yet in the Pi-based backend. They are being re-added in upcoming releases; the keys for them in `.env.example` are currently unused. In the meantime, many of these capabilities (GitHub, reference managers, ...) can be added today by connecting an [MCP server](./mcp-servers.md).
