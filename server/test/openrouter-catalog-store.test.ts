/**
 * Pi 1.2+ restores a saved OpenRouter list from `models-store.json` in place
 * of the built-in catalog whatever its age. Kady drops a list saved before the
 * installed catalog so a Pi upgrade is not undone by a stale cache.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { pruneStaleOpenRouterCatalog } from "../src/agent/models.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function agentDir(store?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-models-store-"));
  dirs.push(dir);
  if (store !== undefined) {
    fs.writeFileSync(path.join(dir, "models-store.json"), typeof store === "string" ? store : JSON.stringify(store));
  }
  return dir;
}

const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "models-store.json"), "utf8"));
const BUILT = Date.parse("2026-10-15T00:00:00Z");
const stub = (provider: string, id: string) => ({ id, name: id, provider, api: "openai-completions", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, type: "chat" });

describe("pruneStaleOpenRouterCatalog", () => {
  it("drops an OpenRouter list saved before the installed catalog and keeps other providers", () => {
    const nvidia = { models: [], checkedAt: 1 };
    const dir = agentDir({ openrouter: { models: [stub("openrouter", "a/b")], checkedAt: BUILT - 1 }, nvidia });
    expect(pruneStaleOpenRouterCatalog(dir, BUILT)).toBe(true);
    expect(read(dir)).toEqual({ nvidia });
  });

  it("keeps a list saved after the installed catalog", () => {
    const store = { openrouter: { models: [], checkedAt: BUILT + 1 } };
    const dir = agentDir(store);
    expect(pruneStaleOpenRouterCatalog(dir, BUILT)).toBe(false);
    expect(read(dir)).toEqual(store);
  });

  it("treats a list without a usable timestamp as stale", () => {
    const dir = agentDir({ openrouter: { models: [] } });
    expect(pruneStaleOpenRouterCatalog(dir, BUILT)).toBe(true);
    expect(read(dir)).toEqual({});
  });

  it("leaves a missing, malformed or OpenRouter-free store alone", () => {
    expect(pruneStaleOpenRouterCatalog(agentDir(), BUILT)).toBe(false);
    const malformed = agentDir("{not json");
    expect(pruneStaleOpenRouterCatalog(malformed, BUILT)).toBe(false);
    expect(fs.readFileSync(path.join(malformed, "models-store.json"), "utf8")).toBe("{not json");
    expect(pruneStaleOpenRouterCatalog(agentDir({ nvidia: { models: [] } }), BUILT)).toBe(false);
  });

  it("lets the installed catalog win in a real runtime", async () => {
    const stale = { openrouter: { models: [stub("openrouter", "vendor/only-in-stale-list")], checkedAt: getBuiltinModelDataGeneratedAt()! - 1 } };
    const load = async (dir: string) => {
      const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), allowModelNetwork: false });
      return new ModelRegistry(runtime).getAll().filter((m) => m.provider === "openrouter").map((m) => m.id);
    };
    const before = await load(agentDir(stale));
    expect(before).toEqual(["vendor/only-in-stale-list"]);
    const dir = agentDir(stale);
    pruneStaleOpenRouterCatalog(dir);
    const after = await load(dir);
    expect(after).toContain("openai/gpt-6-astra");
    expect(after).not.toContain("vendor/only-in-stale-list");
  });
});
