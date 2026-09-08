import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Discovery results are memoized in module scope, so each test loads the hook
// fresh rather than racing the 2s cache window.
async function loadHook() {
  vi.resetModules();
  return (await import("./use-models")).useModels;
}

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface Discovery {
  /** Direct provider ids the backend resolved a credential for. */
  configured: string[];
  models: { id: string; label: string; provider?: string }[];
}

const KNOWN_DIRECT = ["nvidia", "groq", "anthropic"];

let discovery: Discovery;

beforeEach(() => {
  discovery = { configured: [], models: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/providers/models")) {
      return json({
        providers: KNOWN_DIRECT.map((id) => ({
          id,
          configured: discovery.configured.includes(id),
        })),
        // Entries arrive pre-shaped from the backend (directModelForClient).
        models: discovery.models.map((m) => {
          const provider = m.provider ?? "nvidia";
          const nvidia = provider === "nvidia";
          return {
            id: `${provider}/${m.id}`,
            label: m.label,
            provider: nvidia ? "NVIDIA" : provider,
            sourceId: provider,
            sourceLabel: nvidia ? "NVIDIA NIM" : provider,
            tier: "budget",
            context_length: 131_072,
            pricing: { prompt: nvidia ? 0 : 1, completion: nvidia ? 0 : 1 },
            modality: "text->text",
            description: nvidia
              ? "NVIDIA NIM (build.nvidia.com) via NVIDIA API credits"
              : `${provider} (direct API key)`,
            reasoning: true,
            billingMode: nvidia ? "subscription" : "payg",
            available: true,
          };
        }),
      });
    }
    if (url.endsWith("/ollama/models")) return json({ available: false, models: [] });
    if (url.endsWith("/openai-compatible/models")) {
      return json({ available: false, configured: false, models: [] });
    }
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    if (url.endsWith("/model-providers")) return json({ providers: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModels — direct API-key providers", () => {
  it("merges discovered NIM models as external-billed entries", async () => {
    discovery = {
      configured: ["nvidia"],
      models: [
        {
          id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
          label: "Llama 3.3 Nemotron Super 49B v1.5",
        },
      ],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.directProviderModels).toHaveLength(1));

    expect(result.current.directProviderModels[0]).toMatchObject({
      id: "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
      sourceId: "nvidia",
      sourceLabel: "NVIDIA NIM",
      billingMode: "subscription",
      available: true,
    });
    expect(result.current.configuredDirectProviders).toEqual(["nvidia"]);
    // Also present in the merged list the picker actually renders.
    expect(
      result.current.models.some(
        (m) => m.id === "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
      ),
    ).toBe(true);
  });

  it("merges pay-as-you-go direct providers with their real pricing", async () => {
    discovery = {
      configured: ["groq"],
      models: [{ id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", provider: "groq" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.directProviderModels).toHaveLength(1));
    expect(result.current.directProviderModels[0]).toMatchObject({
      id: "groq/llama-3.3-70b-versatile",
      sourceId: "groq",
      billingMode: "payg",
      pricing: { prompt: 1, completion: 1 },
    });
  });

  it("reports availability as checking until discovery resolves", async () => {
    discovery = {
      configured: ["nvidia"],
      models: [{ id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    expect(
      result.current.modelAvailability({ id: "nvidia/meta/llama-3.3-70b-instruct" }),
    ).toBe("checking");

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "nvidia/meta/llama-3.3-70b-instruct" }),
      ).toBe("available"),
    );
  });

  it("keeps a persisted model absent from the catalogue available while the provider is configured", async () => {
    // NIM ids newer than Pi's snapshot are synthesized server-side; only a
    // missing credential should mark them disconnected.
    discovery = { configured: ["nvidia"], models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.modelAvailability({ id: "nvidia/private/vendor/new" })).toBe(
        "available",
      ),
    );
  });

  it("marks models of a known but unconfigured provider unavailable", async () => {
    discovery = { configured: [], models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.modelAvailability({ id: "groq/llama-3.3-70b-versatile" })).toBe(
        "unavailable",
      ),
    );
    expect(result.current.configuredDirectProviders).toEqual([]);
    expect(result.current.directProviderModels).toEqual([]);
  });

  it("re-probes direct providers when Settings changes a key", async () => {
    discovery = { configured: [], models: [] };
    const useModels = await loadHook();
    const { PROVIDER_AUTH_CHANGED_EVENT } = await import("./use-provider-auth");
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.configuredDirectProviders).toEqual([]));

    discovery = {
      configured: ["nvidia"],
      models: [{ id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }],
    };
    window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT));

    await waitFor(() => expect(result.current.configuredDirectProviders).toEqual(["nvidia"]));
    expect(result.current.directProviderModels).toHaveLength(1);
  });
});
