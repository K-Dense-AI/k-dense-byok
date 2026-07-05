import { describe, expect, it } from "vitest";
import { parseThinkingLevel, THINKING_LEVELS } from "../src/agent/thinking.ts";

describe("parseThinkingLevel", () => {
  it("accepts every Pi level", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    for (const level of THINKING_LEVELS) {
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(parseThinkingLevel("ultra")).toBeUndefined();
    expect(parseThinkingLevel("OFF")).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel(null)).toBeUndefined();
    expect(parseThinkingLevel(3)).toBeUndefined();
    expect(parseThinkingLevel({ level: "high" })).toBeUndefined();
  });
});
