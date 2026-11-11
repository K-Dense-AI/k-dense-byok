import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { sessionCostSummary } from "../src/cost/ledger.ts";
import { annotateMeteredChild, childIsMetered, handleSubagentMeter, recoverSubagentUsage } from "../src/agent/subagent-meter.ts";
import { meteredStream, setHostMeter, watchdogStream } from "../src/agent/subagent-host.mjs";
import { makeSubagentLedgerExtension, pinInheritedChildModels, workflowScriptTargets } from "../src/agent/subagent-bridge.ts";
import { parseAgentMarkdown, serializeAgentMarkdown, subagentsPackageDir } from "../src/agent/agent-files.ts";
import { seedSubagentResources } from "../src/agent/subagent-resources.ts";
import { writePiSettings } from "../src/agent/capability-state.ts";
import { patchSubagents } from "../scripts/patch-subagents.mjs";

beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); setHostMeter(handleSubagentMeter); });
afterEach(() => vi.restoreAllMocks());
const model = { provider: "openrouter", id: "test" };
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 1 } };
function resultStream(stopReason = "stop") {
  const message = { role: "assistant", usage, stopReason };
  return { async *[Symbol.asyncIterator]() { yield { type: stopReason === "stop" ? "done" : "error", message, error: message }; }, async result() { return message; } };
}
function owner() { const paths = resolvePaths("meter"); return { projectId: "meter", sandbox: paths.sandbox, sessionId: "parent", childSessionId: "child", sessionFile: path.join(paths.sessionsDir, "child.jsonl"), runId: "run", kind: "subagent" }; }
function bridge(projectId = "meter") {
  const handlers: Record<string, any> = {}, events: Record<string, any> = {};
  makeSubagentLedgerExtension(projectId, () => "parent", () => ({ provider: "openai-codex", id: "test" } as any), () => true)({ on: (n: string, f: any) => handlers[n] = f, events: { on: (n: string, f: any) => events[n] = f } } as any);
  return { handlers, events };
}

describe("resolved provider admission and accounting", () => {
  it.each(["stop", "error", "aborted"])("meters %s terminal usage once before it is visible and blocks the next paid request", async (reason) => {
    createProject({ projectId: "meter", name: "Meter", spendLimitUsd: 0.5 });
    const base = vi.fn(() => resultStream(reason));
    const stream = meteredStream(base, owner(), () => false);
    const response = await stream(model, {}, {});
    for await (const _event of response) expect(sessionCostSummary("parent", "meter").totalUsd).toBe(1);
    await response.result();
    expect(sessionCostSummary("parent", "meter").entries).toHaveLength(1);
    expect(childIsMetered("meter", owner().sessionFile)).toBe(true);
    await expect(stream(model, {}, {})).rejects.toThrow(/spend limit/);
    expect(base).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(resolvePaths("meter").kadyDir, "subagent-usage-pending"))).toEqual([]);
  });
  it("allows local and subscription usage at the paid cap and records list-price tokens", async () => {
    createProject({ projectId: "meter", name: "Meter", spendLimitUsd: 0.5 });
    handleSubagentMeter("usage", { projectId: "meter", sessionId: "seed", requestId: "seed", ...model, model: model.id, kind: "subagent", authType: "api_key", usage });
    const stream = meteredStream(() => resultStream(), owner(), () => true);
    for (const provider of ["openai", "ollama", "openai-compatible"]) await (await stream({ provider, id: "test" }, {}, {})).result();
    const summary = sessionCostSummary("parent", "meter");
    expect(summary.totalUsd).toBe(0);
    expect(summary.entries).toHaveLength(3);
    expect(summary.entries[0]).toMatchObject({ billingMode: "subscription", listPriceUsd: 1, totalTokens: 20 });
    await expect(stream({ provider: "anthropic", id: "test" }, {}, {})).rejects.toThrow(/spend limit/);
  });
  it("meters clean watchdog reviews and gates them before the provider is called", async () => {
    createProject({ projectId: "meter", name: "Meter", spendLimitUsd: 0.5 });
    const base = vi.fn(() => resultStream());
    const stream = watchdogStream({ cwd: resolvePaths("meter").sandbox, sessionManager: { getSessionId: () => "parent" }, modelRegistry: { isUsingOAuth: () => false } }, base);
    await (await stream(model, {}, {})).result();
    expect(sessionCostSummary("parent", "meter").entries[0].origin?.kind).toBe("watchdog");
    await expect(stream(model, {}, {})).rejects.toThrow(/spend limit/);
    expect(base).toHaveBeenCalledTimes(1);
  });
  it("recovers durable usage after an unavailable backend without duplicating a charge", async () => {
    createProject({ projectId: "meter", name: "Meter", spendLimitUsd: 0.5 });
    setHostMeter((action, raw) => { if (action === "usage") throw new Error("backend unavailable"); return handleSubagentMeter(action, raw); });
    const stream = meteredStream(() => resultStream(), owner(), () => false);
    await expect((await stream(model, {}, {})).result()).rejects.toThrow("backend unavailable");
    const pendingDir = path.join(resolvePaths("meter").kadyDir, "subagent-usage-pending");
    const file = fs.readdirSync(pendingDir)[0], receipt = JSON.parse(fs.readFileSync(path.join(pendingDir, file), "utf8"));
    recoverSubagentUsage("meter");
    handleSubagentMeter("usage", receipt);
    expect(sessionCostSummary("parent", "meter").entries).toHaveLength(1);
    expect(fs.readdirSync(pendingDir)).toEqual([]);
    expect(() => handleSubagentMeter("admit", { ...receipt, requestId: "new" })).toThrow(/spend limit/);
  });
  it("adds schedule origin to metered children without ledgering completion again", async () => {
    ensureProjectExists("meter");
    const stream = meteredStream(() => resultStream(), owner(), () => false);
    await (await stream(model, {}, {})).result();
    const { events } = bridge();
    events["subagent:async-complete"]({ id: "run", scheduleOrigin: { id: "nightly", name: "Nightly QC" }, results: [{ sessionFile: owner().sessionFile, model: "openrouter/test", usage: { cost: 1, input: 10 } }] });
    const summary = sessionCostSummary("parent", "meter");
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].origin).toMatchObject({ schedule: "nightly", name: "Nightly QC", kind: "subagent" });
  });
  it("uses run usage instead of inherited fork history for unmetered legacy completions", () => {
    ensureProjectExists("meter");
    const file = owner().sessionFile; fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [10, 1].map((cost) => JSON.stringify({ type: "message", message: { role: "assistant", provider: "openrouter", model: "test", usage: { ...usage, cost: { total: cost } } } })).join("\n"));
    const { events } = bridge();
    const event = { id: "fork-run", results: [{ sessionFile: file, context: "fork", model: "openrouter/test", usage: { input: 10, cost: 1 } }] };
    events["subagent:async-complete"](event); events["subagent:async-complete"](event);
    expect(sessionCostSummary("parent", "meter").totalUsd).toBe(1);
  });
});

describe("workflow and definition compatibility", () => {
  it.each([
    'const agent = "scout"; return runs.run("x", { agent, task: "hi" })',
    'return runs.run("x", { [pickKey()]: "scout", task: "hi" })',
    'return runs.run("x", { ...opts, task: "hi" })',
  ])("does not replace computed models or agents: %s", (workflowScript) => {
    ensureProjectExists("meter");
    const input: any = { workflowScript };
    expect(workflowScriptTargets(workflowScript).dynamic).toBe(true);
    pinInheritedChildModels("meter", input, model as any);
    expect(input.model).toBeUndefined();
  });
  it("parses async scripts and ignores fake targets inside comments and strings", () => {
    const result = workflowScriptTargets('/* model: "bad" */ const text = \'agent: "bad"\'; return await runs.run("x", { ["agent"]: "scout", task: text });');
    expect([...result.agents]).toEqual(["scout"]); expect([...result.models]).toEqual([]); expect(result.dynamic).toBe(false);
  });
  it.each(["default", "override"])("gates %s paid models despite a subscription parent", async (kind) => {
    createProject({ projectId: "meter", name: "Meter", spendLimitUsd: 0.5 });
    handleSubagentMeter("usage", { projectId: "meter", sessionId: "seed", requestId: "seed", ...model, model: model.id, kind: "subagent", authType: "api_key", usage });
    writePiSettings(resolvePaths("meter"), { subagents: kind === "default" ? { defaultModel: "openrouter/test" } : { agentOverrides: { scout: { model: "openrouter/test" } } } });
    const { handlers } = bridge();
    const input = { workflowScript: 'return runs.run("x", {agent:"scout",task:"check"})' };
    expect(await handlers.tool_call({ toolName: "subagent", input })).toMatchObject({ block: true });
    expect(await handlers.tool_call({ toolName: "subagent", input: { ...input, model: "ollama/free" } })).toBeUndefined();
  });
  it("round-trips nested runner, memory, arrays and unknown typed fields", () => {
    const text = '---\nname: custom\ntools: [read, bash]\nmemory:\n  scope: project\n  path: notes\nrunner:\n  type: external-cli\n  command: cli\n  args: ["--flag", "a:b"]\npermissions:\n  bash: ask\ncustom:\n  enabled: false\n  limit: 12\n---\nPrompt';
    const parsed = parseAgentMarkdown(text, "custom", "project");
    const roundtrip = parseAgentMarkdown(serializeAgentMarkdown(parsed), "custom", "project");
    expect(roundtrip).toEqual(parsed);
    expect(roundtrip.extra?.runner).toEqual({ type: "external-cli", command: "cli", args: ["--flag", "a:b"] });
    expect(roundtrip.memory).toEqual({ scope: "project", path: "notes" });
  });
  it("seeds full bundled resources once while preserving local edits and deletions", () => {
    const paths = ensureProjectExists("meter"), pkg = subagentsPackageDir();
    const prompts = fs.readdirSync(path.join(pkg, "prompts"));
    const first = path.join(paths.sandbox, ".pi", "prompts", prompts[0]); fs.mkdirSync(path.dirname(first), { recursive: true }); fs.writeFileSync(first, "local prompt");
    seedSubagentResources(paths);
    expect(fs.readFileSync(first, "utf8")).toBe("local prompt");
    for (const skill of fs.readdirSync(path.join(pkg, "skills"))) expect(fs.existsSync(path.join(paths.skillsDir, skill, "SKILL.md"))).toBe(true);
    const deleted = path.join(paths.sandbox, ".pi", "prompts", prompts[1]); fs.rmSync(deleted); seedSubagentResources(paths); expect(fs.existsSync(deleted)).toBe(false);
  });
  it("preserves stable child targets when snapshot rows are omitted or reordered", async () => {
    patchSubagents();
    const { projectAsyncStatusSnapshot } = await import(pathToFileURL(path.join(subagentsPackageDir(), "src/runs/shared/async-status-projection.js")).href);
    const result = projectAsyncStatusSnapshot([{ asyncId: "run", mode: "chain", agents: ["a", "b"], status: "running", startedAt: 1, steps: [{ agent: "a", status: "complete", workflowKey: "first" }, { agent: "b", status: "running", workflowKey: "second" }] }]);
    expect(result.runs[0].children[1].control).toEqual({ runId: "run", index: 1, childId: "second" });
  });
});
