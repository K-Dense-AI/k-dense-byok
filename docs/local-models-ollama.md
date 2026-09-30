# Local models

Kady supports Ollama and a separate OpenAI-compatible server connection. Both
are billed at $0 in Kady and require a model with usable tool-calling support.

## Ollama

1. Install and start Ollama on a host reachable from the BYOK backend.
2. Pull the model you want with `ollama pull <model-name>`.
3. In **Settings → Providers → Local model servers**, set the Ollama address if it differs from `http://localhost:11434`.
4. Reopen the model picker and choose **Local (Ollama)**.

Discovery reads `/api/tags`; references are `ollama/<name>`. The address is saved
as `OLLAMA_BASE_URL` and applies live. Clearing it restores the default.

## OpenAI-compatible servers

Start a compatible server (for example LM Studio, vLLM or llama.cpp), load its
model and enter the server root URL under **Local model servers →
OpenAI-compatible server**. The default is `http://localhost:1234`; `.env` can
set `OPENAI_COMPATIBLE_BASE_URL`.

Kady discovers IDs through `/v1/models` and sends chat requests to
`/v1/chat/completions`. The picker section appears when configured or when the
default server responds. References are `openai-compatible/<model-id>`, including
any slashes the server reports. Changes apply without a restart.

Avoid port 8000 if Kady's backend already uses it. One address is supported for
each local-server type; use [custom model servers](custom-model-servers.md) for
additional endpoints or explicit pricing/context metadata.

## Defaults and limits

Set **Settings → Defaults** to use the model for new projects' first chats, or set:

```dotenv
DEFAULT_MODEL_PROVIDER=ollama
DEFAULT_MODEL_ID=<pulled-model-name>
```

Saved Settings defaults take precedence. Specialist overrides can still select
other models. OpenAI-compatible discovery reads only IDs; Kady uses 32K context
and $0 defaults, and local thinking selectors are disabled.

A paid hosted endpoint entered here would leave its spend untracked. Add it as
a priced custom server instead. Model quality and protocol compatibility vary;
inspect tool failures before assuming an analysis succeeded. Selecting a local
model also does not disable web tools, connectors or Modal: those can still
transfer data off-host.
