# Model Selection

Each chat tab picks **one model** for Kady. There is a single flat agent — no separate "expert" or orchestrator model. Subagents spawned with the `subagent` tool inherit the chat's model unless their agent file (`sandbox/.pi/agents/*.md`) pins one, a project-level override names one, or Kady passes a per-run override.

The choice is stored per tab, so different chats in the same project can use different models, and you can switch models between messages within a tab.

## Canonical model references

Kady uses canonical `provider/model` references in the picker, backend, cost ledger, and subagent configuration:

- OpenRouter: `openrouter/<vendor>/<model>`
- Pi OAuth providers: `openai-codex/<model>`, `anthropic/<model>`, `github-copilot/<model>`, `xai/<model>`, `kimi-coding/<model>`, `radius/<model>`
- Every other built-in Pi provider, by its Pi provider id: `nvidia/<vendor>/<model>`, `openai/<model>`, `google/<model>`, `groq/<model>`, `huggingface/<org>/<repo>`, `fireworks/accounts/fireworks/models/<model>`, `amazon-bedrock/<model-id>`, `cloudflare-workers-ai/@cf/<org>/<model>`, … — everything after the first slash is the provider's own model id, verbatim
- Ollama: `ollama/<name>`
- Any other local OpenAI-compatible server (LM Studio, vLLM, …): `openai-compatible/<id>`

This distinction matters: `openrouter/anthropic/<model>` is an OpenRouter request billed to your OpenRouter credits, while `anthropic/<model>` goes straight to Anthropic with your Anthropic key or Claude Pro/Max login. Fusion picker entries use an internal `fusion/<preset>` selector and resolve to the OpenRouter-only `openrouter/fusion` request.

## Pi subscription models

Open **Settings → Model providers** to connect ChatGPT Plus/Pro (`openai-codex`), Claude Pro/Max (`anthropic`), GitHub Copilot, xAI, Kimi Code (`kimi-coding`), OpenRouter (as a sign-in alternative to pasting a key), or Radius (a dynamic gateway whose model list is fetched after sign-in). Kady hosts Pi's browser, device-code, and manual-code prompts in one dialog. Once connected, the provider's models are read live from Pi and appear in the model picker. OpenAI Codex, GitHub Copilot, and Radius are OAuth-only; Anthropic, xAI, and Kimi also accept an API key under **API keys** (see below), in which case they bill pay-as-you-go instead.

The lead agent and child subagents share Kady's Pi auth store (`~/.kady/pi-agent/auth.json` by default), so the same login can authenticate either. See [Installation](./installation.md#4-configure-model-access) for `KADY_PI_AGENT_DIR` and the explicit `PI_CODING_AGENT_DIR` sharing option.

Subscription authentication is not a promise of free usage:

- OpenAI Codex, GitHub Copilot, xAI, and Kimi Code usage records tokens and Pi's list-price reference, but that reference is not project spend and does not count toward a Kady spend cap. The provider manages subscription quotas, premium requests, and overages.
- Pi documents third-party Anthropic OAuth as metered extra usage billed per token. Kady records that amount as spend and counts it toward the project cap.
- An OpenRouter or Radius sign-in only replaces an API key: usage is metered and counts toward the cap exactly as with a key.

## Direct API-key providers

Every provider Pi supports natively ([pi.dev/docs/latest/providers](https://pi.dev/docs/latest/providers)) is available with your own credentials. Open **Settings → API keys → Direct model providers**, pick a provider, and paste its key; the value is stored in `.env` under the variable Pi reads (for example `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `HF_TOKEN`) and takes effect for new runs immediately, in subagents too. Once a credential resolves, the provider gets its own section in the model picker with Pi's built-in catalogue for it.

| Provider | Pi id / ref prefix | Env var(s) | Billing |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | pay-as-you-go (Claude Pro/Max login is metered extra usage) |
| OpenAI | `openai` | `OPENAI_API_KEY` | pay-as-you-go |
| Google Gemini | `google` | `GEMINI_API_KEY` (shared with web-search) | pay-as-you-go |
| xAI | `xai` | `XAI_API_KEY` | pay-as-you-go (SuperGrok / X Premium login is a subscription) |
| DeepSeek, Mistral, Groq, Cerebras | `deepseek`, `mistral`, `groq`, `cerebras` | `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY` | pay-as-you-go |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` | NVIDIA API credits (not cap-counted; see below) |
| Hugging Face, Fireworks, Together, Baseten | `huggingface`, `fireworks`, `together`, `baseten` | `HF_TOKEN`, `FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `BASETEN_API_KEY` | pay-as-you-go |
| Vercel AI Gateway | `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | pay-as-you-go |
| OpenCode Zen / Go | `opencode`, `opencode-go` | `OPENCODE_API_KEY` | pay-as-you-go |
| Kimi For Coding | `kimi-coding` | `KIMI_API_KEY` | pay-as-you-go (Kimi Code login is a subscription) |
| Moonshot AI (intl / CN) | `moonshotai`, `moonshotai-cn` | `MOONSHOT_API_KEY` | pay-as-you-go |
| MiniMax (intl / CN) | `minimax`, `minimax-cn` | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` | pay-as-you-go |
| Z.AI (intl / Coding CN) | `zai`, `zai-coding-cn` | `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` | pay-as-you-go |
| Qwen Token Plan (SG / Individual / CN) | `qwen-token-plan`, `qwen-token-plan-individual`, `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY` | prepaid plan (not cap-counted) |
| Xiaomi MiMo | `xiaomi` | `XIAOMI_API_KEY` | pay-as-you-go |
| Xiaomi Token Plan (CN / AMS / SGP) | `xiaomi-token-plan-cn`, `-ams`, `-sgp` | `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` | prepaid plan (not cap-counted) |
| Ant Ling | `ant-ling` | `ANT_LING_API_KEY` | pay-as-you-go |
| Azure OpenAI | `azure-openai-responses` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` (optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`) | pay-as-you-go |
| Amazon Bedrock | `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_REGION`); ECS task roles and IRSA are picked up automatically | pay-as-you-go |
| Google Vertex AI | `google-vertex` | `GOOGLE_CLOUD_API_KEY`, or Application Default Credentials (`gcloud auth application-default login`) + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` | pay-as-you-go |
| Cloudflare AI Gateway | `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` | pay-as-you-go |
| Cloudflare Workers AI | `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` (model ids start with `@cf/`) | pay-as-you-go |

How this behaves:

- **Pricing comes from Pi.** Pay-as-you-go providers use Pi's built-in list price for each model, so the picker quote and the ledgered cost agree and count toward the project spend cap. Only models in Pi's catalogue can be selected for these providers — an unknown id is refused rather than run at an unknown price. NVIDIA NIM is the exception (below).
- **Prepaid plans are external spend.** The Qwen and Xiaomi token plans, like NVIDIA NIM, draw on a plan quota Pi prices at $0, so Kady records tokens without USD spend and the cap neither counts nor blocks them.
- **Dual providers pick the credential Pi resolves.** If Anthropic, xAI, or Kimi has both a key and an OAuth login, the model appears once, under the billing of the credential Pi uses for the request.
- **Configuration values live beside the key.** Cloud providers show their extra fields (endpoint, resource, account, region, project) in the same Settings row; those values are echoed back unmasked so a stale region is easy to spot.
- **The launcher's "no model access" warning** recognizes any of these keys; ambient-only setups (an AWS profile, `gcloud` ADC) may still see the warning even though the provider works — Settings shows the live status.
- **llama.cpp** and other local OpenAI-compatible servers use the `openai-compatible` provider, not a separate Pi login.

## OpenRouter models

The model picker is generated by `scripts/update-models.py` from OpenRouter models released within the previous six calendar months that advertise tool-calling support (`~vendor/*-latest` aliases are exempt from the age gate). Kady sends tool definitions with every turn, so models that do not support the `tools` parameter are excluded from the dropdown. Two kinds of model stay available past the age cutoff: the configured default models, so new chats keep working, and any model named by a built-in Fusion preset, because the picker quote and the spend-cap ledger both price a Fusion turn from these rows (a missing panel or judge model would silently under-count the turn rather than hide the preset).

The checked-in list lives at `web/src/data/models.json`, with ids prefixed as `openrouter/<vendor>/<model>`. The backend (`server/src/agent/models.ts`) resolves a picked id to a Pi `Model`: it prefers Pi's built-in OpenRouter entry, and otherwise synthesizes one using the context window, capabilities, and per-1M-token pricing from this catalogue. Pi computes the cost shown in the session/project meters from that pricing, so keeping `models.json` current keeps cost tracking (and the project spend cap) accurate. If the catalogue can't be loaded, the backend logs a startup warning and unknown models fall back to $0 pricing.

### Claude Fable 5 and the skills index

Claude Fable 5 refuses requests whose system prompt carries certain seeded scientific skill descriptions, before generating anything: the run fails with `Provider finish_reason: content_filter` and zero input tokens, and nothing is billed. It affects subagents too, since they inherit the lead's model. The chat error names the enabled skills responsible; see [Known Limitations](./limitations.md#some-models-refuse-the-skills-index) for the list and the workarounds.

## NVIDIA NIM models

Add an NVIDIA API key (from [build.nvidia.com](https://build.nvidia.com/)) under **Settings → API keys** and an **NVIDIA NIM** section appears in the picker with Pi's built-in NIM catalogue — Nemotron, Llama, GPT-OSS, Kimi, GLM, and others served from `integrate.api.nvidia.com`. The key is stored as `NVIDIA_API_KEY` in `.env`, exactly like the OpenRouter key, and child subagent processes inherit it.

NIM billing is different from OpenRouter: build.nvidia.com draws on NVIDIA-managed API credits rather than per-token dollar pricing, so Kady records tokens but no USD spend. NIM usage neither counts toward nor is blocked by a project spend cap — the same treatment as the ChatGPT, Copilot, and xAI subscriptions. A model id missing from Pi's catalogue snapshot still runs (the backend synthesizes it), so refs to newly released NIM models keep working.

The picker lists Pi's built-in NIM catalogue, which won't include private or early-access endpoints. To surface those, set `NVIDIA_EXTRA_MODELS` in `.env` to a comma- or whitespace-separated list of model ids (e.g. `private/vendor/example-model`) — they appear under the NVIDIA NIM picker section and run like any other NIM model. Values are model ids exactly as sent to the API; don't add a `nvidia/` ref prefix (NIM ids can legitimately begin with a `nvidia/` vendor segment). Ids that later land in Pi's catalogue are deduped automatically, catalogue metadata winning.

## OpenRouter Fusion presets

The picker also has an **Openrouter Fusion** section at the top: named presets where a panel of models deliberates on your prompt and an Opus 4.8 judge synthesizes one answer, with the combined panel price and (where published) the DRACO benchmark score shown on each entry. Selecting a Fusion preset rewrites the turn into an `openrouter/fusion` request and disables Kady's local tools for that turn so it returns the fused answer instead of running the agent loop. Fusion remains OpenRouter-only and requires `OPENROUTER_API_KEY`; a Pi subscription login cannot authorize it. See [OpenRouter Fusion](./openrouter-fusion.md) for the presets and how the integration works.

## Defaults

- The default model is `openrouter/openai/gpt-6-astra`.
- Override it with `DEFAULT_MODEL_ID` in `.env` (a bare provider model id like `openai/gpt-6-astra`, routed by `DEFAULT_MODEL_PROVIDER`).
- To default to a connected subscription model, set `DEFAULT_MODEL_PROVIDER` to `openai-codex`, `anthropic`, `github-copilot`, `xai`, or `kimi-coding` and set `DEFAULT_MODEL_ID` to that provider's model id.
- To default to any other direct provider, set `DEFAULT_MODEL_PROVIDER` to its Pi id (e.g. `groq`, `openai`, `amazon-bedrock`) and `DEFAULT_MODEL_ID` to that provider's model id; the key must be configured or new chats fail with a clear "not configured" error.
- To default to a local model, set `DEFAULT_MODEL_PROVIDER=ollama` and `DEFAULT_MODEL_ID` to a pulled model name (e.g. `llama3`).
- To default to a NIM model, set `DEFAULT_MODEL_PROVIDER=nvidia` and `DEFAULT_MODEL_ID` to the NIM model id (e.g. `nvidia/llama-3.3-nemotron-super-49b-v1.5`).

## Local models

Pulled Ollama models are discovered live: the backend's `/ollama/models` endpoint queries your local daemon (`OLLAMA_BASE_URL/api/tags`), and the results appear under the **Local (Ollama)** section of the picker as `ollama/<name>`. Any other server speaking the OpenAI API (LM Studio, vLLM, …) appears under **Local (OpenAI-compatible)** once `OPENAI_COMPATIBLE_BASE_URL` is set or a server answers on LM Studio's default port. Selecting either makes Pi call your local server directly — no OpenRouter key required, and nothing is counted against the spend cap.

Local models are useful for privacy and cost control, but tool-calling quality varies widely. For complex, tool-heavy tasks, frontier OpenRouter models are usually more reliable. See [Local models](./local-models-ollama.md).

## Thinking level

Each chat tab also has a thinking-level chip (`off` … `xhigh`, default `high`) applied per run. Ollama and Fusion runs send no level, so the chip is disabled for them. Pi persists the last level picked as the default in Kady's Pi agent directory, so it also becomes the starting level for specialists unless their agent file pins a `thinking` level.

## Speech transcription

Browser-native dictation uses the Web Speech API when available. The server-side fallback calls OpenRouter's transcription endpoint, so it still requires `OPENROUTER_API_KEY` even when the selected chat model uses a subscription.
