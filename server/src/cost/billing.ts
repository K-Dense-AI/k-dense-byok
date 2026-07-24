import type { Api, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type BillingMode =
  | "payg"
  | "metered_oauth"
  | "subscription"
  | "local"
  | "compute";

export type LedgerAuthType = AuthType | "local" | "none";

export interface BillingContext {
  provider: string;
  authType: LedgerAuthType;
  billingMode: BillingMode;
}

export function billingCountsTowardBudget(
  billing: Pick<BillingContext, "billingMode">,
): boolean {
  return (
    billing.billingMode === "payg" ||
    billing.billingMode === "metered_oauth" ||
    billing.billingMode === "compute"
  );
}

/**
 * Central billing policy. Unknown combinations are pay-as-you-go by default:
 * over-counting is visible, while under-counting could silently bypass a hard
 * project cap.
 */
export function billingForProvider(
  provider: string,
  authType: LedgerAuthType = "none",
): BillingContext {
  if (provider === "ollama") {
    return { provider, authType: "local", billingMode: "local" };
  }
  if (provider === "modal") {
    return { provider, authType: "none", billingMode: "compute" };
  }
  if (provider === "anthropic" && authType === "oauth") {
    return { provider, authType, billingMode: "metered_oauth" };
  }
  if (
    authType === "oauth" &&
    (provider === "openai-codex" ||
      provider === "github-copilot" ||
      provider === "xai")
  ) {
    return { provider, authType, billingMode: "subscription" };
  }
  return {
    provider,
    authType: authType === "none" ? "api_key" : authType,
    billingMode: "payg",
  };
}

export async function billingForModel(
  model: Model<Api>,
  runtime: Pick<ModelRuntime, "checkAuth">,
): Promise<BillingContext> {
  if (model.provider === "ollama") return billingForProvider("ollama", "local");
  const auth = await runtime.checkAuth(model.provider);
  return billingForProvider(model.provider, auth?.type ?? "none");
}

export function normalizeUsageCost(
  rawCostUsd: number,
  billing: BillingContext,
): { costUsd: number; listPriceUsd?: number } {
  const raw = Number.isFinite(rawCostUsd) ? Math.max(0, rawCostUsd) : 0;
  if (billingCountsTowardBudget(billing)) return { costUsd: raw };
  return raw > 0 ? { costUsd: 0, listPriceUsd: raw } : { costUsd: 0 };
}
