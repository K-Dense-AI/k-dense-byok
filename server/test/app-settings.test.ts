/**
 * Global app defaults (`<agentDir>/kady-settings.json`): the read/validate/
 * write trio, the GET/PUT /settings/defaults routes, and the saved model's
 * place ahead of DEFAULT_MODEL_PROVIDER / DEFAULT_MODEL_ID.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appSettingsPath,
  readAppDefaults,
  validateAppDefaultsPatch,
  writeAppDefaults,
} from "../src/app-settings.ts";
import { registerAppSettingsRoutes } from "../src/api/app-settings.ts";
import { KADY_PI_AGENT_DIR } from "../src/config.ts";
import { configuredDefaultRef, modelReference, resolveModel } from "../src/agent/models.ts";
import { getModelRegistry } from "../src/agent/session-registry.ts";
import { verifierAgentNames } from "../src/agent/verifier-models.ts";
import { buildApp } from "../src/index.ts";

const app = await buildApp();
afterAll(async () => {
  await app.close();
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-app-settings-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readAppDefaults / writeAppDefaults", () => {
  it("reads a missing file as no defaults", () => {
    expect(readAppDefaults(dir)).toEqual({});
    expect(readAppDefaults(path.join(dir, "does-not-exist"))).toEqual({});
  });

  it("writes, reads back and versions the file", () => {
    const written = writeAppDefaults(
      {
        model: " openrouter/anthropic/claude-opus-5.5 ",
        thinkingLevel: "medium",
        compute: { target: "gpu-a100", gpuCount: 2, gpuFallback: ["gpu-l40s", "gpu-a10g"], cache: "project" },
      },
      dir,
    );
    const expected = {
      model: "openrouter/anthropic/claude-opus-5.5",
      thinkingLevel: "medium",
      compute: { target: "gpu-a100", gpuCount: 2, gpuFallback: ["gpu-l40s", "gpu-a10g"], cache: "project" },
    };
    expect(written).toEqual(expected);
    expect(readAppDefaults(dir)).toEqual(expected);
    const file = JSON.parse(fs.readFileSync(appSettingsPath(dir), "utf-8"));
    expect(file.version).toBe(1);
    expect(file.defaults).toEqual(expected);
  });

  it("leaves absent keys alone, clears null ones, and replaces compute whole", () => {
    writeAppDefaults(
      { model: "ollama/llama3", thinkingLevel: "high", compute: { target: "gpu-a100", gpuCount: 4 } },
      dir,
    );
    expect(writeAppDefaults({ thinkingLevel: null }, dir)).toEqual({
      model: "ollama/llama3",
      compute: { target: "gpu-a100", gpuCount: 4 },
    });
    expect(writeAppDefaults({ compute: { target: "local" } }, dir)).toEqual({
      model: "ollama/llama3",
      compute: { target: "local" },
    });
    expect(writeAppDefaults({ model: null, compute: null }, dir)).toEqual({});
    expect(writeAppDefaults({}, dir)).toEqual({});
  });

  it("preserves unknown top-level keys and future keys under defaults", () => {
    fs.writeFileSync(
      appSettingsPath(dir),
      JSON.stringify({ version: 1, ui: { density: "compact" }, defaults: { futureKey: [1, 2] } }),
    );
    writeAppDefaults({ model: "openrouter/openai/gpt-5.5" }, dir);
    const file = JSON.parse(fs.readFileSync(appSettingsPath(dir), "utf-8"));
    expect(file.ui).toEqual({ density: "compact" });
    expect(file.defaults).toEqual({ futureKey: [1, 2], model: "openrouter/openai/gpt-5.5" });
  });

  it("never rewrites a malformed file", () => {
    for (const content of ["{not json", "[1, 2]", '"a string"']) {
      fs.writeFileSync(appSettingsPath(dir), content);
      expect(readAppDefaults(dir)).toEqual({});
      expect(writeAppDefaults({ model: "openrouter/openai/gpt-5.5" }, dir)).toBeNull();
      expect(fs.readFileSync(appSettingsPath(dir), "utf-8")).toBe(content);
    }
  });

  it("drops hand-edited values the server could not use", () => {
    fs.writeFileSync(
      appSettingsPath(dir),
      JSON.stringify({
        version: 1,
        defaults: {
          model: "fusion/lab-panel",
          thinkingLevel: "maximum",
          compute: { target: "gpu-a100", gpuCount: 99 },
        },
      }),
    );
    expect(readAppDefaults(dir)).toEqual({});
  });
});

describe("validateAppDefaultsPatch", () => {
  it("accepts well-formed patches and nulls", () => {
    for (const patch of [
      {},
      { model: "openrouter/anthropic/claude-opus-5.5" },
      { model: "openai-compatible/qwen/qwen3-8b" },
      { model: null, thinkingLevel: null, compute: null },
      { thinkingLevel: "xhigh" },
      { compute: { target: "local" } },
      { compute: { target: "gpu-h100", gpuCount: 8, gpuFallback: [], cache: "none" } },
      { compute: { target: "gpu-h100", gpuCount: null, gpuFallback: null, cache: null } },
      { verifierModel: "openrouter/anthropic/claude-opus-5.5" },
      { verifierModel: null },
    ]) {
      expect(validateAppDefaultsPatch(patch), JSON.stringify(patch)).toBeNull();
    }
  });

  it.each([
    [null, /JSON object/],
    [[{ model: "x/y" }], /JSON object/],
    [{ theme: "dark" }, /Unknown setting "theme"/],
    [{ model: "" }, /non-empty/],
    [{ model: 42 }, /non-empty/],
    [{ model: "gpt-5" }, /<provider>\/<model-id>/],
    [{ model: "/gpt-5" }, /<provider>\/<model-id>/],
    [{ model: "openrouter/" }, /<provider>\/<model-id>/],
    [{ model: "openrouter/openai/gpt 5" }, /no spaces/],
    [{ model: `openrouter/${"x".repeat(300)}` }, /at most 300/],
    [{ model: "fusion/lab-panel" }, /Fusion/],
    [{ thinkingLevel: "maximum" }, /thinkingLevel must be one of/],
    [{ thinkingLevel: 3 }, /thinkingLevel must be one of/],
    [{ compute: "local" }, /compute must be an object/],
    [{ compute: {} }, /compute\.target/],
    [{ compute: { target: "  " } }, /compute\.target/],
    [{ compute: { target: "x".repeat(101) } }, /at most 100/],
    [{ compute: { target: "local", region: "us" } }, /Unknown compute setting "region"/],
    [{ compute: { target: "gpu", gpuCount: 0 } }, /gpuCount/],
    [{ compute: { target: "gpu", gpuCount: 9 } }, /gpuCount/],
    [{ compute: { target: "gpu", gpuCount: 1.5 } }, /gpuCount/],
    [{ compute: { target: "gpu", gpuFallback: "gpu-a10g" } }, /gpuFallback/],
    [{ compute: { target: "gpu", gpuFallback: Array(9).fill("gpu-a10g") } }, /at most 8/],
    [{ compute: { target: "gpu", gpuFallback: [""] } }, /gpuFallback entries/],
    [{ compute: { target: "gpu", cache: "disk" } }, /compute\.cache/],
    [{ verifierModel: "" }, /verifierModel must be a non-empty/],
    [{ verifierModel: "claude" }, /verifierModel must look like/],
    [{ verifierModel: "fusion/lab-panel" }, /verifierModel cannot be a Fusion/],
  ])("rejects %j", (patch, message) => {
    expect(validateAppDefaultsPatch(patch)).toMatch(message);
  });
});

describe("GET/PUT /settings/defaults", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  async function routes() {
    const app = Fastify();
    apps.push(app);
    await registerAppSettingsRoutes(app, { agentDir: dir });
    return app;
  }
  const put = (app: FastifyInstance, payload: unknown) =>
    app.inject({ method: "PUT", url: "/settings/defaults", payload: payload as object });

  it("round-trips a patch", async () => {
    const app = await routes();
    expect((await app.inject({ url: "/settings/defaults" })).json()).toEqual({ defaults: {}, verifierAgents: verifierAgentNames() });

    const saved = await put(app, {
      model: "openrouter/openai/gpt-5.5",
      thinkingLevel: "low",
      compute: { target: "local" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      defaults: { model: "openrouter/openai/gpt-5.5", thinkingLevel: "low", compute: { target: "local" } },
      verifierAgents: verifierAgentNames(),
    });

    const cleared = await put(app, { thinkingLevel: null });
    expect(cleared.json()).toEqual({
      defaults: { model: "openrouter/openai/gpt-5.5", compute: { target: "local" } },
      verifierAgents: verifierAgentNames(),
    });
    expect((await app.inject({ url: "/settings/defaults" })).json()).toEqual(cleared.json());
  });

  it("answers 400 with a detail and writes nothing on invalid input", async () => {
    const app = await routes();
    for (const payload of [
      { model: "fusion/lab-panel" },
      { thinkingLevel: "maximum" },
      { unknown: true },
      { compute: { target: "gpu", gpuCount: 12 } },
    ]) {
      const res = await put(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(typeof res.json().detail).toBe("string");
    }
    expect(fs.existsSync(appSettingsPath(dir))).toBe(false);
  });

  it("refuses a well-shaped ref that does not resolve", async () => {
    const app = await routes();
    const res = await put(app, { model: "anthropic/not-a-real-model" });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/Unknown default model/);
    expect(fs.existsSync(appSettingsPath(dir))).toBe(false);
  });

  it("saves a meterable default image model and refuses unknown or unpriced ones", async () => {
    const app = await routes();
    const saved = await put(app, { imageModel: "openrouter/google/gemini-3.1-flash-image" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().defaults).toEqual({ imageModel: "openrouter/google/gemini-3.1-flash-image" });
    for (const [imageModel, message] of [
      ["openrouter/google/not-an-image-model", /not an image model/],
      // Priced per image (FLUX) or by input only (MAI): images would ledger as free.
      ["openrouter/black-forest-labs/flux.2-pro", /per-token output price/],
      ["openrouter/microsoft/mai-image-2.6", /per-token output price/],
      ["openrouter/openai/gpt-5.5", /not an image model/],
    ] as const) {
      const res = await put(app, { imageModel });
      expect(res.statusCode, imageModel).toBe(400);
      expect(res.json().detail).toMatch(message);
    }
    expect((await put(app, { imageModel: null })).json().defaults).toEqual({});
  });

  it("lists only meterable image models for the picker, with the built-in order", async () => {
    const app = await routes();
    const body = (await app.inject({ url: "/settings/image-models" })).json() as {
      models: Array<{ ref: string; available: boolean; cost: { output: number } }>;
      builtIn: string[];
    };
    expect(body.builtIn[0]).toBe("openrouter/openai/gpt-image-2.5-sunburst");
    expect(body.models.map((m) => m.ref)).toContain("openrouter/openai/gpt-image-2.5-sunburst");
    expect(body.models.every((m) => m.cost.output > 0)).toBe(true);
    expect(body.models.map((m) => m.ref)).not.toContain("openrouter/black-forest-labs/flux.2-pro");
    // Connected models sort first.
    const firstUnavailable = body.models.findIndex((m) => !m.available);
    if (firstUnavailable >= 0) expect(body.models.slice(firstUnavailable).every((m) => !m.available)).toBe(true);
  });

  it("saves a verifier model only when it resolves, and clears it", async () => {
    const app = await routes();
    const saved = await put(app, { verifierModel: " openrouter/anthropic/claude-opus-5.5 " });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().defaults).toEqual({ verifierModel: "openrouter/anthropic/claude-opus-5.5" });
    expect(readAppDefaults(dir).verifierModel).toBe("openrouter/anthropic/claude-opus-5.5");
    const unknown = await put(app, { verifierModel: "anthropic/not-a-real-model" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().detail).toMatch(/Unknown verifier model/);
    expect((await put(app, { verifierModel: null })).json().defaults).toEqual({});
  });

  it("answers 409 when the file is malformed and leaves it alone", async () => {
    fs.writeFileSync(appSettingsPath(dir), "{broken");
    const app = await routes();
    expect((await app.inject({ url: "/settings/defaults" })).json().defaults).toEqual({});
    const res = await put(app, { thinkingLevel: "high" });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/not valid JSON/);
    expect(fs.readFileSync(appSettingsPath(dir), "utf-8")).toBe("{broken");
  });
});

describe("saved default model precedence", () => {
  const savedFile = appSettingsPath(KADY_PI_AGENT_DIR);
  afterEach(() => {
    fs.rmSync(savedFile, { force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is served by buildApp and outranks the environment default", async () => {
    const environmentDefault = configuredDefaultRef();
    expect(modelReference(resolveModel(undefined, getModelRegistry()))).toBe(environmentDefault);

    const res = await app.inject({
      method: "PUT",
      url: "/settings/defaults",
      payload: { model: "openrouter/openai/gpt-5.5" },
    });
    expect(res.statusCode).toBe(200);
    expect(configuredDefaultRef()).toBe("openrouter/openai/gpt-5.5");
    expect(modelReference(resolveModel(undefined, getModelRegistry()))).toBe("openrouter/openai/gpt-5.5");
    // An explicit ref is never affected.
    expect(modelReference(resolveModel("ollama/llama3", getModelRegistry()))).toBe("ollama/llama3");

    await app.inject({ method: "PUT", url: "/settings/defaults", payload: { model: null } });
    expect(configuredDefaultRef()).toBe(environmentDefault);
  });

  it("beats DEFAULT_MODEL_PROVIDER / DEFAULT_MODEL_ID, which beat the built-in default", async () => {
    vi.stubEnv("DEFAULT_MODEL_PROVIDER", "ollama");
    vi.stubEnv("DEFAULT_MODEL_ID", "llama3");
    vi.resetModules();
    const fresh = await import("../src/agent/models.ts");
    expect(fresh.configuredDefaultRef()).toBe("ollama/llama3");

    writeAppDefaults({ model: "openrouter/anthropic/claude-opus-5.5" }, KADY_PI_AGENT_DIR);
    expect(fresh.configuredDefaultRef()).toBe("openrouter/anthropic/claude-opus-5.5");
  });

  it("falls back to the environment default when the saved one went stale", () => {
    const environmentDefault = configuredDefaultRef();
    // Bypass the route's resolution check, as a removed custom server would.
    writeAppDefaults({ model: "anthropic/not-a-real-model" }, KADY_PI_AGENT_DIR);
    expect(configuredDefaultRef()).toBe("anthropic/not-a-real-model");
    expect(modelReference(resolveModel(undefined, getModelRegistry()))).toBe(environmentDefault);
  });
});
