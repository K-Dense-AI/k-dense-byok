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
  available: boolean;
  configured: boolean;
  billingMode: "local" | "external";
  models: { id: string; label: string }[];
}

let discovery: Discovery;

beforeEach(() => {
  discovery = { available: false, configured: false, billingMode: "local", models: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/openai-compatible/models")) {
      return json({
        available: discovery.available,
        configured: discovery.configured,
        billingMode: discovery.billingMode,
        models: discovery.models.map((m) => ({
          id: `openai-compatible/${m.id}`,
          label: m.label,
          provider: "OpenAI-Compatible",
          tier: "budget",
          context_length: 0,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description:
            discovery.billingMode === "external"
              ? `OpenAI-compatible endpoint model: ${m.id} (externally billed)`
              : `Local OpenAI-compatible model: ${m.id}`,
          billingMode: discovery.billingMode,
        })),
      });
    }
    if (url.endsWith("/ollama/models")) return json({ available: false, models: [] });
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

describe("useModels — local OpenAI-compatible server", () => {
  it("merges discovered models as free, non-reasoning, local-billed entries", async () => {
    discovery = {
      available: true,
      configured: true,
      billingMode: "local",
      models: [{ id: "qwen/qwen3-8b", label: "qwen/qwen3-8b" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(result.current.openaiCompatibleModels).toHaveLength(1),
    );

    const model = result.current.openaiCompatibleModels[0];
    expect(model).toMatchObject({
      id: "openai-compatible/qwen/qwen3-8b",
      sourceId: "openai-compatible",
      sourceLabel: "Local (OpenAI-compatible)",
      billingMode: "local",
      reasoning: false,
      available: true,
    });
    // Also present in the merged list the picker actually renders.
    expect(
      result.current.models.some((m) => m.id === "openai-compatible/qwen/qwen3-8b"),
    ).toBe(true);
    expect(result.current.openaiCompatibleAvailable).toBe(true);
  });

  it("groups authenticated proxy models as externally billed endpoints", async () => {
    discovery = {
      available: true,
      configured: true,
      billingMode: "external",
      models: [{ id: "openai/gpt-5", label: "openai/gpt-5" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.openaiCompatibleModels).toHaveLength(1));

    expect(result.current.openaiCompatibleModels[0]).toMatchObject({
      id: "openai-compatible/openai/gpt-5",
      sourceId: "openai-compatible-external",
      sourceLabel: "OpenAI-compatible endpoint",
      billingMode: "external",
      available: true,
    });
    expect(result.current.openaiCompatibleBillingMode).toBe("external");
  });

  it("reports availability as checking until discovery resolves", async () => {
    discovery = {
      available: true,
      configured: true,
      billingMode: "local",
      models: [{ id: "qwen3-8b", label: "qwen3-8b" }],
    };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    expect(
      result.current.modelAvailability({ id: "openai-compatible/qwen3-8b" }),
    ).toBe("checking");

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "openai-compatible/qwen3-8b" }),
      ).toBe("available"),
    );
  });

  // A tab whose selected model was unloaded, or whose server was stopped.
  it("marks a model the server no longer serves as unavailable", async () => {
    discovery = { available: true, configured: true, billingMode: "local", models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        result.current.modelAvailability({ id: "openai-compatible/gone" }),
      ).toBe("unavailable"),
    );
  });

  // Drives whether the picker shows the section at all.
  it("surfaces whether the base URL was explicitly configured", async () => {
    discovery = { available: false, configured: true, billingMode: "local", models: [] };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() => expect(result.current.openaiCompatibleConfigured).toBe(true));
    expect(result.current.openaiCompatibleAvailable).toBe(false);
    expect(result.current.openaiCompatibleModels).toEqual([]);
  });

  it("stays silent when no server is configured or running", async () => {
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/openai-compatible/models"),
        ),
      ).toBe(true),
    );
    expect(result.current.openaiCompatibleConfigured).toBe(false);
    expect(result.current.openaiCompatibleAvailable).toBe(false);
    expect(
      result.current.models.some((m) => m.id.startsWith("openai-compatible/")),
    ).toBe(false);
  });
});
