/**
 * Direct (API-key) model providers Kady exposes from Pi's built-in registry.
 *
 * Pi ships ~40 providers (https://pi.dev/docs/latest/providers). Kady already
 * had bespoke wiring for OpenRouter, NVIDIA NIM, the OAuth subscriptions, and
 * the two local servers; this table generalizes the NVIDIA pattern so every
 * remaining Pi provider is reachable with a `<provider>/<model-id>` ref, a key
 * (or cloud credentials) managed under Settings → API keys, and a picker
 * section that appears once the provider is configured.
 *
 * What lives here and nowhere else:
 *   - the env var(s) Pi reads for each provider (copied from pi-ai's
 *     `env-api-keys.ts`; `provider-catalog.test.ts` checks parity against Pi's
 *     `findEnvKeys`, so an upstream rename fails loudly instead of leaving a
 *     dead Settings field),
 *   - Kady's billing classification (`payg` = per-token USD Pi can price,
 *     counted against the project cap; `subscription` = a prepaid plan or
 *     credit pool Pi prices at $0, recorded but never cap-counted — see the
 *     NVIDIA rationale in `cost/billing.ts`),
 *   - which providers may synthesize unknown model ids ($0 is only honest for
 *     credit-billed NIM; a payg provider synthesized at $0 would bypass the cap).
 *
 * Deliberately NOT here: `openrouter` (own catalogue + Fusion path in
 * `models.ts`), `ollama` / `openai-compatible` (local, `config.ts`), and the
 * OAuth-only providers `openai-codex`, `github-copilot`, `radius`
 * (`provider-auth.ts`). Providers with both an API key and an OAuth login
 * (`anthropic`, `xai`, `kimi-coding`) appear in both lists; the ref is the
 * same, and billing follows whichever credential Pi resolves at run time.
 */

export type DirectProviderBilling = "payg" | "subscription";

export interface ProviderEnvField {
  /** Exact environment variable Pi reads. */
  envVar: string;
  label: string;
  /** Password input + masked status. Non-secret values (regions, ids) are shown in full. */
  secret: boolean;
  /** Pi's `checkAuth` fails without it (informational; the server never enforces it). */
  required: boolean;
  placeholder?: string;
  hint?: string;
}

export interface DirectProviderDefinition {
  /** Pi provider id — the first segment of a canonical model ref. */
  id: string;
  /** Display name (matches Pi's `Provider.name`). */
  name: string;
  /** Model-picker section heading. */
  sectionLabel: string;
  /** Picker row description. */
  description: string;
  /** Settings hint. */
  hint: string;
  keysUrl?: string;
  /**
   * The provider's API-key variable, or null when Pi only recognizes ambient
   * cloud credentials for it. Null providers are configured entirely through
   * `extraEnv` (and files such as ~/.aws/credentials that Kady never touches).
   */
  keyEnvVar: string | null;
  keyLabel: string;
  keyPlaceholder?: string;
  /** Supporting configuration (endpoint, account, region, project…). */
  extraEnv: ProviderEnvField[];
  billingMode: DirectProviderBilling;
  billingNote: string;
  /** Unknown ids resolve to a synthesized $0 model instead of an error. */
  synthesizeUnknownIds: boolean;
  /**
   * Push the key into Pi's runtime credential on change (`setRuntimeApiKey`),
   * as the OpenRouter/NVIDIA rows always did. False for providers whose
   * `resolve()` mixes several ambient sources — there process.env is the only
   * safe channel, and Pi reads it live.
   */
  runtimeKey: boolean;
  /** Also connectable as an OAuth subscription under Settings → Model providers. */
  oauth: boolean;
}

const PAYG_NOTE = "Pay-as-you-go: Pi prices each turn from the provider's list price and Kady counts it toward the project spend cap.";
const PLAN_NOTE = "Prepaid plan or credit pool: Pi prices these models at $0, so Kady records tokens but no USD spend, and the project cap neither counts nor blocks them.";

function simple(
  id: string,
  name: string,
  keyEnvVar: string,
  options: Partial<
    Pick<
      DirectProviderDefinition,
      | "sectionLabel"
      | "description"
      | "hint"
      | "keysUrl"
      | "keyLabel"
      | "keyPlaceholder"
      | "billingMode"
      | "oauth"
      | "synthesizeUnknownIds"
    >
  > = {},
): DirectProviderDefinition {
  const billingMode = options.billingMode ?? "payg";
  return {
    id,
    name,
    sectionLabel: options.sectionLabel ?? name,
    description: options.description ?? `${name} (direct API key)`,
    hint: options.hint ?? `Direct access to ${name} models with your own API key.`,
    keysUrl: options.keysUrl,
    keyEnvVar,
    keyLabel: options.keyLabel ?? `${name} API key`,
    keyPlaceholder: options.keyPlaceholder,
    extraEnv: [],
    billingMode,
    billingNote: billingMode === "payg" ? PAYG_NOTE : PLAN_NOTE,
    synthesizeUnknownIds: options.synthesizeUnknownIds ?? false,
    runtimeKey: true,
    oauth: options.oauth ?? false,
  };
}

export const DIRECT_PROVIDERS: readonly DirectProviderDefinition[] = [
  // ---- Frontier labs -------------------------------------------------------
  simple("anthropic", "Anthropic", "ANTHROPIC_API_KEY", {
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    hint: "Direct Anthropic API access, billed per token to your Anthropic account. A Claude Pro/Max subscription connects under Model providers instead.",
    oauth: true,
  }),
  simple("openai", "OpenAI", "OPENAI_API_KEY", {
    keysUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    hint: "Direct OpenAI platform access (Responses API). A ChatGPT Plus/Pro subscription connects as OpenAI Codex under Model providers instead.",
  }),
  simple("google", "Google", "GEMINI_API_KEY", {
    sectionLabel: "Google Gemini",
    keysUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    keyLabel: "Gemini API key",
    hint: "Gemini models through Google AI Studio. The same key also powers the web-access search fallback and YouTube/video understanding.",
  }),
  simple("xai", "xAI", "XAI_API_KEY", {
    keysUrl: "https://console.x.ai/",
    keyPlaceholder: "xai-…",
    hint: "Direct xAI API access for Grok models. A SuperGrok / X Premium subscription connects under Model providers instead.",
    oauth: true,
  }),
  simple("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", {
    keysUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
  }),
  simple("mistral", "Mistral", "MISTRAL_API_KEY", {
    keysUrl: "https://console.mistral.ai/api-keys",
  }),

  // ---- Inference platforms -------------------------------------------------
  simple("groq", "Groq", "GROQ_API_KEY", {
    keysUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
  }),
  simple("cerebras", "Cerebras", "CEREBRAS_API_KEY", {
    keysUrl: "https://cloud.cerebras.ai/",
    keyPlaceholder: "csk-…",
  }),
  simple("nvidia", "NVIDIA", "NVIDIA_API_KEY", {
    sectionLabel: "NVIDIA NIM",
    description: "NVIDIA NIM (build.nvidia.com) via NVIDIA API credits",
    keysUrl: "https://build.nvidia.com/settings/api-keys",
    keyPlaceholder: "nvapi-…",
    keyLabel: "NVIDIA API key",
    hint: "Direct access to NVIDIA NIM models (Nemotron, Llama, GPT-OSS, …). Usage draws on your NVIDIA API credits, which Kady cannot meter.",
    billingMode: "subscription",
    // NIM ids missing from Pi's catalogue snapshot still run; $0 matches
    // Pi's own NIM entries so nothing is under-counted.
    synthesizeUnknownIds: true,
  }),
  simple("huggingface", "Hugging Face", "HF_TOKEN", {
    keysUrl: "https://huggingface.co/settings/tokens",
    keyLabel: "Hugging Face token",
    keyPlaceholder: "hf_…",
    hint: "Hugging Face Inference Providers router. Model ids keep their repo form (e.g. MiniMaxAI/MiniMax-M2).",
  }),
  simple("fireworks", "Fireworks", "FIREWORKS_API_KEY", {
    keysUrl: "https://fireworks.ai/account/api-keys",
    keyPlaceholder: "fw_…",
    hint: "Fireworks AI serverless inference. Model ids are full resource paths (accounts/fireworks/models/…).",
  }),
  simple("together", "Together", "TOGETHER_API_KEY", {
    keysUrl: "https://api.together.ai/settings/api-keys",
  }),
  simple("baseten", "Baseten", "BASETEN_API_KEY", {
    keysUrl: "https://app.baseten.co/settings/api-keys",
  }),
  simple("vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY", {
    keysUrl: "https://vercel.com/ai-gateway",
    hint: "Vercel's hosted gateway to many vendors with one key. Model ids use the vendor/model form.",
  }),
  simple("opencode", "OpenCode Zen", "OPENCODE_API_KEY", {
    keysUrl: "https://opencode.ai/zen",
    hint: "OpenCode Zen curated multi-vendor endpoint. Shares OPENCODE_API_KEY with OpenCode Go.",
  }),
  simple("opencode-go", "OpenCode Go", "OPENCODE_API_KEY", {
    keysUrl: "https://opencode.ai/zen",
    hint: "OpenCode Go plan endpoint. Shares OPENCODE_API_KEY with OpenCode Zen.",
  }),

  // ---- China / Asia labs and token plans -----------------------------------
  simple("kimi-coding", "Kimi For Coding", "KIMI_API_KEY", {
    keysUrl: "https://www.kimi.com/coding",
    keyLabel: "Kimi API key",
    hint: "Kimi For Coding endpoint (api.kimi.com/coding). Pi prices these models per token, so a key is metered like any other; signing in with Kimi Code under Model providers uses the plan's own limits instead.",
    oauth: true,
  }),
  simple("moonshotai", "Moonshot AI", "MOONSHOT_API_KEY", {
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    keyPlaceholder: "sk-…",
    hint: "Moonshot AI (Kimi) international platform. Shares MOONSHOT_API_KEY with the CN endpoint.",
  }),
  simple("moonshotai-cn", "Moonshot AI CN", "MOONSHOT_API_KEY", {
    keysUrl: "https://platform.moonshot.cn/console/api-keys",
    keyPlaceholder: "sk-…",
    hint: "Moonshot AI (Kimi) China platform. Shares MOONSHOT_API_KEY with the international endpoint.",
  }),
  simple("minimax", "MiniMax", "MINIMAX_API_KEY", {
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  }),
  simple("minimax-cn", "MiniMax CN", "MINIMAX_CN_API_KEY", {
    keysUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    keyLabel: "MiniMax CN API key",
  }),
  simple("zai", "Z.AI", "ZAI_API_KEY", {
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    hint: "Z.AI (Zhipu) GLM models through the international coding endpoint.",
  }),
  simple("zai-coding-cn", "Z.AI Coding CN", "ZAI_CODING_CN_API_KEY", {
    keysUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    keyLabel: "Z.AI Coding CN API key",
    hint: "Z.AI (Zhipu) GLM coding plan, China endpoint.",
  }),
  simple("qwen-token-plan", "Qwen Token Plan", "QWEN_TOKEN_PLAN_API_KEY", {
    keysUrl: "https://modelstudio.console.alibabacloud.com/",
    hint: "Alibaba Model Studio token plan (Singapore). Shares QWEN_TOKEN_PLAN_API_KEY with the Individual plan.",
    billingMode: "subscription",
  }),
  simple(
    "qwen-token-plan-individual",
    "Qwen Token Plan Individual",
    "QWEN_TOKEN_PLAN_API_KEY",
    {
      keysUrl: "https://modelstudio.console.alibabacloud.com/",
      hint: "Alibaba Model Studio individual token plan. Shares QWEN_TOKEN_PLAN_API_KEY with the standard plan.",
      billingMode: "subscription",
    },
  ),
  simple("qwen-token-plan-cn", "Qwen Token Plan CN", "QWEN_TOKEN_PLAN_CN_API_KEY", {
    keysUrl: "https://bailian.console.aliyun.com/",
    keyLabel: "Qwen Token Plan CN API key",
    hint: "Alibaba Model Studio (Bailian) token plan, China endpoint.",
    billingMode: "subscription",
  }),
  simple("xiaomi", "Xiaomi", "XIAOMI_API_KEY", {
    keysUrl: "https://platform.xiaomimimo.com/",
    hint: "Xiaomi MiMo models, pay-as-you-go endpoint.",
  }),
  simple("xiaomi-token-plan-cn", "Xiaomi Token Plan CN", "XIAOMI_TOKEN_PLAN_CN_API_KEY", {
    keysUrl: "https://platform.xiaomimimo.com/",
    keyLabel: "Xiaomi Token Plan CN API key",
    hint: "Xiaomi MiMo token plan, China endpoint.",
    billingMode: "subscription",
  }),
  simple("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", {
    keysUrl: "https://platform.xiaomimimo.com/",
    keyLabel: "Xiaomi Token Plan AMS API key",
    hint: "Xiaomi MiMo token plan, Amsterdam endpoint.",
    billingMode: "subscription",
  }),
  simple("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", {
    keysUrl: "https://platform.xiaomimimo.com/",
    keyLabel: "Xiaomi Token Plan SGP API key",
    hint: "Xiaomi MiMo token plan, Singapore endpoint.",
    billingMode: "subscription",
  }),
  simple("ant-ling", "Ant Ling", "ANT_LING_API_KEY", {
    hint: "Ant Group Ling models.",
  }),

  // ---- Cloud platforms -----------------------------------------------------
  {
    ...simple("azure-openai-responses", "Azure OpenAI", "AZURE_OPENAI_API_KEY", {
      keysUrl: "https://portal.azure.com/",
      keyLabel: "Azure OpenAI API key",
      hint: "OpenAI models hosted in your Azure subscription. Set the key plus either the resource endpoint URL or the resource name; root endpoints are normalized to /openai/v1 by Pi.",
    }),
    extraEnv: [
      {
        envVar: "AZURE_OPENAI_BASE_URL",
        label: "Endpoint URL",
        secret: false,
        required: false,
        placeholder: "https://my-resource.openai.azure.com",
        hint: "Alternative to the resource name.",
      },
      {
        envVar: "AZURE_OPENAI_RESOURCE_NAME",
        label: "Resource name",
        secret: false,
        required: false,
        placeholder: "my-resource",
        hint: "Alternative to the endpoint URL.",
      },
      {
        envVar: "AZURE_OPENAI_API_VERSION",
        label: "API version (optional)",
        secret: false,
        required: false,
        placeholder: "preview",
      },
      {
        envVar: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
        label: "Deployment name map (optional)",
        secret: false,
        required: false,
        placeholder: "gpt-5=my-gpt5-deployment,gpt-5-mini=my-mini",
        hint: "Maps Pi model ids to your deployment names when they differ.",
      },
    ],
  },
  {
    ...simple("amazon-bedrock", "Amazon Bedrock", "AWS_BEARER_TOKEN_BEDROCK", {
      keysUrl: "https://console.aws.amazon.com/bedrock/",
      keyLabel: "Bedrock bearer token",
      hint: "Claude, Nova, Llama and other models through your AWS account. Any one credential source works: a Bedrock bearer token, an AWS profile from ~/.aws/credentials, or IAM access keys. Also picked up automatically from ECS task roles and IRSA.",
    }),
    runtimeKey: false,
    extraEnv: [
      {
        envVar: "AWS_REGION",
        label: "Region",
        secret: false,
        required: false,
        placeholder: "us-east-1",
        hint: "Defaults to us-east-1 when unset.",
      },
      {
        envVar: "AWS_PROFILE",
        label: "AWS profile (optional)",
        secret: false,
        required: false,
        placeholder: "default",
      },
      {
        envVar: "AWS_ACCESS_KEY_ID",
        label: "Access key id (optional)",
        secret: true,
        required: false,
        placeholder: "AKIA…",
      },
      {
        envVar: "AWS_SECRET_ACCESS_KEY",
        label: "Secret access key (optional)",
        secret: true,
        required: false,
      },
    ],
  },
  {
    ...simple("google-vertex", "Google Vertex AI", "GOOGLE_CLOUD_API_KEY", {
      keysUrl: "https://console.cloud.google.com/vertex-ai",
      keyLabel: "Google Cloud API key (optional)",
      hint: "Gemini and partner models through your Google Cloud project. Either an API key (Vertex express mode), or Application Default Credentials from `gcloud auth application-default login` plus the project and location below.",
    }),
    runtimeKey: false,
    extraEnv: [
      {
        envVar: "GOOGLE_CLOUD_PROJECT",
        label: "Project id",
        secret: false,
        required: false,
        placeholder: "my-gcp-project",
        hint: "Required with Application Default Credentials.",
      },
      {
        envVar: "GOOGLE_CLOUD_LOCATION",
        label: "Location",
        secret: false,
        required: false,
        placeholder: "us-central1",
        hint: "Required with Application Default Credentials; `global` is accepted.",
      },
      {
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
        label: "Service-account key file (optional)",
        secret: false,
        required: false,
        placeholder: "/path/to/service-account.json",
      },
    ],
  },
  {
    ...simple("cloudflare-ai-gateway", "Cloudflare AI Gateway", "CLOUDFLARE_API_KEY", {
      keysUrl: "https://dash.cloudflare.com/profile/api-tokens",
      keyLabel: "Cloudflare API token",
      hint: "Routes OpenAI, Anthropic and Workers AI models through your Cloudflare AI Gateway (caching, logging, rate limits). Needs the account id and gateway id.",
    }),
    extraEnv: [
      {
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account id",
        secret: false,
        required: true,
      },
      {
        envVar: "CLOUDFLARE_GATEWAY_ID",
        label: "Gateway id",
        secret: false,
        required: true,
      },
    ],
  },
  {
    ...simple("cloudflare-workers-ai", "Cloudflare Workers AI", "CLOUDFLARE_API_KEY", {
      keysUrl: "https://dash.cloudflare.com/profile/api-tokens",
      keyLabel: "Cloudflare API token",
      hint: "Open models served by Cloudflare Workers AI. Model ids carry the @cf/ prefix. Needs the account id.",
    }),
    extraEnv: [
      {
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account id",
        secret: false,
        required: true,
      },
    ],
  },
];

const DIRECT_BY_ID = new Map(DIRECT_PROVIDERS.map((p) => [p.id, p] as const));

export function directProvider(providerId: string): DirectProviderDefinition | undefined {
  return DIRECT_BY_ID.get(providerId);
}

export function isDirectProvider(providerId: string): boolean {
  return DIRECT_BY_ID.has(providerId);
}

/** Providers whose usage is a prepaid plan / credit pool (never cap-counted). */
export function isPlanBilledProvider(providerId: string): boolean {
  return DIRECT_BY_ID.get(providerId)?.billingMode === "subscription";
}

/**
 * Every env var a direct provider reads, deduplicated — several providers
 * share one (MOONSHOT_API_KEY, OPENCODE_API_KEY, CLOUDFLARE_*), so the
 * launcher's "any model access configured?" probe and the credential store
 * must key on the variable, not the provider.
 */
export function directProviderEnvVars(): string[] {
  const out = new Set<string>();
  for (const p of DIRECT_PROVIDERS) {
    if (p.keyEnvVar) out.add(p.keyEnvVar);
    for (const field of p.extraEnv) out.add(field.envVar);
  }
  return [...out];
}

/** `anthropic` → `anthropicApiKey`, `cloudflare-ai-gateway` → `cloudflareAiGatewayApiKey`. */
export function providerKeyBodyField(providerId: string): string {
  const camel = providerId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return `${camel}ApiKey`;
}
