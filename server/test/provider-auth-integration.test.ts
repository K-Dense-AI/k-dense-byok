import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAuthManager } from "../src/agent/provider-auth.ts";
import { setupModelRuntime } from "../src/agent/models.ts";
import { registerCredentialRoutes, setCredentialEnvPathForTests } from "../src/api/credentials.ts";
import { applyEnvFile } from "../../env-file.mjs";

let dir: string;
const managers: ProviderAuthManager[] = [];
const apps: ReturnType<typeof Fastify>[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-auth-integration-"));
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OR_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  // No provider account or outbound request is needed by these regressions.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound request");
  }));
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const manager of managers.splice(0)) manager.dispose();
  setCredentialEnvPathForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runtime() {
  return ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(dir, "models-store.json"),
    allowModelNetwork: false,
  });
}

function manager(value: ModelRuntime) {
  const auth = new ProviderAuthManager(value);
  managers.push(auth);
  return auth;
}

async function credentialApp(value: ModelRuntime) {
  const app = Fastify();
  apps.push(app);
  setCredentialEnvPathForTests(path.join(dir, ".env"));
  await registerCredentialRoutes(app, { runtime: value });
  return app;
}

async function waiting(auth: ProviderAuthManager, provider: string) {
  const flow = await auth.start(provider);
  await vi.waitFor(() => {
    const current = auth.get(flow.id);
    expect(current.error).toBeUndefined();
    expect(current.prompt?.type).toBe("manual_code");
  });
  const current = auth.get(flow.id);
  const event = current.events.find((event) => event.type === "auth_url");
  if (event?.type !== "auth_url") throw new Error("Missing authorization URL");
  return { flow: current, url: new URL(event.url) };
}

// Exercise the real loopback listener while all external fetches remain mocked.
function callback(url: URL): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
}

describe("authentication with the installed Pi runtime", () => {
  it("starts ChatGPT OAuth with a stable installation ID", async () => {
    const hostIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = manager(await runtime());
      const flow = await auth.start("openai");
      await vi.waitFor(() => {
        const current = auth.get(flow.id);
        expect(current.error).toBeUndefined();
        const event = current.events.find((event) => event.type === "auth_url");
        expect(event?.type).toBe("auth_url");
        if (event?.type === "auth_url") {
          const hostId = new URL(event.url).searchParams.get("ext_agent_host_id");
          expect(hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
          hostIds[attempt] = hostId!;
        }
      });
      await auth.logout("openai");
    }
    expect(hostIds[0]).toBe(hostIds[1]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers Pi 1.0's Anthropic copy-code login for a browser on another machine", async () => {
    const auth = manager(await runtime());
    const flow = await auth.start("anthropic");
    await vi.waitFor(() => expect(auth.get(flow.id).prompt?.type).toBe("select"));
    const choice = auth.get(flow.id).prompt!;
    expect(choice.type === "select" && choice.options.map((option) => option.id)).toEqual(["browser", "copy_code"]);
    auth.respond(flow.id, choice.id, "copy_code");
    await vi.waitFor(() => expect(auth.get(flow.id).prompt?.type).toBe("manual_code"));
    const event = auth.get(flow.id).events.find((entry) => entry.type === "auth_url");
    expect(event?.type === "auth_url" && new URL(event.url).searchParams.get("redirect_uri"))
      .toBe("https://platform.claude.com/oauth/code/callback");
    // A pasted code from another sign-in (its state differs) is refused before any exchange.
    auth.respond(flow.id, auth.get(flow.id).prompt!.id, "the-code#another-state");
    await vi.waitFor(() => expect(auth.get(flow.id).status).toBe("error"));
    expect(auth.get(flow.id).error).toMatch(/state/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a stored OpenRouter login active when an older .env key is present", async () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      openrouter: { type: "oauth", access: "oauth-test-key", refresh: "", expires: Number.MAX_SAFE_INTEGER },
    }));
    vi.stubEnv("OPENROUTER_API_KEY", "older-env-test-key");
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await runtime();
      await setupModelRuntime(value);
      expect(await value.checkAuth("openrouter")).toMatchObject({ type: "oauth" });
      expect((await value.getAuth("openrouter"))?.auth.apiKey).toBe("oauth-test-key");
    }
  });

  it("makes the legacy OpenRouter env alias available to a fresh child runtime", async () => {
    vi.stubEnv("OR_API_KEY", "legacy-env-test-key");
    await setupModelRuntime(await runtime());
    const child = await runtime();
    expect((await child.getAuth("openrouter"))?.auth.apiKey).toBe("legacy-env-test-key");
  });

  it.each(["callback", "manual"])("completes OpenRouter %s login after an API-key save, including after restart", async (mode) => {
    const value = await runtime();
    const app = await credentialApp(value);
    const saved = await app.inject({ method: "PUT", url: "/credentials", payload: { openrouterApiKey: "old-test-key" } });
    expect(saved.statusCode).toBe(200);
    expect((await value.getAuth("openrouter"))?.auth.apiKey).toBe("old-test-key");
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/auth/keys");
      expect(JSON.parse(String(options?.body))).toMatchObject({
        code: "test-code", code_challenge_method: "S256", code_verifier: expect.any(String),
      });
      return Response.json({ key: "new-oauth-test-key" });
    });
    const auth = manager(value);
    const { flow, url } = await waiting(auth, "openrouter");
    const redirect = new URL(url.searchParams.get("callback_url")!);
    redirect.searchParams.set("code", "test-code");
    if (mode === "callback") expect(await callback(redirect)).toBe(200);
    else auth.respond(flow.id, flow.prompt!.id, redirect.toString());
    await vi.waitFor(() => expect(auth.get(flow.id).status).toBe("complete"));
    expect(JSON.stringify(auth.get(flow.id))).not.toContain("new-oauth-test-key");
    for (const current of [value, await runtime()]) {
      await setupModelRuntime(current);
      expect(await current.checkAuth("openrouter")).toMatchObject({ type: "oauth" });
      expect((await current.getAuth("openrouter"))?.auth.apiKey).toBe("new-oauth-test-key");
    }

    // Choosing an API key again must also switch a child/restarted process.
    const changed = await app.inject({ method: "PUT", url: "/credentials", payload: { openrouterApiKey: "replacement-test-key" } });
    expect(changed.statusCode).toBe(200);
    for (const current of [value, await runtime()]) {
      expect(await current.checkAuth("openrouter")).toMatchObject({ type: "api_key" });
      expect((await current.getAuth("openrouter"))?.auth.apiKey).toBe("replacement-test-key");
    }
  });

  it.each(["callback", "manual"])("completes ChatGPT %s login and lets Pi refresh the persisted credential", async (mode) => {
    const value = await runtime();
    const app = await credentialApp(value);
    await app.inject({ method: "PUT", url: "/credentials", payload: { openaiApiKey: "old-openai-test-key" } });
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      expect(String(url)).toBe("https://auth.openai.com/api/accounts/oauth/token");
      const params = new URLSearchParams(String(options?.body));
      expect(params.get("client_id")).toBe("issued-test-client");
      const refresh = params.get("grant_type") === "refresh_token";
      if (refresh) expect(params.get("refresh_token")).toBe("test-refresh");
      else expect(params.get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: refresh ? "refreshed-test-access" : "test-access",
        refresh_token: refresh ? "rotated-test-refresh" : "test-refresh",
        expires_in: refresh ? 3600 : 60,
        scope: "openid chatgpt.tokens.use.direct", id_token: "test-id-token",
      });
    });
    const auth = manager(value);
    const { flow, url } = await waiting(auth, "openai");
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "test-code");
    redirect.searchParams.set("client_id", "issued-test-client");
    redirect.searchParams.set("state", url.searchParams.get("state")!);
    if (mode === "callback") expect(await callback(redirect)).toBe(200);
    else auth.respond(flow.id, flow.prompt!.id, redirect.toString());
    await vi.waitFor(() => expect(auth.get(flow.id).status).toBe("complete"));
    expect(JSON.stringify(auth.get(flow.id))).not.toContain("test-refresh");
    expect(await value.checkAuth("openai")).toMatchObject({ type: "oauth" });
    expect((await value.getAuth("openai"))?.auth.apiKey).toBe("refreshed-test-access");
    expect((await (await runtime()).getAuth("openai"))?.auth.apiKey).toBe("refreshed-test-access");
    expect(fetch).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
    expect(stored.openai.refresh).toBe("rotated-test-refresh");

    // Clearing a fallback API key must not disconnect the active subscription.
    await app.inject({ method: "PUT", url: "/credentials", payload: { openaiApiKey: null } });
    expect(await value.checkAuth("openai")).toMatchObject({ type: "oauth" });
  });

  it("rejects a pasted ChatGPT callback with the wrong OAuth state", async () => {
    const auth = manager(await runtime());
    const { flow, url } = await waiting(auth, "openai");
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.search = "code=test-code&client_id=test-client&state=wrong-state";
    auth.respond(flow.id, flow.prompt!.id, redirect.toString());
    await vi.waitFor(() => expect(auth.get(flow.id)).toMatchObject({ status: "error", error: "OAuth state mismatch" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces exported/spaced .env assignments and keeps cleared aliases cleared on restart", async () => {
    const value = await runtime();
    const app = await credentialApp(value);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "export OPENROUTER_API_KEY = old-test-key\nOR_API_KEY = old-alias-key\n# keep this comment\n");
    await app.inject({ method: "PUT", url: "/credentials", payload: { openrouterApiKey: "replacement-test-key" } });
    delete process.env.OPENROUTER_API_KEY;
    applyEnvFile(envPath);
    expect(process.env.OPENROUTER_API_KEY).toBe("replacement-test-key");
    const cleared = await app.inject({ method: "PUT", url: "/credentials", payload: { openrouterApiKey: null } });
    expect(cleared.statusCode).toBe(200);
    vi.stubEnv("OPENROUTER_API_KEY", "stale-shell-test-key");
    vi.stubEnv("OR_API_KEY", "stale-shell-alias-key");
    applyEnvFile(envPath, { override: true });
    const legacy = path.join(dir, "legacy.env");
    fs.writeFileSync(legacy, "OPENROUTER_API_KEY=old-server-key\nOR_API_KEY=old-legacy-key\n");
    applyEnvFile(legacy);
    const restarted = await runtime();
    await setupModelRuntime(restarted);
    expect(await restarted.checkAuth("openrouter")).toBeUndefined();
    expect(fs.readFileSync(envPath, "utf-8")).toContain("# keep this comment");
  });
});
