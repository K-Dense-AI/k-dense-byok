# Model Selection

Each chat tab picks **one model** for Kady. There is a single flat agent — no separate "expert" or orchestrator model. Subagents spawned with the `subagent` tool use the model named in their agent file (`sandbox/.pi/agents/*.md`) or passed per call; otherwise they fall back to Pi's default model resolution.

The choice is stored per tab, so different chats in the same project can use different models, and you can switch models between messages within a tab.

## Canonical model references

Kady uses canonical `provider/model` references in the picker, backend, cost ledger, and subagent configuration:

- OpenRouter: `openrouter/<vendor>/<model>`
- Pi OAuth providers: `openai-codex/<model>`, `anthropic/<model>`, `github-copilot/<model>`, or `xai/<model>`
- Ollama: `ollama/<name>`

This distinction matters: `openrouter/anthropic/<model>` is an OpenRouter API-key request, while `anthropic/<model>` is a direct Anthropic OAuth request. Fusion picker entries use an internal `fusion/<preset>` selector and resolve to the OpenRouter-only `openrouter/fusion` request.

## Pi subscription models

Open **Settings → Model providers** to connect ChatGPT Plus/Pro (`openai-codex`), Claude Pro/Max (`anthropic`), GitHub Copilot, or xAI. Kady hosts Pi's browser, device-code, and manual-code prompts in one dialog. Once connected, the provider's models are read live from Pi and appear in the model picker; Kady deliberately requires OAuth for these direct-provider entries rather than treating ambient API keys as subscription access.

The lead agent and child subagents share Kady's Pi auth store (`~/.kady/pi-agent/auth.json` by default), so the same login can authenticate either. See [Installation](./installation.md#4-configure-model-access) for `KADY_PI_AGENT_DIR` and the explicit `PI_CODING_AGENT_DIR` sharing option.

Subscription authentication is not a promise of free usage:

- OpenAI Codex, GitHub Copilot, and xAI usage records tokens and Pi's list-price reference, but that reference is not project spend and does not count toward a Kady spend cap. The provider manages subscription quotas, premium requests, and overages.
- Pi documents third-party Anthropic OAuth as metered extra usage billed per token. Kady records that amount as spend and counts it toward the project cap.

## OpenRouter models

The model picker is generated from OpenRouter models released within the previous three calendar months that advertise tool-calling support. Kady sends tool definitions with every turn, so models that do not support the `tools` parameter are excluded from the dropdown. The configured default models remain available if they cross the age cutoff so new chats keep working.

The checked-in list lives at `web/src/data/models.json`, with ids prefixed as `openrouter/<vendor>/<model>`. The backend (`server/src/agent/models.ts`) resolves a picked id to a Pi `Model`: it prefers Pi's built-in OpenRouter entry, and otherwise synthesizes one using the context window, capabilities, and per-1M-token pricing from this catalogue. Pi computes the cost shown in the session/project meters from that pricing, so keeping `models.json` current keeps cost tracking (and the project spend cap) accurate. If the catalogue can't be loaded, the backend logs a startup warning and unknown models fall back to $0 pricing.

## OpenRouter Fusion presets

This fork adds an **Openrouter Fusion** section at the top of the picker: named presets where a panel of models deliberates on your prompt and an Opus 4.8 judge synthesizes one answer, with the combined panel price and (where published) the DRACO benchmark score shown on each entry. Selecting a Fusion preset rewrites the turn into an `openrouter/fusion` request and disables Kady's local tools for that turn so it returns the fused answer instead of running the agent loop. Fusion remains OpenRouter-only and requires `OPENROUTER_API_KEY`; a Pi subscription login cannot authorize it. See [OpenRouter Fusion](./openrouter-fusion.md) for the presets and how the integration works.

## Defaults

- The default model is `openrouter/anthropic/claude-opus-5`.
- Override it with `DEFAULT_MODEL_ID` in `.env` (a bare provider model id like `anthropic/claude-opus-5`, routed by `DEFAULT_MODEL_PROVIDER`).
- To default to a connected subscription model, set `DEFAULT_MODEL_PROVIDER` to `openai-codex`, `anthropic`, `github-copilot`, or `xai` and set `DEFAULT_MODEL_ID` to that provider's model id.
- To default to a local model, set `DEFAULT_MODEL_PROVIDER=ollama` and `DEFAULT_MODEL_ID` to a pulled model name (e.g. `llama3`).

## Local Ollama models

Pulled Ollama models are discovered live: the backend's `/ollama/models` endpoint queries your local daemon (`OLLAMA_BASE_URL/api/tags`), and the results appear under the **Local (Ollama)** section of the picker as `ollama/<name>`. Selecting one makes Pi call your local daemon directly — no OpenRouter key required for those models.

Local models are useful for privacy and cost control, but tool-calling quality varies widely. For complex, tool-heavy tasks, frontier OpenRouter models are usually more reliable. See [Local models with Ollama](./local-models-ollama.md).

## Speech transcription

Browser-native dictation uses the Web Speech API when available. The server-side fallback calls OpenRouter's transcription endpoint, so it still requires `OPENROUTER_API_KEY` even when the selected chat model uses a subscription.
