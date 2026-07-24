import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_AUTH_CHANGED_EVENT,
  type ModelProviderStatus,
} from "./use-provider-auth";
import { useModels } from "./use-models";

const fetchMock = vi.fn<typeof fetch>();

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useModels provider merge", () => {
  let connected = true;

  beforeEach(() => {
    connected = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/ollama/models")) {
        return json({ available: false, models: [] });
      }
      if (url.endsWith("/credentials")) {
        return json({ openrouter: { set: false, masked: null } });
      }
      if (url.endsWith("/model-providers/models")) {
        return json({
          models: connected
            ? [
                {
                  id: "openai-codex/gpt-test",
                  label: "GPT Test",
                  provider: "OpenAI Codex",
                  sourceId: "openai-codex",
                  sourceLabel: "ChatGPT Plus/Pro",
                  tier: "high",
                  context_length: 128_000,
                  pricing: { prompt: 1, completion: 2 },
                  modality: "text->text",
                  description: "test",
                  reasoning: true,
                  billingMode: "subscription",
                  available: true,
                },
              ]
            : [],
        });
      }
      if (url.endsWith("/model-providers")) {
        const provider: ModelProviderStatus = {
          id: "openai-codex",
          name: "OpenAI Codex",
          accountLabel: "ChatGPT Plus/Pro",
          billingMode: "subscription",
          billingNote: "test",
          connected,
          credentialType: connected ? "oauth" : null,
          source: connected ? "OAuth" : null,
          loginLabel: null,
          modelCount: connected ? 1 : 0,
        };
        return json({ providers: [provider] });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges direct provider models and derives live availability", async () => {
    const { result } = renderHook(() => useModels());
    const second = renderHook(() => useModels());
    expect(
      result.current.modelAvailability({ id: "openai-codex/gpt-test" }),
    ).toBe("checking");
    expect(
      result.current.isModelAvailable({ id: "openai-codex/gpt-test" }),
    ).toBe(false);

    await waitFor(() =>
      expect(
        result.current.models.some((model) => model.id === "openai-codex/gpt-test"),
      ).toBe(true),
    );
    expect(
      result.current.isModelAvailable({ id: "openai-codex/gpt-test" }),
    ).toBe(true);
    expect(
      result.current.models.find((model) =>
        model.id.startsWith("openrouter/"),
      )?.available,
    ).toBe(false);
    await waitFor(() =>
      expect(
        second.result.current.models.some(
          (model) => model.id === "openai-codex/gpt-test",
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/model-providers"),
      ),
    ).toHaveLength(1);

    connected = false;
    act(() => window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT)));
    await waitFor(() =>
      expect(
        result.current.isModelAvailable({ id: "openai-codex/gpt-test" }),
      ).toBe(false),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/model-providers"),
      ),
    ).toHaveLength(2);
  });
});
