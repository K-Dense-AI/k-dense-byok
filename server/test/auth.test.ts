/**
 * Optional access token (auth.ts): off by default on loopback, enforced when
 * required, and never echoed into request logs.
 */
import fs from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { authRequired, redactAuthFromUrl, resetAuthForTests } from "../src/auth.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";

const app = await buildApp();
const TOKEN = "test-token-0123456789abcdef";

const saved = { require: process.env.KADY_REQUIRE_AUTH, token: process.env.KADY_AUTH_TOKEN, host: process.env.KADY_HOST };
function restore() {
  for (const [key, value] of [
    ["KADY_REQUIRE_AUTH", saved.require],
    ["KADY_AUTH_TOKEN", saved.token],
    ["KADY_HOST", saved.host],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuthForTests();
}
beforeEach(restore);
afterEach(restore);
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("auth policy", () => {
  it("is off on loopback, on when exposed, and overridable", () => {
    delete process.env.KADY_REQUIRE_AUTH;
    delete process.env.KADY_AUTH_TOKEN;
    process.env.KADY_HOST = "127.0.0.1";
    expect(authRequired()).toBe(false);
    process.env.KADY_HOST = "0.0.0.0";
    expect(authRequired()).toBe(true);
    process.env.KADY_REQUIRE_AUTH = "0";
    expect(authRequired()).toBe(false);
    process.env.KADY_HOST = "127.0.0.1";
    process.env.KADY_REQUIRE_AUTH = "1";
    expect(authRequired()).toBe(true);
  });

  it("redacts the query token from logged URLs", () => {
    expect(redactAuthFromUrl("/sandbox/raw?path=a.png&kady_token=secret&x=1")).toBe(
      "/sandbox/raw?path=a.png&kady_token=[redacted]&x=1",
    );
    expect(redactAuthFromUrl("/projects")).toBe("/projects");
  });
});

describe("auth hook", () => {
  it("leaves a default loopback install open", async () => {
    delete process.env.KADY_REQUIRE_AUTH;
    delete process.env.KADY_AUTH_TOKEN;
    process.env.KADY_HOST = "127.0.0.1";
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(200);
  });

  it("requires the token when enabled and accepts header, bearer and query forms", async () => {
    process.env.KADY_REQUIRE_AUTH = "1";
    process.env.KADY_AUTH_TOKEN = TOKEN;

    const denied = await app.inject({ method: "GET", url: "/projects" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["x-kady-auth"]).toBe("required");
    expect(denied.json()).toMatchObject({ reason: "auth_required" });

    const wrong = await app.inject({ method: "GET", url: "/projects", headers: { "x-kady-token": "nope" } });
    expect(wrong.statusCode).toBe(401);

    for (const req of [
      { url: "/projects", headers: { "x-kady-token": TOKEN } },
      { url: "/projects", headers: { authorization: `Bearer ${TOKEN}` } },
      { url: `/projects?kady_token=${TOKEN}`, headers: {} },
    ]) {
      const ok = await app.inject({ method: "GET", ...req });
      expect(ok.statusCode).toBe(200);
    }
  });

  it("keeps preflights and the health probe open", async () => {
    process.env.KADY_REQUIRE_AUTH = "1";
    process.env.KADY_AUTH_TOKEN = TOKEN;
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET", "access-control-request-headers": "x-kady-token" },
    });
    expect(preflight.statusCode).toBeLessThan(300);
  });
});
