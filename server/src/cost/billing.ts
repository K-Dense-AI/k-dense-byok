import type { Api, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { subscriptionProvider } from "../agent/provider-auth.ts";
import { isPlanBilledProvider } from "../agent/provider-catalog.ts";

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
  // Local model servers only. Both are $0 because the model runs on the user's
  // own hardware — do not extend this branch to a hosted gateway, whose real
  // spend would then be invisible to the project cap.
  if (provider === "ollama" || provider === "openai-compatible") {
    return { provider, authType: "local", billingMode: "local" };
  }
  if (provider === "modal") {
    return { provider, authType: "none", billingMode: "compute" };
  }
  if (provider === "anthropic" && authType === "oauth") {
    return { provider, authType, billingMode: "metered_oauth" };
  }
  // Prepaid plans and credit pools (NVIDIA NIM, the Qwen/Xiaomi token plans,
  // Kimi For Coding): the endpoint draws NVIDIA API credits or a plan quota,
  // not per-token USD, and Pi prices every such model at $0. Like the OAuth
  // subscription providers, tokens (and any Pi-reported list price) are
  // recorded but the spend is external, so it neither counts toward nor is
  // blocked by the project cap — classifying them payg would let an exceeded
  // cap block runs that ledger $0. Whichever credential Pi resolved.
  if (isPlanBilledProvider(provider)) {
    return {
      provider,
      authType: authType === "none" ? "api_key" : authType,
      billingMode: "subscription",
    };
  }
  // OAuth subscriptions (ChatGPT, Copilot, xAI, Kimi Code): provider-managed
  // limits. OpenRouter/Radius OAuth logins are `payg` in provider-auth.ts and
  // fall through to the default — they merely stand in for an API key.
  if (authType === "oauth" && subscriptionProvider(provider)?.billingMode === "subscription") {
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
  if (model.provider === "ollama" || model.provider === "openai-compatible") {
    return billingForProvider(model.provider, "local");
  }
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
