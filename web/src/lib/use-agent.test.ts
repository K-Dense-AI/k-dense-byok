import { describe, expect, it } from "vitest";
import { buildRunBody } from "@/lib/use-agent";

describe("buildRunBody", () => {
  it("includes thinkingLevel when provided — including an explicit 'off'", () => {
    expect(
      buildRunBody({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" }),
    ).toEqual({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" });
    // Pi sessions remember the level across runs; "off" must reach the wire to reset it.
    expect(buildRunBody({ message: "hi", thinkingLevel: "off" })).toEqual({
      message: "hi",
      thinkingLevel: "off",
    });
  });

  it("omits thinkingLevel when absent", () => {
    expect(buildRunBody({ message: "hi" })).toEqual({ message: "hi" });
  });

  it("keeps computeTarget behavior: sent when set, omitted for 'local'", () => {
    expect(buildRunBody({ message: "hi", computeTarget: "h100" })).toEqual({
      message: "hi",
      computeTarget: "h100",
    });
    expect(buildRunBody({ message: "hi", computeTarget: "local" })).toEqual({ message: "hi" });
  });

  it("includes fusionConfig when provided", () => {
    const fusionConfig = { plugins: [] };
    expect(buildRunBody({ message: "hi", model: "fusion/x", fusionConfig })).toEqual({
      message: "hi",
      model: "fusion/x",
      fusionConfig,
    });
  });
});
