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
  error?: string;
}

let discovery: Discovery;

beforeEach(() => {
  discovery = { configured: false, models: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/edenai/models")) {
      return json({
        configured: discovery.configured,
        ...(discovery.error ? { error: discovery.error } : {}),
        // Entries arrive pre-shaped from the backend (edenaiModelForClient).
        models: discovery.models.map((m) => ({
          id: `edenai/${m.id}`,
          label: m.label,
          provider: "Eden AI",
          sourceId: "edenai",
          sourceLabel: "Eden AI",
          tier: "budget",
          context_length: 128_000,
          pricing: { prompt: 0.15, completion: 0.6 },
          modality: "text->text",
          description: `Eden AI gateway → ${m.id}`,
          reasoning: false,
          billingMode: "payg",
          available: true,
        })),
      });
    }
    if (url.endsWith("/nvidia/models")) return json({ configured: false, models: [] });
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

describe("useModels — Eden AI", () => {
  it("merges discovered Eden models as cap-counted payg entries", async () => {
    discovery = {
      configured: true,
      models: [{ id: "openai/gpt-4o-mini", label: "gpt-4o-mini" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.edenaiModels).toHaveLength(1));

    expect(result.current.edenaiModels[0]).toMatchObject({
      id: "edenai/openai/gpt-4o-mini",
      sourceId: "edenai",
      sourceLabel: "Eden AI",
      billingMode: "payg",
      available: true,
    });
    expect(result.current.edenaiConfigured).toBe(true);
    expect(result.current.edenaiError).toBeNull();
    // Also present in the merged list the picker actually renders.
    expect(
      result.current.models.some((m) => m.id === "edenai/openai/gpt-4o-mini"),
    ).toBe(true);
  });

  // Eden ids often carry more than one slash; the ref must survive whole.
  it("keeps a multi-slash Eden id intact in the merged list", async () => {
    discovery = {
      configured: true,
      models: [
        {
          id: "fireworks_ai/accounts/fireworks/models/glm-5p3",
          label: "glm-5p3",
        },
      ],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.edenaiModels).toHaveLength(1));

    expect(result.current.edenaiModels[0].id).toBe(
      "edenai/fireworks_ai/accounts/fireworks/models/glm-5p3",
    );
  });

  it("reports availability as checking until discovery resolves", async () => {
    discovery = {
      configured: true,
      models: [{ id: "openai/gpt-4o-mini", label: "gpt-4o-mini" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    expect(
      result.current.modelAvailability({ id: "edenai/openai/gpt-4o-mini" }),
    ).toBe("checking");

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "edenai/openai/gpt-4o-mini" }),
      ).toBe("available"),
    );
  });

  // The backend resolves any `edenai/<id>`, so a persisted ref that is no
  // longer in the discovered list still runs while the key is configured.
  it("keeps an undiscovered Eden model available while the key is configured", async () => {
    discovery = { configured: true, models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "edenai/vendor/brand-new" }),
      ).toBe("available"),
    );
  });

  it("marks Eden models unavailable and lists none without a key", async () => {
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "edenai/openai/gpt-4o-mini" }),
      ).toBe("unavailable"),
    );
    expect(result.current.edenaiConfigured).toBe(false);
    expect(result.current.models.some((m) => m.id.startsWith("edenai/"))).toBe(false);
  });

  // A configured key whose discovery failed is a distinct state: the picker
  // shows the reason instead of an empty section.
  it("surfaces a discovery error reported alongside an empty list", async () => {
    discovery = {
      configured: true,
      models: [],
      error: "Eden AI model discovery failed (HTTP 401)",
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.edenaiConfigured).toBe(true));

    expect(result.current.edenaiError).toMatch(/HTTP 401/);
    expect(result.current.edenaiModels).toEqual([]);
  });

  it("leaves the OpenRouter catalogue and its availability untouched", async () => {
    discovery = {
      configured: true,
      models: [{ id: "openai/gpt-4o-mini", label: "gpt-4o-mini" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.edenaiModels).toHaveLength(1));

    const openrouter = result.current.models.filter((m) =>
      m.id.startsWith("openrouter/"),
    );
    expect(openrouter.length).toBeGreaterThan(0);
    expect(openrouter.every((m) => m.available !== false)).toBe(true);
    expect(openrouter.every((m) => m.billingMode === "payg")).toBe(true);
  });
});
