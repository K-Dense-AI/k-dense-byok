import { beforeEach, describe, expect, it } from "vitest";
import {
  contextWindowFromModelEntry,
  noteOpenAICompatibleModels,
  openAICompatibleContextWindow,
  resetOpenAICompatibleContextWindows,
} from "../src/agent/openai-compatible-context.ts";
import { OPENAI_COMPATIBLE_CONTEXT_WINDOW } from "../src/config.ts";

// Read from config rather than hardcoded: the fallback is env-configurable, and
// these tests assert "falls back", not "falls back to 32768".
const DEFAULT_WINDOW = OPENAI_COMPATIBLE_CONTEXT_WINDOW;

beforeEach(() => resetOpenAICompatibleContextWindows());

describe("contextWindowFromModelEntry", () => {
  // Shape captured from a live `llama-server` router listing.
  it("reads llama.cpp's served meta.n_ctx", () => {
    expect(
      contextWindowFromModelEntry({
        id: "DeepSeek-V4-Flash:Q4_K_XL",
        meta: { n_ctx: 131_072, n_ctx_train: 1_048_576, n_vocab: 129_280 },
      }),
    ).toBe(131_072);
  });

  // The whole point: n_ctx_train is the model's trained context, not what the
  // server allocated. Using it would overcommit this model by 8x.
  it("never falls back to n_ctx_train", () => {
    expect(
      contextWindowFromModelEntry({ id: "m", meta: { n_ctx_train: 1_048_576 } }),
    ).toBeUndefined();
  });

  it("reads vLLM's max_model_len", () => {
    expect(
      contextWindowFromModelEntry({ id: "m", max_model_len: 65_536 }),
    ).toBe(65_536);
  });

  it("returns undefined for models the server has not loaded", () => {
    // A router lists every configured preset; only live ones carry `meta`.
    expect(contextWindowFromModelEntry({ id: "Fara1.5-27B" })).toBeUndefined();
  });

  it("rejects malformed and out-of-range values", () => {
    for (const meta of [
      { n_ctx: 0 },
      { n_ctx: -1 },
      { n_ctx: 512 },
      { n_ctx: "131072" },
      { n_ctx: Number.NaN },
      { n_ctx: 1e12 },
    ]) {
      expect(contextWindowFromModelEntry({ id: "m", meta })).toBeUndefined();
    }
    expect(contextWindowFromModelEntry(null)).toBeUndefined();
    expect(contextWindowFromModelEntry("nope")).toBeUndefined();
  });
});

describe("openAICompatibleContextWindow", () => {
  it("defaults when nothing has been discovered", () => {
    expect(openAICompatibleContextWindow("unknown")).toBe(DEFAULT_WINDOW);
  });

  it("returns per-model windows, defaulting only the unreported ones", () => {
    noteOpenAICompatibleModels([
      { id: "big", meta: { n_ctx: 131_072 } },
      { id: "embed", meta: { n_ctx: 8_192 } },
      { id: "unloaded" },
    ]);
    expect(openAICompatibleContextWindow("big")).toBe(131_072);
    expect(openAICompatibleContextWindow("embed")).toBe(8_192);
    expect(openAICompatibleContextWindow("unloaded")).toBe(DEFAULT_WINDOW);
  });

  it("keeps the last known window when a model stops reporting one", () => {
    noteOpenAICompatibleModels([{ id: "big", meta: { n_ctx: 131_072 } }]);
    noteOpenAICompatibleModels([{ id: "big" }]); // unloaded by the router
    expect(openAICompatibleContextWindow("big")).toBe(131_072);
  });

  it("ignores entries without a usable id", () => {
    expect(() =>
      noteOpenAICompatibleModels([{ meta: { n_ctx: 8_192 } }, { id: "  " }, null]),
    ).not.toThrow();
  });
});
