import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";
import { patchSubagents } from "../scripts/patch-subagents.mjs";

patchSubagents();
const { createScheduledRunManager } = await import(pathToFileURL(path.join(subagentsPackageDir(), "src/runs/background/scheduled-runs.js")).href);
let dir: string;
const managers: any[] = [];
const policies: ReturnType<typeof registerSubagentCapabilityCeiling>[] = [];
const sessionId = "qa-schedule-ceiling";
const policy = (source: string, allowedTools: string[]) => {
  const handle = registerSubagentCapabilityCeiling({ sessionId, source, ceiling: { allowedTools } });
  policies.push(handle);
  return handle;
};
const context = () => ({ cwd: dir, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => path.join(dir, "session.jsonl") } });
function manager(launch = vi.fn(async () => ({ details: { asyncId: "qa-run" } }))) {
  const result = createScheduledRunManager({ config: {}, launch, resolveCapabilityCeiling: resolveSubagentCapabilityCeiling });
  managers.push(result);
  result.bindSession(context());
  return result;
}
const create = (m: any, id = "qa-check") => m.handleToolCall({ action: "schedule.create", id, every: "24h", workflowScript: "return runs.run('review', { agent: 'researcher', task: 'Read report' });" }, context());
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-schedule-")); vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", "test-host"); });
afterEach(() => { managers.splice(0).forEach(m => m.stop()); policies.splice(0).forEach(p => p.dispose()); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

it("retains a selected model across persistence and restart", async () => {
  policy("kady-parent-tools", ["read"]);
  const first = manager();
  const model = "openrouter/openai/gpt-6-luna";
  expect((await first.handleToolCall({ action: "schedule.create", id: "pinned", every: "24h", model,
    workflowScript: "return runs.run('review', { agent: 'researcher', task: 'Read report' });" }, context())).isError).not.toBe(true);
  await first.handleToolCall({ action: "schedule.pause", id: "pinned" }, context());
  first.stop();
  const launch = vi.fn(async (params: any) => {
    expect(params.model).toBe(model);
    return { details: { asyncId: "pinned-run" } };
  });
  const restored = manager(launch);
  expect((await restored.handleToolCall({ action: "schedule.run", id: "pinned" }, context())).isError).not.toBe(true);
  expect(launch).toHaveBeenCalledOnce();
});

it("persists the host ceiling and intersects it with current policy after restart", async () => {
  const current = policy("kady-parent-tools", ["read", "grep"]);
  const first = manager();
  expect((await create(first)).isError).not.toBe(true);
  await first.handleToolCall({ action: "schedule.pause", id: "qa-check" }, context());
  first.stop();
  // Later access may be added or removed. A saved schedule gets neither the
  // newly added tool nor a tool that the current host has removed.
  current.update({ allowedTools: ["read", "write"] });
  const launch = vi.fn(async () => {
    expect(resolveSubagentCapabilityCeiling(sessionId)?.allowedTools).toEqual(["read"]);
    return { details: { asyncId: "qa-run" } };
  });
  const restored = manager(launch);
  expect((await restored.handleToolCall({ action: "schedule.run", id: "qa-check" }, context())).isError).not.toBe(true);
  expect(launch).toHaveBeenCalledOnce();
  expect(resolveSubagentCapabilityCeiling(sessionId)?.allowedTools).toEqual(["read", "write"]);
});

it("retains the upstream block for other hosts and temporary ceilings", async () => {
  policy("kady-parent-tools", ["read"]);
  const m = manager();
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", "");
  expect((await create(m)).isError).toBe(true);
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", "test-host");
  policy("temporary-read-only", ["read"]);
  expect((await create(m)).isError).toBe(true);
});

it("fails closed without a current Kady policy and releases snapshots on launch failure", async () => {
  const current = policy("kady-parent-tools", ["read"]);
  const launch = vi.fn(async () => { throw new Error("launch unavailable"); });
  const m = manager(launch);
  await create(m);
  expect((await m.handleToolCall({ action: "schedule.run", id: "qa-check" }, context())).isError).toBe(true);
  expect(resolveSubagentCapabilityCeiling(sessionId)?.sources).toEqual(["kady-parent-tools"]);
  current.dispose();
  launch.mockClear();
  expect((await m.handleToolCall({ action: "schedule.run", id: "qa-check" }, context())).isError).toBe(true);
  expect(launch).not.toHaveBeenCalled();
});
