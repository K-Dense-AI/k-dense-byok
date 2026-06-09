# Model Selection

Each chat tab picks **one model** for Kady. There is a single flat agent — no separate "expert" or orchestrator model. Subagents spawned with the `spawn_subagent` tool inherit the parent tab's current model.

The choice is stored per tab, so different chats in the same project can use different models, and you can switch models between messages within a tab.

## OpenRouter models

The model picker is generated from OpenRouter models that advertise tool-calling support. Kady sends tool definitions with every turn, so models that do not support the `tools` parameter are excluded from the dropdown.

The checked-in list lives at `web/src/data/models.json`, with ids prefixed as `openrouter/<vendor>/<model>`. The backend (`server/src/agent/models.ts`) resolves a picked id to a Pi `Model`: it prefers Pi's built-in OpenRouter entry, and otherwise synthesizes one using the context window, capabilities, and per-1M-token pricing from this catalogue. Pi computes the cost shown in the session/project meters from that pricing, so keeping `models.json` current keeps cost tracking (and the project spend cap) accurate. If the catalogue can't be loaded, the backend logs a startup warning and unknown models fall back to $0 pricing.

## Defaults

- The default model is `openrouter/anthropic/claude-opus-4.8`.
- Override it with `DEFAULT_MODEL_ID` in `.env` (a bare provider model id like `anthropic/claude-opus-4.8`, routed by `DEFAULT_MODEL_PROVIDER`).
- To default to a local model, set `DEFAULT_MODEL_PROVIDER=ollama` and `DEFAULT_MODEL_ID` to a pulled model name (e.g. `llama3`).

## Local Ollama models

Pulled Ollama models are discovered live: the backend's `/ollama/models` endpoint queries your local daemon (`OLLAMA_BASE_URL/api/tags`), and the results appear under the **Local (Ollama)** section of the picker as `ollama/<name>`. Selecting one makes Pi call your local daemon directly — no OpenRouter key required for those models.

Local models are useful for privacy and cost control, but tool-calling quality varies widely. For complex, tool-heavy tasks, frontier OpenRouter models are usually more reliable. See [Local models with Ollama](./local-models-ollama.md).
