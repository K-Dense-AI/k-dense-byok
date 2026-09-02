import type { Api, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openAICompatibleBillingMode } from "../config.ts";

export type BillingMode =
  | "payg"
  | "metered_oauth"
  | "subscription"
  | "external"
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
  if (provider === "openai-compatible") {
    const mode =
      authType === "none"
        ? openAICompatibleBillingMode()
        : authType === "local"
          ? "local"
          : "external";
    return mode === "local"
      ? { provider, authType: "local", billingMode: "local" }
      : {
          provider,
          authType: authType === "none" ? "api_key" : authType,
          billingMode: "external",
        };
  }
  if (provider === "modal") {
    return { provider, authType: "none", billingMode: "compute" };
  }
  if (provider === "anthropic" && authType === "oauth") {
    return { provider, authType, billingMode: "metered_oauth" };
  }
  // NVIDIA NIM (build.nvidia.com) bills against NVIDIA-managed API credits,
  // not per-token USD — Pi's NIM catalogue prices every model at $0. Like the
  // OAuth subscription providers, tokens (and any Pi-reported list price) are
  // recorded but the spend is external, so it neither counts toward nor is
  // blocked by the project cap.
  if (provider === "nvidia") {
    return {
      provider,
      authType: authType === "none" ? "api_key" : authType,
      billingMode: "subscription",
    };
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
  if (model.provider === "openai-compatible") {
    return billingForProvider(
      "openai-compatible",
      openAICompatibleBillingMode() === "external" ? "api_key" : "local",
    );
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
