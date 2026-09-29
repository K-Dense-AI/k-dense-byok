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

interface Scenario {
  openrouter: boolean;
  ollama: boolean;
  directConfigured: boolean;
  oauthConnected: boolean;
}

let scenario: Scenario;

beforeEach(() => {
  scenario = { openrouter: false, ollama: false, directConfigured: false, oauthConnected: false };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/openai-compatible/models")) return json({ available: false, configured: false, models: [] });
    if (url.endsWith("/ollama/models")) return json({ available: scenario.ollama, models: [] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: scenario.openrouter } });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    if (url.endsWith("/model-providers")) {
      return json({
        providers: [
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            accountLabel: "GitHub Copilot",
            billingMode: "subscription",
            billingNote: "",
            connected: scenario.oauthConnected,
            credentialType: scenario.oauthConnected ? "oauth" : null,
            source: null,
            loginLabel: null,
            modelCount: 0,
          },
        ],
      });
    }
    if (url.endsWith("/providers/models")) {
      return json({ providers: [{ id: "groq", configured: scenario.directConfigured }], models: [] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModels — hasAnyModelAccess", () => {
  it("is false once every probe answered and nothing is usable", async () => {
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.hasAnyModelAccess).toBe(false));
  });

  it.each([
    ["an OpenRouter key", { openrouter: true }],
    ["a running Ollama", { ollama: true }],
    ["a configured direct provider", { directConfigured: true }],
    ["a connected subscription", { oauthConnected: true }],
  ] as const)("is true with %s", async (_label, patch) => {
    scenario = { ...scenario, ...patch };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.hasAnyModelAccess).toBe(true));
  });
});
