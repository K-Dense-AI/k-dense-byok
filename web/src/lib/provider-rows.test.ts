import { describe, expect, it } from "vitest";
import { mergeProviderRows, providerStatusLabel, type DirectProviderStatus } from "@/lib/provider-rows";
import type { ModelProviderStatus } from "@/lib/use-provider-auth";

function oauth(id: string, overrides: Partial<ModelProviderStatus> = {}): ModelProviderStatus {
  return {
    id,
    name: id,
    accountLabel: `${id} account`,
    billingMode: "subscription",
    billingNote: "",
    connected: false,
    credentialType: null,
    source: null,
    loginLabel: null,
    modelCount: 0,
    ...overrides,
  };
}

function direct(id: string, overrides: Partial<DirectProviderStatus> = {}): DirectProviderStatus {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    sectionLabel: id,
    hint: "",
    billingMode: "payg",
    billingNote: "",
    oauth: false,
    fields: [
      {
        envVar: `${id.toUpperCase()}_API_KEY`,
        label: "API key",
        secret: true,
        required: true,
        isKey: true,
        credentialId: id,
        bodyField: `${id}ApiKey`,
      },
    ],
    configured: false,
    authType: null,
    source: null,
    modelCount: 0,
    ...overrides,
  };
}

describe("mergeProviderRows", () => {
  it("joins a sign-in and an API key for the same provider into one row", () => {
    const rows = mergeProviderRows(
      [oauth("anthropic", { name: "Anthropic" })],
      [direct("anthropic", { oauth: true }), direct("groq")],
      {},
    );
    const anthropic = rows.find((row) => row.id === "anthropic")!;
    expect(anthropic.oauth?.id).toBe("anthropic");
    expect(anthropic.direct?.id).toBe("anthropic");
    expect(rows.filter((row) => row.id === "anthropic")).toHaveLength(1);
  });

  it("always has an OpenRouter row driven by its managed key", () => {
    const rows = mergeProviderRows([], [], { openrouter: { set: true, masked: "sk-…1" } });
    const openrouter = rows.find((row) => row.id === "openrouter")!;
    expect(openrouter.name).toBe("OpenRouter");
    expect(openrouter.openrouterKey).toBe(true);
    expect(openrouter.status).toBe("api-key");
    expect(openrouter.connected).toBe(true);
  });

  it("derives status from the strongest credential", () => {
    const rows = mergeProviderRows(
      [
        oauth("openai", { connected: true, modelCount: 4 }),
        oauth("xai", { needsReauth: true }),
      ],
      [
        direct("openai", { configured: true, authType: "oauth", modelCount: 3 }),
        direct("groq", { configured: true, authType: "api_key" }),
        direct("bedrock", { configured: true, authType: "api_key", source: "AWS profile" }),
        direct("mistral"),
      ],
      { groq: { set: true, masked: "gsk_…" } },
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("openai")!.status).toBe("signed-in");
    expect(byId.get("openai")!.modelCount).toBe(4);
    expect(byId.get("xai")!.status).toBe("reauth");
    expect(byId.get("xai")!.connected).toBe(false);
    expect(byId.get("groq")!.status).toBe("api-key");
    expect(providerStatusLabel(byId.get("bedrock")!)).toBe("Configured via AWS profile");
    expect(byId.get("mistral")!.status).toBe("none");
  });

  it("puts popular providers first", () => {
    const rows = mergeProviderRows([], [direct("zai"), direct("anthropic"), direct("groq")], {});
    expect(rows.map((row) => row.id)).toEqual(["openrouter", "anthropic", "groq", "zai"]);
    expect(rows.find((row) => row.id === "zai")!.popular).toBe(false);
  });

  it("recognizes an OpenRouter key stored in Pi rather than .env", () => {
    const rows = mergeProviderRows([
      oauth("openrouter", { configured: true, credentialType: "api_key", source: "stored credential" }),
    ], [], { openrouter: { set: false, masked: null } });
    expect(rows[0].connected).toBe(true);
    expect(providerStatusLabel(rows[0])).toBe("Configured via stored credential");
  });
});
