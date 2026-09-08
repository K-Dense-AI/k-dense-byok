# Custom model servers

Point Kady at any OpenAI- or Anthropic-compatible endpoint that is not in the
built-in provider list — a lab's vLLM box, an institutional gateway, a
self-hosted proxy — with real pricing and context metadata, so the picker,
the spend cap and the ledger treat it like any other provider.

This is Pi's `models.json` mechanism, managed from Settings → **Model
providers** → **Custom model servers**. The file lives in Kady's agent
directory (`~/.kady/pi-agent/models.json` unless `KADY_PI_AGENT_DIR` /
`PI_CODING_AGENT_DIR` moves it). Changes apply immediately; no restart.

## Adding a server

1. **Provider id** — lowercase, e.g. `hpc-vllm`. It becomes the prefix of the
   model reference (`hpc-vllm/llama-3.3-70b`) and must not collide with a
   built-in provider (`anthropic`, `openrouter`, `ollama`, …).
2. **Base URL** and **API** — `openai-completions` (most servers: vLLM, LM
   Studio, LiteLLM, TGI), `openai-responses`, or `anthropic-messages`.
3. **API key** — a literal, `$ENV_VAR` to read an environment variable, or
   empty for a keyless server (Kady writes a placeholder; Pi needs one to list
   the models).
4. **Models** — one row per model id the server accepts, with optional display
   name, context window, max output tokens, whether it can reason and accept
   images, and **cost in USD per million tokens** (input, output, cache read,
   cache write). Cost is what the ledger bills; leave it at 0 for a server you
   own.

Save, then pick the model in any chat. The picker lists custom servers in their
own section; the reference in exports and ledgers is `<provider id>/<model id>`.

## Billing

Custom servers are pay-as-you-go at their declared cost, so a priced gateway
counts toward the project spend cap and a $0 server ledgers $0. Kady cannot
verify the declared prices.

## Sharing `models.json` with a standalone Pi

Kady only rewrites providers it created (tracked in
`kady-custom-models.json` next to the file). Providers you wrote by hand for
the Pi CLI are shown read-only in the card and left untouched. A hand-written
provider with the same id as one you try to save is refused rather than
replaced.

## Not covered

Per-model default thinking levels (`modelThinkingLevels`) are not exposed:
each chat tab applies its own thinking selector after choosing a model, so a
Pi-level default would never take effect in Kady. Set the level in the tab.
