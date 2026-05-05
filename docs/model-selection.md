# Model Selection

Kady uses two model choices in each chat tab:

- **Orchestrator model:** the main Kady agent that reads your message, decides what to do, and streams the response.
- **Expert model:** the model used by delegated expert tasks that run inside the Gemini CLI process.

Both choices are stored per tab, so different chats in the same project can use different orchestrator and expert models.

## OpenRouter models

The OpenRouter model picker is generated from models that advertise tool-calling support. Kady sends tool definitions to the orchestrator and expert, so models that do not support the `tools` parameter are excluded from the dropdown.

The generator calls the OpenRouter SDK with:

```python
client.models.list(supported_parameters="tools")
```

The resulting entries are written to `web/src/data/models.json` with ids prefixed as `openrouter/<provider>/<model>`. The LiteLLM proxy has an `openrouter/*` wildcard route, so both the orchestrator and the Gemini CLI-backed expert can use any generated OpenRouter id.

To refresh the checked-in model list:

```bash
uv run python - <<'PY'
from dotenv import load_dotenv
load_dotenv("kady_agent/.env")

from kady_agent.utils import update_models_json
update_models_json()
PY
```

By default, this includes all OpenRouter models with `tools` support, preserves the orchestrator and expert recommended defaults, and omits retired GPT-5.4 base/pro entries.

## Defaults

- The orchestrator default is `openrouter/anthropic/claude-opus-4.7`.
- The expert default is `openrouter/google/gemini-3.1-pro-preview`.

Gemini 3.1 Pro Preview is recommended for expert tasks because expert delegation is tool-heavy and often benefits from a large context window. You can still choose a different tool-capable OpenRouter model per tab.

## Local Ollama models

Pulled Ollama models are discovered live from the local Ollama daemon and appear under the **Local (Ollama)** section in the picker. Selecting an Ollama model routes through the local LiteLLM `ollama/*` wildcard instead of OpenRouter.

Local models are useful for privacy and cost control, but tool-calling quality varies widely. For complex delegated expert tasks, frontier OpenRouter models are usually more reliable.
