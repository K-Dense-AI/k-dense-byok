/**
 * The request guard is the backend's boundary against the browser: CORS only
 * hides responses, so a foreign page's form POST or a DNS-rebound hostname
 * must be refused before any handler runs.
 */
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { hostHeaderHostname, isCorsOriginAllowed, isHostAllowed } from "../src/cors.ts";
import { buildApp } from "../src/index.ts";
import { listProjects } from "../src/projects.ts";

const app = await buildApp();

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

const saved = {
  origins: process.env.KADY_ALLOWED_ORIGINS,
  hosts: process.env.KADY_ALLOWED_HOSTS,
  host: process.env.KADY_HOST,
  port: process.env.KADY_FRONTEND_PORT,
};
afterEach(() => {
  for (const [key, value] of [
    ["KADY_ALLOWED_ORIGINS", saved.origins],
    ["KADY_ALLOWED_HOSTS", saved.hosts],
    ["KADY_HOST", saved.host],
    ["KADY_FRONTEND_PORT", saved.port],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("origin policy", () => {
  it("allows the loopback UI and non-browser callers", () => {
    expect(isCorsOriginAllowed(undefined)).toBe(true);
    expect(isCorsOriginAllowed("http://localhost:3000")).toBe(true);
    expect(isCorsOriginAllowed("http://127.0.0.1:3000")).toBe(true);
    expect(isCorsOriginAllowed("http://[::1]:3000")).toBe(true);
  });

  it("refuses other local servers, which may serve untrusted HTML", () => {
    // e.g. an agent-started `python -m http.server`, Streamlit, or a second dev server
    expect(isCorsOriginAllowed("http://localhost:8080")).toBe(false);
    expect(isCorsOriginAllowed("http://127.0.0.1:3001")).toBe(false);
    expect(isCorsOriginAllowed("http://localhost:8000")).toBe(false);
    process.env.KADY_FRONTEND_PORT = "3100";
    expect(isCorsOriginAllowed("http://localhost:3100")).toBe(true);
    expect(isCorsOriginAllowed("http://localhost:3000")).toBe(false);
  });

  it("refuses foreign, opaque and intranet origins by default", () => {
    expect(isCorsOriginAllowed("https://evil.example")).toBe(false);
    expect(isCorsOriginAllowed("http://localhost.evil.example:3000")).toBe(false);
    expect(isCorsOriginAllowed("null")).toBe(false);
    expect(isCorsOriginAllowed("file://")).toBe(false);
    // Any intranet page used to be able to drive the agent.
    expect(isCorsOriginAllowed("http://10.20.30.40:8080")).toBe(false);
  });

  it("honours KADY_ALLOWED_ORIGINS and the legacy LAN list only when exposed", () => {
    process.env.KADY_ALLOWED_ORIGINS = "https://kady.corp.example, http://10.1.2.3:3000";
    expect(isCorsOriginAllowed("https://kady.corp.example")).toBe(true);
    expect(isCorsOriginAllowed("http://10.1.2.3:3000")).toBe(true);
    expect(isCorsOriginAllowed("http://10.1.2.4:3000")).toBe(false);

    delete process.env.KADY_ALLOWED_ORIGINS;
    process.env.KADY_HOST = "0.0.0.0";
    expect(isCorsOriginAllowed("http://192.168.1.20:3000")).toBe(true);
    process.env.KADY_HOST = "127.0.0.1";
    expect(isCorsOriginAllowed("http://192.168.1.20:3000")).toBe(false);
  });
});

describe("host policy", () => {
  it("parses host headers", () => {
    expect(hostHeaderHostname("[::1]:8000")).toBe("[::1]");
    expect(hostHeaderHostname("LocalHost:8000")).toBe("localhost");
    expect(hostHeaderHostname("10.0.0.5")).toBe("10.0.0.5");
  });

  it("accepts names that cannot be rebound and refuses the rest", () => {
    expect(isHostAllowed("localhost:8000")).toBe(true);
    expect(isHostAllowed("127.0.0.1:8000")).toBe(true);
    expect(isHostAllowed("[::1]:8000")).toBe(true);
    expect(isHostAllowed("192.168.1.20:8000")).toBe(true);
    expect(isHostAllowed("rebind.attacker.example:8000")).toBe(false);
    process.env.KADY_ALLOWED_HOSTS = "gpu-box.corp";
    expect(isHostAllowed("gpu-box.corp:8000")).toBe(true);
  });
});

describe("request guard", () => {
  it("refuses a cross-site form POST before the handler runs", async () => {
    const before = listProjects().length;
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      payload: '{"name":"pwned"}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "origin_not_allowed" });
    expect(listProjects().length).toBe(before);
  });

  it("refuses a DNS-rebound Host even without an Origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/credentials",
      headers: { host: "rebind.attacker.example:8000" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "host_not_allowed" });
  });

  it("refuses a foreign preflight and answers the local UI's", async () => {
    const foreign = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

    const local = await app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    });
    expect(local.statusCode).toBeLessThan(300);
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("refuses a cross-site <img> GET unless the embedding page is the UI", async () => {
    const img = { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };
    const foreign = await app.inject({
      method: "GET",
      url: "/health",
      headers: { ...img, referer: "http://localhost:8080/evil.html" },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ reason: "cross_site_embed" });
    const stripped = await app.inject({ method: "GET", url: "/health", headers: img });
    expect(stripped.statusCode).toBe(403);
    const ui = await app.inject({
      method: "GET",
      url: "/health",
      headers: { ...img, referer: "http://localhost:3000/" },
    });
    expect(ui.statusCode).toBe(200);
    // Top-level navigation (a link the user clicked) stays allowed.
    const nav = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    expect(nav.statusCode).toBe(200);
  });

  it("sandboxes every response except PDFs", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["content-security-policy"]).toMatch(/^sandbox;/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves the local UI and origin-less clients normally", async () => {
    const ui = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000", host: "localhost:8000" },
    });
    expect(ui.statusCode).toBe(200);
    const curl = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:8000" } });
    expect(curl.statusCode).toBe(200);
  });
});

describe("sandbox content served from the API origin", () => {
  it("serves HTML and SVG sandboxed, PDFs viewable", async () => {
    const { resolvePaths, ensureProjectExists } = await import("../src/projects.ts");
    ensureProjectExists("default");
    const sandbox = resolvePaths("default").sandbox;
    fs.mkdirSync(`${sandbox}/user_data`, { recursive: true });
    fs.writeFileSync(`${sandbox}/user_data/evil.html`, "<script>fetch('/credentials')</script>");
    fs.writeFileSync(`${sandbox}/user_data/fig.svg`, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(`${sandbox}/user_data/paper.pdf`, "%PDF-1.4\n");
    for (const name of ["evil.html", "fig.svg"]) {
      const res = await app.inject({ method: "GET", url: `/sandbox/raw?path=user_data/${name}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toMatch(/^sandbox;.*default-src 'none'/);
    }
    const pdf = await app.inject({ method: "GET", url: "/sandbox/raw?path=user_data/paper.pdf" });
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect(pdf.headers["content-security-policy"]).toBeUndefined();
    expect(pdf.headers["x-content-type-options"]).toBe("nosniff");
  });
});
