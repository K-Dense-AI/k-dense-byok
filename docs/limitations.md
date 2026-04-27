# Known Limitations

K-Dense BYOK is in beta. The most important rough edges today are all on the expert-delegation path, which relies on the Gemini CLI and Gemini models.

## Gemini models and the Gemini CLI with Skills

The expert delegation system relies on the Gemini CLI, which uses Gemini models to execute tasks with our scientific skills. While this works well for many workflows, there are some rough edges to be aware of:

- **Skill activation is not always reliable.** Gemini models sometimes skip a relevant skill, use it partially, or misinterpret the skill's instructions. This is especially noticeable with complex multi-step skills that require strict adherence to a procedure.
- **Tool-calling consistency varies.** The Gemini CLI occasionally drops tool calls mid-execution or calls tools with incorrect arguments, which can cause expert tasks to stall or produce incomplete results.
- **Long-context degradation.** When a skill injects a large amount of context (detailed protocols, multiple reference databases), Gemini models may lose track of earlier instructions or produce less focused output.
- **Structured output can drift.** For skills that require specific output formats (tables, JSON, citations), Gemini models sometimes deviate from the requested structure.

These are upstream limitations of the Gemini model family and the Gemini CLI tooling, not bugs in K-Dense BYOK itself. Google is actively improving both, and we see meaningful progress with every new model release and CLI update. As these improve, the expert delegation experience will get better automatically without any changes on your end.

**Workarounds:**

- If a skill isn't behaving as expected, try **re-running the task** - results can vary between runs.
- You can switch Kady's main model (via the dropdown) to a non-Gemini model for the orchestration layer while experts continue to use Gemini under the hood.

## Ollama / small local models

Local models served through Ollama are supported end-to-end, but they amplify the Gemini CLI caveats above:

- Tool-calling fidelity is noticeably weaker on sub-frontier models.
- Skills that rely on multi-tool choreography (browsing, running scripts, structured output) are the most fragile.

If a delegation loops or ignores its skill, try a **larger local model** (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken. See [Local models with Ollama](./local-models-ollama.md).

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
