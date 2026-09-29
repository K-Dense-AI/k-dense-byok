/**
 * Project-wide specialist model (`subagents.defaultModel` in
 * sandbox/.pi/settings.json): the writer and GET/PUT /agents/defaults.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { setSubagentDefaultModel, settingsPinnedModels } from "../src/agent/agent-files.ts";
import { piSettingsPath, readPiSettings, writePiSettings } from "../src/agent/capability-state.ts";
import { buildApp } from "../src/index.ts";

const app = await buildApp();
const PROJECT = "specialist-defaults";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  createProject({ name: "Specialist defaults", projectId: PROJECT });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

const paths = () => resolvePaths(PROJECT);
const headers = { "x-project-id": PROJECT, "content-type": "application/json" };

describe("setSubagentDefaultModel", () => {
  it("sets and clears the key while preserving every other setting", () => {
    writePiSettings(paths(), {
      packages: ["npm:pi-web-access"],
      subagents: { forceTopLevelAsync: true, agentOverrides: { scout: { disabled: true } } },
    });

    expect(setSubagentDefaultModel(paths(), " openrouter/openai/gpt-5.5 ")).toBe(true);
    expect(readPiSettings(paths())).toEqual({
      packages: ["npm:pi-web-access"],
      subagents: {
        forceTopLevelAsync: true,
        agentOverrides: { scout: { disabled: true } },
        defaultModel: "openrouter/openai/gpt-5.5",
      },
    });
    expect(settingsPinnedModels(paths()).defaultModel).toBe("openrouter/openai/gpt-5.5");

    // pi-subagents throws on an empty string, so "" deletes like null does.
    expect(setSubagentDefaultModel(paths(), "")).toBe(true);
    expect((readPiSettings(paths()).subagents as Record<string, unknown>).defaultModel).toBeUndefined();
    expect(setSubagentDefaultModel(paths(), "ollama/llama3")).toBe(true);
    expect(setSubagentDefaultModel(paths(), null)).toBe(true);
    expect(readPiSettings(paths())).toEqual({
      packages: ["npm:pi-web-access"],
      subagents: { forceTopLevelAsync: true, agentOverrides: { scout: { disabled: true } } },
    });
  });

  it("does not create a settings file just to clear an absent key", () => {
    fs.rmSync(piSettingsPath(paths()), { force: true });
    expect(setSubagentDefaultModel(paths(), null)).toBe(true);
    expect(fs.existsSync(piSettingsPath(paths()))).toBe(false);
  });

  it("refuses to rewrite a malformed settings file", () => {
    fs.mkdirSync(path.dirname(piSettingsPath(paths())), { recursive: true });
    for (const content of ["{not json", "[]"]) {
      fs.writeFileSync(piSettingsPath(paths()), content);
      expect(setSubagentDefaultModel(paths(), "openrouter/openai/gpt-5.5")).toBe(false);
      expect(fs.readFileSync(piSettingsPath(paths()), "utf-8")).toBe(content);
    }
  });
});

describe("GET/PUT /agents/defaults", () => {
  const get = () => app.inject({ url: "/agents/defaults", headers });
  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: "/agents/defaults", headers, payload: payload as object });

  it("round-trips the default model", async () => {
    expect((await get()).json()).toEqual({ defaultModel: null });

    const saved = await put({ defaultModel: "openrouter/anthropic/claude-sonnet-5" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ defaultModel: "openrouter/anthropic/claude-sonnet-5" });
    expect((await get()).json()).toEqual({ defaultModel: "openrouter/anthropic/claude-sonnet-5" });

    const cleared = await put({ defaultModel: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ defaultModel: null });
    expect(settingsPinnedModels(paths()).defaultModel).toBeUndefined();
  });

  it("is project-scoped", async () => {
    createProject({ name: "Other", projectId: "specialist-other" });
    await put({ defaultModel: "openrouter/openai/gpt-5.5" });
    const other = await app.inject({ url: "/agents/defaults", headers: { "x-project-id": "specialist-other" } });
    expect(other.json()).toEqual({ defaultModel: null });
  });

  it.each([
    [{}, /defaultModel must be/],
    [{ defaultModel: 42 }, /defaultModel must be/],
    [{ defaultModel: "gpt-5" }, /<provider>\/<model-id>/],
    [{ defaultModel: "openrouter/openai/gpt 5" }, /no spaces/],
    [{ defaultModel: "fusion/lab-panel" }, /Fusion/],
    [{ defaultModel: "anthropic/not-a-real-model" }, /Unknown specialist default model/],
  ])("answers 400 for %j and writes nothing", async (payload, message) => {
    const res = await put(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(message);
    expect(settingsPinnedModels(paths()).defaultModel).toBeUndefined();
  });

  it("answers 409 when settings.json is malformed", async () => {
    fs.mkdirSync(path.dirname(piSettingsPath(paths())), { recursive: true });
    fs.writeFileSync(piSettingsPath(paths()), "{broken");
    const res = await put({ defaultModel: "openrouter/openai/gpt-5.5" });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/not valid JSON/);
    expect(fs.readFileSync(piSettingsPath(paths()), "utf-8")).toBe("{broken");
  });

  it("leaves the per-agent routes working", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/agents/my-reviewer",
      headers,
      payload: { description: "reviews", systemPrompt: "Review carefully." },
    });
    expect(saved.statusCode).toBe(200);
    const listed = (await app.inject({ url: "/agents", headers })).json();
    expect(listed.agents.map((a: { name: string }) => a.name)).toContain("my-reviewer");
  });
});
