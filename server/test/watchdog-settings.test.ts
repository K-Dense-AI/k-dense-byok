/**
 * Watchdog settings (subagents.watchdog in sandbox/.pi/settings.json), the
 * supervisor tool's provenance classification, and the AGENTS.md status routes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/agent/session-registry.ts", () => ({
  getModelRuntime: vi.fn(() => ({ checkAuth: vi.fn(async () => ({ type: "api_key", source: "test" })) })),
  getModelRegistry: vi.fn(() => ({
    find: (provider: string, id: string) => (provider === "openrouter" && id === "openai/gpt-5.5" ? { provider, id } : null),
  })),
  createSession: vi.fn(),
  getSession: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
  setSessionObserver: vi.fn(),
  abortProjectSessions: vi.fn(async () => {}),
  disposeProjectSessions: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { readWatchdogSettings, seedWatchdogGuidance, writeWatchdogSettings, WATCHDOG_MD } from "../src/agent/watchdog-settings.ts";
import { READ_ONLY_TOOLS as recorderReadOnly } from "../src/provenance/recorder.ts";
import { READ_ONLY_TOOLS as harvestReadOnly } from "../src/provenance/harvest.ts";
import { AGENTS_MD_HISTORY } from "../src/sandbox-seed.ts";

const app = await buildApp();
let projectId: string;
const h = (pid: string) => ({ "x-project-id": pid, "content-type": "application/json" });
const hg = (pid: string) => ({ "x-project-id": pid });
const settingsFile = (pid: string) => path.join(resolvePaths(pid).sandbox, ".pi", "settings.json");

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  projectId = createProject({ name: "Watched" }).id;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("watchdog settings", () => {
  it("defaults off, writes only its keys (plus lsp off), and round-trips", async () => {
    fs.mkdirSync(path.dirname(settingsFile(projectId)), { recursive: true });
    fs.writeFileSync(
      settingsFile(projectId),
      JSON.stringify({ packages: ["/x"], subagents: { forceTopLevelAsync: true, agentOverrides: { reviewer: { disabled: true } } } }),
    );
    let res = await app.inject({ method: "GET", url: "/watchdog", headers: hg(projectId) });
    expect(res.json()).toEqual({
      enabled: false,
      model: "",
      thinking: "",
      cadenceEveryNTools: null,
      severityThreshold: "concern",
      children: false,
      watchdogMd: true,
      stalemateRepeats: 3,
      metered: false,
    });
    // GET seeds the standing instructions.
    expect(fs.readFileSync(path.join(resolvePaths(projectId).sandbox, ".pi", "WATCHDOG.md"), "utf-8")).toBe(WATCHDOG_MD);

    res = await app.inject({
      method: "PUT",
      url: "/watchdog",
      headers: h(projectId),
      payload: { enabled: true, model: "openrouter/openai/gpt-5.5", thinking: "high", cadenceEveryNTools: 10, severityThreshold: "blocker", children: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, model: "openrouter/openai/gpt-5.5", thinking: "high", cadenceEveryNTools: 10, severityThreshold: "blocker", children: true });
    const written = JSON.parse(fs.readFileSync(settingsFile(projectId), "utf-8"));
    expect(written).toEqual({
      packages: ["/x"],
      subagents: {
        forceTopLevelAsync: true,
        agentOverrides: { reviewer: { disabled: true } },
        watchdog: {
          enabled: true,
          severityThreshold: "blocker",
          stalemateRepeats: 3,
          cadence: { everyNTools: 10 },
          main: { model: "openrouter/openai/gpt-5.5", thinking: "high" },
          children: { enabled: true },
          guidance: { watchdogMd: true },
          lsp: { enabled: false },
        },
      },
    });

    // Clearing model/cadence removes the keys rather than writing empties.
    res = await app.inject({ method: "PUT", url: "/watchdog", headers: h(projectId), payload: { model: "", thinking: "", cadenceEveryNTools: null } });
    const cleared = JSON.parse(fs.readFileSync(settingsFile(projectId), "utf-8")).subagents.watchdog;
    expect(cleared.main).toBeUndefined();
    expect(cleared.cadence).toBeUndefined();
    expect(readWatchdogSettings(resolvePaths(projectId))).toMatchObject({ enabled: true, model: "", cadenceEveryNTools: null });
  });

  it("rejects bad values and unknown models, 409s a malformed file", async () => {
    for (const payload of [
      { enabled: "yes" },
      { thinking: "ultra" },
      { cadenceEveryNTools: 2 },
      { severityThreshold: "meh" },
      { stalemateRepeats: 0 },
      { model: "anthropic/no-such-model" },
    ]) {
      const res = await app.inject({ method: "PUT", url: "/watchdog", headers: h(projectId), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    fs.mkdirSync(path.dirname(settingsFile(projectId)), { recursive: true });
    fs.writeFileSync(settingsFile(projectId), "{ nope");
    const res = await app.inject({ method: "PUT", url: "/watchdog", headers: h(projectId), payload: { enabled: true } });
    expect(res.statusCode).toBe(409);
    expect(fs.readFileSync(settingsFile(projectId), "utf-8")).toBe("{ nope");
    expect(writeWatchdogSettings(resolvePaths(projectId), { enabled: true })).toBeNull();
  });

  it("seeds WATCHDOG.md once; deleting it sticks", () => {
    const paths = resolvePaths(projectId);
    expect(seedWatchdogGuidance(paths)).toBe(true);
    const file = path.join(paths.sandbox, ".pi", "WATCHDOG.md");
    fs.rmSync(file);
    expect(seedWatchdogGuidance(paths)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("supervisor channel plumbing", () => {
  it("classifies the supervisor tools as read-only in both provenance sets", () => {
    for (const set of [recorderReadOnly, harvestReadOnly]) {
      expect(set.has("subagent_supervisor")).toBe(true);
      expect(set.has("contact_supervisor")).toBe(true);
    }
  });

  it("ships supervisor guidance in the current AGENTS.md and versions it", () => {
    expect(AGENTS_MD_HISTORY.length).toBeGreaterThanOrEqual(3);
    expect(AGENTS_MD_HISTORY.at(-1)).toContain("subagent_supervisor");
    expect(AGENTS_MD_HISTORY.at(-1)).toContain("read-only raw data");
  });

  it("reports and restores the sandbox instructions", async () => {
    const paths = resolvePaths(projectId);
    let res = await app.inject({ method: "GET", url: `/projects/${projectId}/instructions`, headers: hg(projectId) });
    expect(res.json()).toEqual({ status: "current" });
    fs.appendFileSync(path.join(paths.sandbox, "AGENTS.md"), "\n## Mine\n");
    res = await app.inject({ method: "GET", url: `/projects/${projectId}/instructions`, headers: hg(projectId) });
    expect(res.json()).toEqual({ status: "edited" });
    res = await app.inject({ method: "POST", url: `/projects/${projectId}/instructions/restore`, headers: hg(projectId) });
    expect(res.json()).toEqual({ status: "current" });
  });
});
