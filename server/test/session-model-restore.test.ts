import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureProjectExists } from "../src/projects.ts";

import { createSession, disposeProjectSessions, getModelRuntime, getSession, lastModelInSessionFile } from "../src/agent/session-registry.ts";

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

// Exercise the actual Pi construction path: synthesized models do not exist
// in ModelRuntime.getModel(), even though they are valid Kady selections.
const restoreProjectId = "synthetic-model-restore";
afterEach(async () => {
  await disposeProjectSessions(restoreProjectId);
  vi.restoreAllMocks();
});
function savedLocal(provider: string, modelId: string) {
  const paths = ensureProjectExists(restoreProjectId);
  fs.rmSync(paths.sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const manager = SessionManager.create(paths.sandbox, paths.sessionsDir);
  manager.appendModelChange(provider, modelId);
  manager.appendMessage({ role: "user", content: "Saved local conversation", timestamp: Date.now() });
  return { paths, sessionId: manager.getSessionId() };
}
describe("synthetic model restoration", () => {
  it.each(["ollama", "openai-compatible"])("restores a saved %s model for extension-initiated turns", async (provider) => {
    const { paths, sessionId } = savedLocal(provider, "review/local-model");
    expect(getModelRuntime().getModel(provider, "review/local-model")).toBeUndefined();
    const session = await getSession(restoreProjectId, paths, sessionId);
    expect(session?.model).toMatchObject({ provider, id: "review/local-model" });
  }, 30_000);
  it("uses the latest chat's synthetic model for a resident project session", async () => {
    const { paths } = savedLocal("ollama", "review/project-model");
    const session = await createSession(restoreProjectId, paths, { modelPolicy: "project" });
    expect(session.model).toMatchObject({ provider: "ollama", id: "review/project-model" });
  }, 30_000);
  it("still falls back when the stored provider has no configured authentication", async () => {
    const { paths, sessionId } = savedLocal("ollama", "review/disconnected");
    vi.spyOn(getModelRuntime(), "hasConfiguredAuth").mockReturnValue(false);
    const session = await getSession(restoreProjectId, paths, sessionId);
    expect(session?.model?.provider).toBe("openrouter");
  }, 30_000);
});
