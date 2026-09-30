# Model selection

Choose a model per chat and change it between messages. Specialists inherit it
unless a workflow, specialist definition or project specialist default overrides
it. **Settings → Providers** is the connection and availability reference.

## Provider access

Use **Sign in** or enter the provider's API key and required configuration in
the same row. Search **Add a provider** to find disconnected providers.

Sign-in options include OpenAI (**Sign in with ChatGPT**), Anthropic, GitHub
Copilot, xAI, Kimi For Coding, Meta, OpenRouter and Radius. **OpenAI Codex
(legacy)** remains available for existing logins. Provider quotas and eligibility
are external to Kady; a successful login does not imply unlimited usage.

### Direct API-key providers

Kady exposes Pi's direct providers, including OpenAI, Anthropic, Google, NVIDIA,
Groq and cloud services such as Azure, Bedrock, Vertex and Cloudflare. The UI
shows the exact key, endpoint, account and region fields required. Values saved
there update `.env` and apply to new requests without a restart.

The authoritative field list is
[`provider-catalog.ts`](../server/src/agent/provider-catalog.ts); sign-in methods
are in [`provider-auth.ts`](../server/src/agent/provider-auth.ts). Direct models
resolve through Pi's registry. Unknown model IDs are rejected except for the
NVIDIA synthesis described below.

## Model references

| Source | Reference |
|---|---|
| OpenRouter | `openrouter/<vendor>/<model>` |
| Direct or sign-in provider | `<provider>/<model-id>` |
| Ollama | `ollama/<name>` |
| Local OpenAI-compatible | `openai-compatible/<model-id>` |
| Custom server | `<custom-provider-id>/<model-id>` |
| Fusion picker entry | `fusion/<preset-id>` |

Everything after the provider's first slash is the model ID, including any
further slashes. `anthropic/<model>` uses the Anthropic credential;
`openrouter/anthropic/<model>` uses OpenRouter.

OpenRouter's checked-in catalogue and pricing live in
[`models.json`](../web/src/data/models.json), refreshed by
[`update-models.py`](../scripts/update-models.py). Pi's built-in entry is used
when available; otherwise Kady synthesizes it from that catalogue. Missing
catalogue pricing can produce a $0 fallback, so usage totals are estimates.

For **NVIDIA NIM**, set `NVIDIA_API_KEY` in Providers or `.env`. Missing IDs can
be synthesized at $0. `NVIDIA_EXTRA_MODELS` adds comma/whitespace-separated raw
NIM IDs to the picker; do not add Kady's provider prefix.

For other endpoints, see [local servers](local-models-ollama.md) or
[custom servers with declared pricing](custom-model-servers.md).

## Defaults and thinking

**Settings → Defaults** chooses the model, thinking and compute for a project's
first chat. A tab opened beside another copies that tab's choices. Restored
sessions and system runs reuse their session/project model when available.

Model fallback order is saved app default → `DEFAULT_MODEL_PROVIDER` plus
`DEFAULT_MODEL_ID` in `.env` → built-in default in
[`config.ts`](../server/src/config.ts). An unresolvable saved default is skipped.
Fusion presets cannot be app defaults.

The thinking selector applies per run where supported. Local Ollama,
OpenAI-compatible and Fusion runs do not use it. Pi also persists the last
thinking level in its agent directory; pin a specialist's level when it must
not inherit that value.

## Billing and budgets

These are **Kady's accounting rules**, not provider invoices:

| Access | Counts toward the project cap? |
|---|---|
| Pay-as-you-go keys, OpenRouter/Radius sign-in, priced custom servers | Yes, at configured catalogue prices |
| Anthropic OAuth | Yes, as metered OAuth usage |
| ChatGPT, Copilot, xAI, Kimi Code and Meta OAuth | No; tokens and available list-price references are recorded |
| NVIDIA NIM, Qwen/Xiaomi token plans | No; provider-managed plans/credits |
| Ollama and local OpenAI-compatible servers | No; recorded at $0 |
| Modal | Yes; estimated reservations and settled compute cost |

For providers offering multiple credentials, classification follows the
credential Pi resolves; a Kimi For Coding API key is pay-as-you-go, while its
OAuth login uses plan accounting. Kady cannot read remaining provider quotas or overages.
The implementation is [`billing.ts`](../server/src/cost/billing.ts).

The cap checks committed project spend before paid model requests. Concurrent
or already-admitted requests can exceed it; model requests have no worst-case
cost reservation. [Modal](modal-compute.md#budgets-and-reservations) reserves
estimated full-lifetime cost. External-CLI specialists bypass Kady accounting.

## OpenRouter-only features

[Fusion](openrouter-fusion.md) and server-side speech transcription require
`OPENROUTER_API_KEY`. Browser-native dictation uses the Web Speech API when
available. Other providers' logins do not authorize the OpenRouter endpoints.
