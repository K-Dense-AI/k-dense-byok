import { act, renderHook, waitFor } from "@testing-library/react";
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
  openrouterResolved?: boolean;
  openrouterNeedsReauth?: boolean;
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
          ...(scenario.openrouterResolved !== undefined ? [{
            id: "openrouter", connected: false, configured: scenario.openrouterResolved,
            needsReauth: scenario.openrouterNeedsReauth ?? false,
            credentialType: "api_key", source: "stored credential", modelCount: 0,
          }] : []),
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
    ["an OpenRouter key stored by Pi", { openrouterResolved: true }],
  ] as const)("is true with %s", async (_label, patch) => {
    scenario = { ...scenario, ...patch };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.hasAnyModelAccess).toBe(true));
  });

  it("does not mark OpenRouter usable when a broken stored login shadows an env key", async () => {
    scenario = { ...scenario, openrouter: true, openrouterResolved: false, openrouterNeedsReauth: true };
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.hasAnyModelAccess).toBe(false));
    expect(result.current.modelAvailability({ id: "openrouter/openai/gpt-4" })).toBe("unavailable");
  });

  it.each([
    ["OpenRouter", "/model-providers", { openrouterResolved: true }],
    ["a direct provider", "/providers/models", { directConfigured: true }],
  ] as const)("refreshes %s after credentials change during an older discovery request", async (_name, endpoint, patch) => {
    const original = fetchMock.getMockImplementation()!;
    let release!: () => void;
    let held = false;
    fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (!held && String(input).endsWith(endpoint)) {
        held = true;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return response;
    });
    const useModels = await loadHook();
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(release).toBeDefined());
    scenario = { ...scenario, ...patch };
    await act(async () => {
      window.dispatchEvent(new Event("kady:provider-auth-changed"));
    });
    await waitFor(() => expect(result.current.hasAnyModelAccess).toBe(true));
    // A late pre-login response must not replace the shared cache either.
    await act(async () => release());
    const another = renderHook(() => useModels());
    await waitFor(() => expect(another.result.current.hasAnyModelAccess).toBe(true));
  });
});
