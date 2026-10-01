/**
 * One row per model provider for Settings → Providers, joining the two ways a
 * provider can be connected: a Pi OAuth sign-in (GET /model-providers) and an
 * API key / cloud credential (GET /providers + GET /credentials). OpenAI,
 * Anthropic, xAI, Kimi and Meta accept both; OpenRouter's key is managed
 * outside the direct-provider catalogue. Pure, so the merge is unit-testable.
 */

import type { ModelProviderStatus } from "@/lib/use-provider-auth";

export interface DirectProviderField {
  envVar: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  hint?: string;
  isKey: boolean;
  credentialId: string;
  bodyField: string;
}

export interface DirectProviderStatus {
  id: string;
  name: string;
  sectionLabel: string;
  hint: string;
  keysUrl?: string;
  billingMode: "payg" | "subscription";
  billingNote: string;
  oauth: boolean;
  fields: DirectProviderField[];
  configured: boolean;
  authType: "api_key" | "oauth" | null;
  source: string | null;
  modelCount: number;
}

export type CredentialFlags = Record<string, { set: boolean; masked: string | null } | undefined>;

export type ProviderRowStatus = "reauth" | "signed-in" | "api-key" | "external" | "none";

export interface ProviderRow {
  id: string;
  name: string;
  /** Pi OAuth sign-in, when the provider offers one. */
  oauth?: ModelProviderStatus;
  /** API-key / cloud-credential fields, when the provider takes them. */
  direct?: DirectProviderStatus;
  /** OpenRouter only: its key is a managed credential outside the catalogue. */
  openrouterKey?: boolean;
  status: ProviderRowStatus;
  /** Where Pi found a credential that Settings did not write (e.g. AWS profile). */
  source: string | null;
  connected: boolean;
  modelCount: number;
  popular: boolean;
}

/** Shown first in "Add a provider"; everything else sits behind "Show all". */
const POPULAR = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "xai",
  "deepseek",
  "mistral",
  "groq",
];

function rank(id: string): number {
  const index = POPULAR.indexOf(id);
  return index === -1 ? POPULAR.length : index;
}

export function mergeProviderRows(
  oauthProviders: readonly ModelProviderStatus[],
  directProviders: readonly DirectProviderStatus[],
  credentials: CredentialFlags | null,
): ProviderRow[] {
  const oauthById = new Map(oauthProviders.map((provider) => [provider.id, provider] as const));
  const directById = new Map(directProviders.map((provider) => [provider.id, provider] as const));
  // OAuth list first (it carries the subscription order), then the catalogue.
  // OpenRouter always gets a row: its key works even while the OAuth list is
  // unavailable.
  const ids = [
    ...new Set([
      ...oauthProviders.map((provider) => provider.id),
      "openrouter",
      ...directProviders.map((provider) => provider.id),
    ]),
  ];

  const rows = ids.map((id, order): ProviderRow & { order: number } => {
    const oauth = oauthById.get(id);
    const direct = directById.get(id);
    const openrouterKey = id === "openrouter";
    const keyField = direct?.fields.find((field) => field.isKey);
    const keySet = openrouterKey
      ? Boolean(credentials?.openrouter?.set)
      : keyField
        ? Boolean(credentials?.[keyField.credentialId]?.set)
        : false;

    let status: ProviderRowStatus = "none";
    let source: string | null = null;
    if (oauth?.needsReauth) status = "reauth";
    else if (oauth?.connected || direct?.authType === "oauth") status = "signed-in";
    else if (keySet) status = "api-key";
    else if (direct?.configured || oauth?.configured) {
      // Pi resolved a credential Settings did not write: an env var set in the
      // shell, an AWS profile, gcloud ADC, …
      status = "external";
      source = direct?.source ?? oauth?.source ?? null;
    }

    return {
      id,
      name: direct?.name ?? oauth?.name ?? (openrouterKey ? "OpenRouter" : id),
      ...(oauth ? { oauth } : {}),
      ...(direct ? { direct } : {}),
      ...(openrouterKey ? { openrouterKey: true } : {}),
      status,
      source,
      connected: status === "signed-in" || status === "api-key" || status === "external",
      modelCount: Math.max(oauth?.connected ? oauth.modelCount : 0, direct?.configured ? direct.modelCount : 0),
      popular: POPULAR.includes(id),
      order,
    };
  });

  rows.sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order);
  return rows.map(({ order: _order, ...row }) => row);
}

export function providerStatusLabel(row: ProviderRow): string {
  switch (row.status) {
    case "reauth":
      return "Reconnect required";
    case "signed-in":
      return "Signed in";
    case "api-key":
      return "API key set";
    case "external":
      return row.source ? `Configured via ${row.source}` : "Configured";
    default:
      return "Not connected";
  }
}
