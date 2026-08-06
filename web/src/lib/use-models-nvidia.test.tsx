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
  configured: boolean;
  models: { id: string; label: string }[];
}

let discovery: Discovery;

beforeEach(() => {
  discovery = { configured: false, models: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/nvidia/models")) {
      return json({
        configured: discovery.configured,
        // Entries arrive pre-shaped from the backend (nvidiaModelForClient).
        models: discovery.models.map((m) => ({
          id: `nvidia/${m.id}`,
          label: m.label,
          provider: "NVIDIA",
          sourceId: "nvidia",
          sourceLabel: "NVIDIA NIM",
          tier: "budget",
          context_length: 131_072,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description: "NVIDIA NIM (build.nvidia.com) via NVIDIA API credits",
          reasoning: true,
          billingMode: "subscription",
          available: true,
        })),
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

describe("useModels — NVIDIA NIM", () => {
  it("merges discovered NIM models as external-billed entries", async () => {
    discovery = {
      configured: true,
      models: [
        {
          id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
          label: "Llama 3.3 Nemotron Super 49B v1.5",
        },
      ],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.nvidiaModels).toHaveLength(1));

    expect(result.current.nvidiaModels[0]).toMatchObject({
      id: "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
      sourceId: "nvidia",
      sourceLabel: "NVIDIA NIM",
      billingMode: "subscription",
      available: true,
    });
    expect(result.current.nvidiaConfigured).toBe(true);
    // Also present in the merged list the picker actually renders.
    expect(
      result.current.models.some(
        (m) => m.id === "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
      ),
    ).toBe(true);
  });

  it("reports availability as checking until discovery resolves", async () => {
    discovery = {
      configured: true,
      models: [{ id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    expect(
      result.current.modelAvailability({ id: "nvidia/meta/llama-3.3-70b-instruct" }),
    ).toBe("checking");

    await waitFor(() =>
      expect(
        result.current.modelAvailability({
          id: "nvidia/meta/llama-3.3-70b-instruct",
        }),
      ).toBe("available"),
    );
  });

  // A NIM model absent from Pi's catalogue still runs (the backend
  // synthesizes it), so a configured key keeps persisted refs usable.
  it("keeps an uncatalogued model available while the key is configured", async () => {
    discovery = { configured: true, models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "nvidia/vendor/brand-new" }),
      ).toBe("available"),
    );
  });

  it("marks NIM models unavailable and lists none without a key", async () => {
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "nvidia/meta/llama-3.3-70b-instruct" }),
      ).toBe("unavailable"),
    );
    expect(result.current.nvidiaConfigured).toBe(false);
    expect(result.current.models.some((m) => m.id.startsWith("nvidia/"))).toBe(false);
  });
});
