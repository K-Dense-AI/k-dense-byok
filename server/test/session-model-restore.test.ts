import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { lastModelInSessionFile } from "../src/agent/session-registry.ts";

function write(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-session-model-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

describe("lastModelInSessionFile", () => {
  it("prefers the latest model_change entry over earlier assistant replies", () => {
    const file = write([
      { type: "session", id: "s1" },
      { type: "message", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-6-astra", content: [] } },
      { type: "model_change", provider: "openrouter", modelId: "deepseek/deepseek-v4-flash" },
    ]);
    expect(lastModelInSessionFile(file)).toEqual({ provider: "openrouter", modelId: "deepseek/deepseek-v4-flash" });
  });

  it("falls back to the last assistant reply's provider/model and skips malformed lines", () => {
    const file = write([
      { type: "model_change", provider: "openrouter", modelId: "old/model" },
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-fable-5-1", content: [] } },
      "{not json",
    ]);
    expect(lastModelInSessionFile(file)).toEqual({ provider: "anthropic", modelId: "claude-fable-5-1" });
  });

  it("returns undefined for an empty, model-less or missing file", () => {
    expect(lastModelInSessionFile(write([{ type: "session", id: "s2" }]))).toBeUndefined();
    expect(lastModelInSessionFile("/nonexistent/session.jsonl")).toBeUndefined();
  });
});
