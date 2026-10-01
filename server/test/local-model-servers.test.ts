/**
 * Local model-server URLs (OLLAMA_BASE_URL, OPENAI_COMPATIBLE_BASE_URL) are
 * managed credentials: PUT /credentials validates them as http(s) URLs,
 * persists them to `.env`, and re-registers the providers, and config.ts reads
 * them per call so the change applies without a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { setCredentialEnvPathForTests } from "../src/api/credentials.ts";
import {
  PROJECTS_ROOT,
  ollamaBaseUrl,
  openaiCompatibleBaseUrl,
  openaiCompatibleConfigured,
} from "../src/config.ts";
import { registerLocalProviders, resolveModel } from "../src/agent/models.ts";
import { getModelRegistry, getModelRuntime } from "../src/agent/session-registry.ts";
import { buildApp } from "../src/index.ts";

const app = await buildApp();
const envFile = path.join(PROJECTS_ROOT, "local-servers.env");
const VARS = ["OLLAMA_BASE_URL", "OPENAI_COMPATIBLE_BASE_URL"] as const;
const saved = new Map(VARS.map((name) => [name, process.env[name]] as const));

beforeEach(() => {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.writeFileSync(envFile, "");
  setCredentialEnvPathForTests(envFile);
  for (const name of VARS) delete process.env[name];
  registerLocalProviders(getModelRuntime());
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  registerLocalProviders(getModelRuntime());
});

afterAll(async () => {
  setCredentialEnvPathForTests(null);
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function put(body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/credentials",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

const registeredBaseUrl = (providerId: string) =>
  getModelRuntime().getRegisteredProviderConfig(providerId)?.baseUrl;

describe("local model-server URLs", () => {
  it("defaults when unset", async () => {
    expect(ollamaBaseUrl()).toBe("http://localhost:11434");
    expect(openaiCompatibleBaseUrl()).toBe("http://localhost:1234");
    expect(openaiCompatibleConfigured()).toBe(false);
    const status = (await app.inject({ url: "/credentials" })).json();
    expect(status.ollamaBaseUrl).toEqual({ set: false, masked: null });
    expect(status.openaiCompatibleBaseUrl).toEqual({ set: false, masked: null });
  });

  it("saves a URL to .env and process.env, echoes it unmasked, and re-registers", async () => {
    const res = await put({ ollamaBaseUrl: " http://gpu-box:11434/ " });
    expect(res.statusCode).toBe(200);
    expect(res.json().ollamaBaseUrl).toEqual({ set: true, masked: "http://gpu-box:11434/" });
    expect(process.env.OLLAMA_BASE_URL).toBe("http://gpu-box:11434/");
    expect(fs.readFileSync(envFile, "utf-8")).toContain("OLLAMA_BASE_URL=http://gpu-box:11434/");

    expect(ollamaBaseUrl()).toBe("http://gpu-box:11434/");
    expect(registeredBaseUrl("ollama")).toBe("http://gpu-box:11434/v1");
    expect(resolveModel("ollama/llama3", getModelRegistry()).baseUrl).toBe("http://gpu-box:11434/v1");

    const status = (await app.inject({ url: "/credentials" })).json();
    expect(status.ollamaBaseUrl).toEqual({ set: true, masked: "http://gpu-box:11434/" });
  });

  it("flips the OpenAI-compatible provider to configured live", async () => {
    expect(openaiCompatibleConfigured()).toBe(false);
    const res = await put({ openaiCompatibleBaseUrl: "https://127.0.0.1:1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openaiCompatibleBaseUrl).toEqual({ set: true, masked: "https://127.0.0.1:1" });
    expect(openaiCompatibleConfigured()).toBe(true);
    expect(openaiCompatibleBaseUrl()).toBe("https://127.0.0.1:1");
    expect(registeredBaseUrl("openai-compatible")).toBe("https://127.0.0.1:1/v1");
    expect(resolveModel("openai-compatible/qwen/qwen3-8b", getModelRegistry()).baseUrl).toBe(
      "https://127.0.0.1:1/v1",
    );
    // The discovery route sees the new value without a module reload.
    const models = (await app.inject({ url: "/openai-compatible/models" })).json();
    expect(models).toEqual({ available: false, configured: true, models: [] });
  });

  it.each([
    ["localhost:11434", "no scheme"],
    ["ftp://gpu-box:11434", "wrong scheme"],
    ["not a url", "unparseable"],
  ])("rejects %s (%s) and writes nothing", async (value) => {
    const res = await put({ ollamaBaseUrl: value, openaiCompatibleBaseUrl: "http://ok:1234" });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe("OLLAMA_BASE_URL must be an http(s) URL");
    // Validation runs before anything is applied, so the valid field is not written either.
    expect(fs.readFileSync(envFile, "utf-8")).toBe("");
    expect(process.env.OLLAMA_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    expect(registeredBaseUrl("ollama")).toBe("http://localhost:11434/v1");
  });

  it("names the OpenAI-compatible variable in its own error", async () => {
    const res = await put({ openaiCompatibleBaseUrl: "javascript:alert(1)" });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe("OPENAI_COMPATIBLE_BASE_URL must be an http(s) URL");
  });

  it("clearing removes the value and restores the default registration", async () => {
    await put({ ollamaBaseUrl: "http://gpu-box:11434", openaiCompatibleBaseUrl: "http://lab:8080" });
    expect(registeredBaseUrl("ollama")).toBe("http://gpu-box:11434/v1");
    expect(openaiCompatibleConfigured()).toBe(true);

    const res = await put({ ollamaBaseUrl: null, openaiCompatibleBaseUrl: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ollamaBaseUrl).toEqual({ set: false, masked: null });
    expect(res.json().openaiCompatibleBaseUrl).toEqual({ set: false, masked: null });
    expect(process.env.OLLAMA_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    // Clearing writes an empty assignment so a stale shell/legacy value cannot
    // return at restart; an empty value means "use the default".
    const env = fs.readFileSync(envFile, "utf-8");
    expect(env).toMatch(/^OLLAMA_BASE_URL=$/m);
    expect(env).toMatch(/^OPENAI_COMPATIBLE_BASE_URL=$/m);

    expect(ollamaBaseUrl()).toBe("http://localhost:11434");
    expect(openaiCompatibleConfigured()).toBe(false);
    expect(registeredBaseUrl("ollama")).toBe("http://localhost:11434/v1");
    expect(registeredBaseUrl("openai-compatible")).toBe("http://localhost:1234/v1");
  });
});
