import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, updateProject } from "../src/projects.ts";
import { createSession, disposeProjectSessions } from "../src/agent/session-registry.ts";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";
import { subagentHost } from "../src/agent/subagent-control.ts";
import { snapshotBackgroundWork } from "pi-subagents/background-work";
import { modalJobManager } from "../src/modal/manager.ts";
import { patchSubagents } from "../scripts/patch-subagents.mjs";
import { handleSubagentMeter } from "../src/agent/subagent-meter.ts";
import { setHostMeter } from "../src/agent/subagent-host.mjs";
import { sessionCostSummary } from "../src/cost/ledger.ts";

beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); patchSubagents(); });
afterEach(async () => { await disposeProjectSessions("runtime"); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const internal = (file: string) => import(pathToFileURL(path.join(subagentsPackageDir(), file)).href);

it("binds the public RPC/preflight APIs with parent tool ceilings and required child packages", async () => {
  const paths = ensureProjectExists("runtime");
  const session = await createSession("runtime", paths);
  const host = subagentHost("runtime", session.sessionId);
  const status = await host.rpc("status");
  expect(status.asyncSnapshot).toMatchObject({ version: 1, runs: [] });
  const preview: any = await host.preflight({ agent: "statistical-reviewer", task: "Inspect data" });
  expect(preview.ok).toBe(true);
  const contract = preview.contract;
  expect(contract.tools.requiredExtensionIds).toEqual(expect.arrayContaining(["kady-guard", "kady-modal", "kady-child-runtime", "pi-web-access"]));
  expect(contract.tools.capabilityCeiling.allowedTools).toContain("modal_submit");
  expect(contract.tools.capabilityCeiling.allowedTools).not.toContain("interview");
  const prompt = await session.extensionRunner!.emitBeforeAgentStart("Review the analysis", undefined, {
    cwd: paths.sandbox, selectedTools: session.getActiveToolNames(),
    customPrompt: "Preserve the lab's reporting convention.",
    sections: { lab: "Use SI units." },
  });
  expect(prompt.systemPromptOptions.customPrompt).toBe("Preserve the lab's reporting convention.");
  expect(prompt.systemPromptOptions.sections.lab).toBe("Use SI units.");
  expect(prompt.systemPromptOptions.sections.kady_delegation).toContain("completion criteria");
  expect(prompt.systemPromptOptions.sections.kady_delegation).toContain("Verify consequential claims");
  expect(prompt.systemPromptOptions.sections.kady_specialist).toBeUndefined();
  expect((await host.preflight({ agent: "missing-agent-xyz" }) as any).ok).toBe(false);
  vi.spyOn(modalJobManager, "list").mockReturnValue([{ id: "compute", state: "running" }, { id: "done", state: "succeeded" }] as any);
  // pi-subagents asks by its own session identity: the session file.
  const owner = session.sessionFile ?? session.sessionId;
  expect(snapshotBackgroundWork(owner).items).toContainEqual({ provider: `kady-modal:runtime:${session.sessionId}`, sessionId: owner, id: "modal:compute" });
  expect(snapshotBackgroundWork("foreign-session").items).toEqual([]);
}, 30_000);

it("loads child MCP and mandatory tools with ambient extensions disabled, and meters the real factory's stream", async () => {
  const paths = ensureProjectExists("runtime");
  fs.mkdirSync(path.join(paths.sandbox, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(paths.sandbox, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures/echo-mcp-server.mjs")], exposure: "direct" } } }));
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", pathToFileURL(path.resolve(import.meta.dirname, "../src/agent/subagent-host.mjs")).href);
  vi.stubEnv("PI_SUBAGENT_CHILD", "");
  setHostMeter(handleSubagentMeter);
  const callback = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    try { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(handleSubagentMeter(req.url!.split("/").at(-1)!, JSON.parse(body)))); }
    catch (e) { res.statusCode = 400; res.end(JSON.stringify({ detail: (e as Error).message })); }
  });
  await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("KADY_INTERNAL_URL", `http://127.0.0.1:${(callback.address() as any).port}`);
  // Use the installed factory and actual SDK session. Only the provider stream
  // is replaced; this test makes no model-network requests.
  let captured: sdk.AgentSession | undefined;
  const provider = vi.fn(() => {
    const message = { role: "assistant", provider: "openrouter", model: "test", content: [{ type: "text", text: "ok" }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, stopReason: "stop", timestamp: Date.now() };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, async result() { return message; } };
  });
  const { createDefaultChildSessionFactory } = await internal("src/runs/shared/child-session.js");
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, createAgentSession: async (args: any) => {
    const result = await sdk.createAgentSession(args); captured = result.session; captured.agent.streamFunction = provider as any; return result;
  } }) });
  const required = ["kady-guard", "kady-notebook", "kady-modal", "kady-pdf-annotations", "kady-child-runtime"].map((id) => ({ id, path: path.resolve(import.meta.dirname, "../pi-packages", id, "index.ts") }));
  const errors: any[] = [];
  let child: any;
  try {
    child = await factory.create({ cwd: paths.sandbox, storage: { kind: "dir", sessionDir: paths.sessionsDir }, ambientExtensions: false, extensionPaths: required.map((r) => r.path), requiredExtensions: required, hooks: [], noSkills: true, noContextFiles: true, runtime: { agent: "researcher", orchestratorSessionId: "parent", runId: "run" }, onExtensionError: (error: any) => errors.push(error) });
    await expect.poll(() => captured!.getActiveToolNames(), { timeout: 15000 }).toContain("mcp__echo__echo");
    for (const name of ["notebook", "modal_submit", "add_pdf_annotation"]) expect(captured!.getAllTools().map((t) => t.name)).toContain(name);
    expect(errors).toEqual([]);
    const prompt = await captured!.extensionRunner!.emitBeforeAgentStart("Inspect the data", undefined, {
      cwd: paths.sandbox, customPrompt: "Keep my custom persona.",
    });
    expect(prompt.systemPromptOptions.customPrompt).toBe("Keep my custom persona.");
    expect(prompt.systemPromptOptions.sections.kady_specialist).toContain("contact_supervisor");
    expect(prompt.systemPromptOptions.sections.kady_specialist).toContain("completed, partial, or blocked");
    expect(prompt.systemPromptOptions.sections.kady_delegation).toBeUndefined();
    const stream = await captured!.agent.streamFunction({ provider: "openrouter", id: "test" } as any, { messages: [] }, {});
    await stream.result();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(sessionCostSummary("parent", "runtime").totalUsd).toBe(0.25);
    const jobFile = path.join(paths.kadyDir, "modal/jobs/child-job/job.json");
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile, JSON.stringify({ id: "child-job", state: "running", owner: { subagentSessionFile: child.sessionFile } }));
    expect(snapshotBackgroundWork(child.sessionId).items).toContainEqual({ provider: `kady-modal-child:${child.sessionId}`, sessionId: child.sessionId, id: "modal:child-job" });
    // Required safety hooks loaded even without the ambient package discovery.
    const guarded = await captured!.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "guard", toolName: "write", input: { path: "user_data/raw.csv", content: "overwrite" } });
    expect(guarded).toMatchObject({ block: true });
    // Exercise the plugin's actual watchdog Agent, including a clean review
    // with no warning tool call (the old accounting missed these entirely).
    const { createMainWatchdogReview } = await internal("src/watchdog/review.js");
    const review = createMainWatchdogReview({ cwd: paths.sandbox, model: { provider: "openrouter", id: "test", reasoning: false }, sessionManager: { getSessionId: () => "watch-parent" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }), isUsingOAuth: () => false } }, { streamFn: provider, createReadOnlyTools: () => [], getThinkingLevel: () => "off" });
    const request = { config: { main: { thinking: false }, guidance: { watchdogMd: false } }, reviewId: "review", epoch: 1, delta: "Clean", emitWarning: () => true };
    expect(await review(request)).toMatchObject({ stopReason: "stop" });
    expect(sessionCostSummary("watch-parent", "runtime").entries[0]).toMatchObject({ costUsd: 0.25, origin: { kind: "watchdog" } });
    updateProject("runtime", { spendLimitUsd: 0.5 });
    const calls = provider.mock.calls.length;
    expect(await review(request)).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/spend limit/) });
    expect(provider).toHaveBeenCalledTimes(calls);
  } finally { await child?.dispose(); await factory.dispose(); await new Promise<void>((resolve) => callback.close(() => resolve())); }
}, 30_000);

it.each([true, false])("keeps child guidance after Pi prompt filtering (inheritProjectContext=%s)", async (inheritProjectContext) => {
  const paths = ensureProjectExists("runtime");
  fs.writeFileSync(path.join(paths.sandbox, "AGENTS.md"), "LAB_CONTEXT_SENTINEL");
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const { createDefaultChildSessionFactory } = await internal("src/runs/shared/child-session.js");
  const { createChildHooks } = await internal("src/runs/shared/child-hooks.js");
  let captured: sdk.AgentSession | undefined;
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk,
    createAgentSession: async (args: any) => {
      const result = await sdk.createAgentSession(args); captured = result.session; return result;
    },
  }) });
  const runtime = { agent: "custom-reviewer", inheritProjectContext, inheritGlobalContext: true, inheritSkills: false, waitTool: { enabled: false } };
  const entry = path.resolve(import.meta.dirname, "../pi-packages/kady-child-runtime/index.ts");
  const errors: any[] = [];
  let child: any;
  try {
    child = await factory.create({ cwd: paths.sandbox, storage: { kind: "memory" },
      ambientExtensions: false, noSkills: true, noContextFiles: !inheritProjectContext,
      systemPrompt: "Custom replacement persona.", extensionPaths: [entry],
      requiredExtensions: [{ id: "kady-child-runtime", path: entry }],
      hooks: createChildHooks(runtime), runtime, onExtensionError: (error: any) => errors.push(error),
    });
    // Start with the actual loader's prompt, respecting noContextFiles rather
    // than manually injecting project context into a context-disabled launch.
    const base = { cwd: paths.sandbox, customPrompt: captured!.systemPrompt };
    const first = await captured!.extensionRunner!.emitBeforeAgentStart("Check the analysis", undefined, base);
    // Exercise the real upstream rewrite, which overrides the full prompt;
    // setting a structured section alone would silently lose our guidance.
    const rendered = first.systemPromptOptions.forceSystemPrompt!;
    expect(rendered).toBeTypeOf("string");
    expect(rendered).toContain("Custom replacement persona.");
    expect(rendered.includes("LAB_CONTEXT_SENTINEL")).toBe(inheritProjectContext);
    expect(rendered).toContain("<kady_specialist>");
    expect(rendered).toContain("contact_supervisor");
    expect(rendered).toContain("Status is not a scientific");
    expect(rendered).not.toContain("<kady_delegation>");
    const next = await captured!.extensionRunner!.emitBeforeAgentStart("Follow up", undefined, first.systemPromptOptions);
    expect(next.systemPromptOptions.forceSystemPrompt!.match(/<kady_specialist>/g)).toHaveLength(1);
    // A new turn starts from the original options, which were not mutated.
    expect(base).not.toHaveProperty("forceSystemPrompt");
    expect(errors).toEqual([]);
  } finally { await child?.dispose(); await factory.dispose(); }
}, 30_000);

it("rejects a broken required extension before a child can run", async () => {
  const paths = ensureProjectExists("runtime");
  const file = path.join(paths.sandbox, "broken.mjs"); fs.writeFileSync(file, 'throw new Error("required package broke");');
  const { createDefaultChildSessionFactory } = await internal("src/runs/shared/child-session.js");
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
  try {
    await expect(factory.create({ cwd: paths.sandbox, storage: { kind: "memory" }, ambientExtensions: false, extensionPaths: [file], requiredExtensions: [{ id: "broken", path: file }], hooks: [], noSkills: true, noContextFiles: true, runtime: { agent: "researcher" } })).rejects.toThrow(/Required child extension failed to load/);
  } finally { await factory.dispose(); }
});
