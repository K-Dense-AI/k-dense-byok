import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import factory, {
  makeModalChildTools,
  modalChildTools,
  ModalJobIdParams as ChildJobIdParams,
  ModalRunParams as ChildRunParams,
  ModalSubmitBatchParams as ChildBatchParams,
  ModalWaitParams as ChildWaitParams,
} from "../pi-packages/kady-modal/index.ts";
import { modalProjectId } from "../pi-packages/kady-modal/project-id.ts";
import {
  ModalJobIdParams as LeadJobIdParams,
  ModalRunParams as LeadRunParams,
  ModalSubmitBatchParams as LeadBatchParams,
  ModalWaitParams as LeadWaitParams,
  MODAL_TOOL_NAMES,
} from "../src/agent/modal-tool.ts";
import {
  kadyModalPackageDir,
  seedBuiltinAgentModalTools,
  seedModalPackage,
} from "../src/agent/modal-bridge.ts";
import { seedBuiltinAgentNotebookTools } from "../src/agent/notebook-bridge.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { modalJobManager } from "../src/modal/manager.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { FakeModal } from "./helpers/fake-modal.ts";

const properties = (schema: unknown) =>
  (schema as { properties?: Record<string, unknown> }).properties ?? {};

type ToolResult = { content: { type: string; text: string }[]; details?: unknown };

/** Run one child tool the way Pi does (toolCallId, params, signal, onUpdate, ctx). */
async function exec(
  tools: ToolDefinition<any>[],
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no child tool ${name}`);
  return (await tool.execute("tc", params, signal, undefined, undefined as never)) as ToolResult;
}

const text = (result: ToolResult) => result.content[0]?.text ?? "";

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const originalChild = process.env.PI_SUBAGENT_CHILD;
const originalProject = process.env.KADY_PROJECT_ID;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  // vitest's cwd (server/) has no `sandbox/` ancestor, so the child package
  // needs the explicit project id a real runner would otherwise derive.
  process.env.KADY_PROJECT_ID = "default";
});

afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
  if (originalProject === undefined) delete process.env.KADY_PROJECT_ID;
  else process.env.KADY_PROJECT_ID = originalProject;
});

describe("kady-modal child package", () => {
  it("registers the complete tool set only in child processes", () => {
    const registered: { name: string }[] = [];
    process.env.PI_SUBAGENT_CHILD = "1";
    factory({ registerTool: (tool: { name: string }) => registered.push(tool) } as never);
    expect(registered.map((tool) => tool.name)).toEqual([...MODAL_TOOL_NAMES]);

    delete process.env.PI_SUBAGENT_CHILD;
    const parent: unknown[] = [];
    factory({ registerTool: (tool: unknown) => parent.push(tool) } as never);
    expect(parent).toEqual([]);
    expect(modalChildTools.map((tool) => tool.name)).toEqual([...MODAL_TOOL_NAMES]);
  });

  it("stamps submissions with the child's session file for parent attribution", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ id: "job-1", state: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const sessionFile = "/tmp/pi-sessions/child.jsonl";
      const tools = makeModalChildTools(() => ({ sessionFile, sessionId: "sess-1" }));
      await exec(tools, "modal_submit", { command: "echo hi" });
      await exec(tools, "modal_submit_batch", { jobs: [{ command: "echo a" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ""))).toEqual([
      "/modal/jobs",
      "/modal/jobs/batch",
    ]);
    for (const call of calls) {
      expect(call.body.subagent_session_file).toBe("/tmp/pi-sessions/child.jsonl");
      expect(call.body).not.toHaveProperty("subagent_run_id");
      expect(call.headers["X-Project-Id"]).toBe("default");
      expect(call.headers["Content-Type"]).toBe("application/json");
    }
    // Identity-less tools (schema parity export) send neither key.
    const bare: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bare.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "job-2", state: "queued" }), { status: 200 });
    }) as typeof fetch;
    try {
      await exec(modalChildTools, "modal_submit", { command: "echo bare" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(bare[0]).not.toHaveProperty("subagent_session_file");
    expect(bare[0]).not.toHaveProperty("subagent_run_id");
  });

  it("sends a JSON content-type only with a body, and always a body on cancel", async () => {
    const seen: { method: string; url: string; body: unknown; contentType?: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({
        method: init?.method ?? "GET",
        url: String(url).replace(/^https?:\/\/[^/]+/, ""),
        body: init?.body,
        contentType: headers["Content-Type"],
      });
      return new Response(
        JSON.stringify({ job: { id: "job-3", state: "running" }, id: "job-3", state: "cancelled", events: [] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      await exec(modalChildTools, "modal_status", { job_id: "job-3" });
      await exec(modalChildTools, "modal_cancel", { job_id: "job-3" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen[0]).toMatchObject({ method: "GET", body: undefined, contentType: undefined });
    expect(seen[0].url.startsWith("/modal/jobs/job-3")).toBe(true);
    expect(seen[1]).toMatchObject({
      method: "POST",
      url: "/modal/jobs/job-3/cancel",
      body: "{}",
      contentType: "application/json",
    });
  });

  it("surfaces the API error code and retryable flag instead of a flat MODAL_FAILURE", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "BUDGET_EXCEEDED",
          detail: "Project spend cap reached",
          retryable: false,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const out = await exec(modalChildTools, "modal_submit", { command: "echo" });
      expect(out.details).toMatchObject({ error: "BUDGET_EXCEEDED", retryable: false });
      expect(text(out)).toContain("Project spend cap reached");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tolerates transport errors while waiting and reads events incrementally", async () => {
    const urls: string[] = [];
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url).replace(/^https?:\/\/[^/]+/, ""));
      call += 1;
      // The server restarting between polls surfaces as undici's TypeError.
      if (call === 1) throw new TypeError("fetch failed");
      if (call === 2) {
        return new Response(
          JSON.stringify({ job: { id: "job-4", state: "running" }, events: [{ seq: 1 }, { seq: 3 }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ job: { id: "job-4", state: "succeeded" }, events: [] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const out = await exec(modalChildTools, "modal_wait", { job_id: "job-4", timeout_sec: 10 });
      expect(out.details).toMatchObject({ id: "job-4", state: "succeeded" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toEqual([
      "/modal/jobs/job-4?eventsAfter=0",
      "/modal/jobs/job-4?eventsAfter=0",
      "/modal/jobs/job-4?eventsAfter=3",
    ]);
  });

  it("gives up waiting after repeated transport errors, naming the transport failure", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      // timeout_sec 0 means a single read: the deadline has passed by the first
      // failure, so the loop must throw instead of sleeping.
      const out = await exec(modalChildTools, "modal_wait", { job_id: "job-5", timeout_sec: 0 });
      expect(out.details).toMatchObject({ error: "MODAL_FAILURE" });
      expect(text(out)).toContain("fetch failed");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps transfer manifests and drops server-internal fields in job JSON", async () => {
    const files = Array.from({ length: 120 }, (_, i) => ({ path: `out/${i}.bin`, size: 1, sha256: "0".repeat(64) }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "job-6",
          state: "succeeded",
          inputFiles: files,
          outputFiles: files,
          missingOutputs: [],
          sandboxTags: { kady: "true" },
          approval: { batchId: "b1" },
          accounting: { reconciled: true, estimatedCostUsd: 0.01, ledgerEntryId: "le-1" },
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const out = await exec(modalChildTools, "modal_submit", { command: "echo" });
      const details = out.details as Record<string, unknown>;
      expect(details).not.toHaveProperty("sandboxTags");
      expect(details).not.toHaveProperty("approval");
      expect(details.accounting).toEqual({ reconciled: true, estimatedCostUsd: 0.01 });
      const outputs = details.outputFiles as unknown[];
      expect(outputs).toHaveLength(51);
      expect(outputs[50]).toBe("… 70 more");
      expect((details.inputFiles as unknown[])[50]).toBe("… 70 more");
      expect(text(out)).toContain("… 70 more");
      expect(text(out)).not.toContain("out/119.bin");
      expect(text(out).length).toBeLessThan(16_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps lead and child request/control schemas in parity", () => {
    expect(ChildRunParams).toEqual(LeadRunParams);
    expect(ChildJobIdParams).toEqual(LeadJobIdParams);
    expect(ChildWaitParams).toEqual(LeadWaitParams);
    expect(ChildBatchParams).toEqual(LeadBatchParams);
    expect(Object.keys(properties(ChildRunParams)).sort()).toEqual(
      Object.keys(properties(LeadRunParams)).sort(),
    );
    expect(Object.keys(properties(ChildJobIdParams)).sort()).toEqual(
      Object.keys(properties(LeadJobIdParams)).sort(),
    );
    expect(Object.keys(properties(ChildWaitParams)).sort()).toEqual(
      Object.keys(properties(LeadWaitParams)).sort(),
    );
    expect(Object.keys(properties(ChildBatchParams)).sort()).toEqual(
      Object.keys(properties(LeadBatchParams)).sort(),
    );
  });

  it("seeds the child package and extends generated builtin allowlists idempotently", () => {
    const paths = ensureProjectExists("default");
    expect(seedModalPackage(paths)).toBe(true);
    expect(seedModalPackage(paths)).toBe(false);
    const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      packages: string[];
    };
    expect(settings.packages).toContain(kadyModalPackageDir());

    // notebook runs immediately before modal during a real session build.
    seedBuiltinAgentNotebookTools(paths);
    seedBuiltinAgentModalTools(paths);
    const updated = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as any;
    const tools = updated.subagents.agentOverrides.researcher.tools as string[];
    for (const name of MODAL_TOOL_NAMES) expect(tools).toContain(name);
    expect(seedBuiltinAgentModalTools(paths)).toBe(false);
  });

  it("does not override a user-pinned builtin tool list", () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(path.join(paths.sandbox, ".pi"), { recursive: true });
    const file = path.join(paths.sandbox, ".pi", "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        subagents: { agentOverrides: { researcher: { tools: ["read"] } } },
      }),
      "utf-8",
    );
    seedBuiltinAgentModalTools(paths);
    const settings = JSON.parse(fs.readFileSync(file, "utf-8")) as any;
    expect(settings.subagents.agentOverrides.researcher.tools).toEqual(["read"]);
  });
});

describe("kady-modal child project resolution", () => {
  // `""` means "no explicit id": passing `undefined` would select the default
  // parameter, i.e. the KADY_PROJECT_ID this file sets for the child package.
  const noExplicit = "";

  it("walks up from a sandbox subdirectory to the project's own id", () => {
    const paths = ensureProjectExists("default");
    const deep = path.join(paths.sandbox, "user_data", "runs", "deep");
    fs.mkdirSync(deep, { recursive: true });
    expect(modalProjectId(deep, noExplicit)).toBe("default");
    expect(modalProjectId(paths.sandbox, noExplicit)).toBe("default");
    // An explicit id that agrees is fine; one that conflicts is refused.
    expect(modalProjectId(deep, "default")).toBe("default");
    expect(() => modalProjectId(deep, "other")).toThrow(/conflicts/);
  });

  it("refuses to guess when there is no sandbox ancestor and no explicit id", () => {
    expect(() => modalProjectId(PROJECTS_ROOT, noExplicit)).toThrow(/refusing to guess/);
    expect(() => modalProjectId(PROJECTS_ROOT, "../etc")).toThrow(/invalid/);
    expect(modalProjectId(PROJECTS_ROOT, "explicit-project")).toBe("explicit-project");
    // The default parameter is the env var a real runner exports.
    expect(modalProjectId(PROJECTS_ROOT)).toBe("default");
  });

  it("refuses a sandbox whose project metadata is missing or does not match", () => {
    const stray = path.join(PROJECTS_ROOT, "someone", "sandbox", "work");
    fs.mkdirSync(stray, { recursive: true });
    expect(() => modalProjectId(stray, noExplicit)).toThrow(/metadata is unavailable/);
    fs.writeFileSync(
      path.join(PROJECTS_ROOT, "someone", "project.json"),
      JSON.stringify({ id: "different" }),
    );
    expect(() => modalProjectId(stray, noExplicit)).toThrow(/metadata is unavailable/);
    // An explicit id never overrides a sandbox that cannot vouch for itself.
    expect(() => modalProjectId(stray, "someone")).toThrow(/metadata is unavailable/);
  });
});

/**
 * The child package talks to the Kady API over loopback HTTP. These tests run
 * the child tools against the real Fastify app (via `app.inject`) so header and
 * body handling is exercised end to end — a body-less cancel POST that claimed
 * `Content-Type: application/json` used to be rejected with 400
 * FST_ERR_CTP_EMPTY_JSON_BODY, so a child could never cancel a job.
 */
describe("kady-modal child package over the real HTTP API", () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.LOG_LEVEL;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fake: FakeModal;
  // Fire-and-forget calls (the abort-path cancel) may still be inside a route
  // handler when a test ends; drain them so they cannot land in the next test.
  const inFlight = new Set<Promise<unknown>>();

  beforeEach(async () => {
    ensureProjectExists("default");
    fake = new FakeModal();
    modalJobManager.setAdapterFactoryForTests(fake.factory);
    process.env.LOG_LEVEL = "warn";
    app = await buildApp();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Forward every header verbatim; Content-Type is what reproduces the bug.
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const request = app
        .inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: `${url.pathname}${url.search}`,
          headers,
          payload: init?.body === undefined ? undefined : String(init.body),
        })
        .then((res) => {
          const contentType = res.headers["content-type"];
          return new Response(res.body, {
            status: res.statusCode,
            headers: contentType ? { "content-type": String(contentType) } : undefined,
          });
        });
      inFlight.add(request);
      void request.finally(() => inFlight.delete(request));
      return request;
    }) as typeof fetch;
  });

  afterEach(async () => {
    // Leave no live worker behind: a hung fake sandbox would keep polling.
    for (const job of modalJobManager.store.list("default")) {
      await modalJobManager.cancel("default", job.id).catch(() => {});
    }
    await Promise.allSettled([...inFlight]);
    globalThis.fetch = originalFetch;
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    await app.close();
  });

  it("cancels a child-submitted job through the API", async () => {
    fake.behaviors.push({ kind: "hang" });
    const tools = makeModalChildTools(() => ({ sessionFile: "/tmp/pi-sessions/child-a.jsonl" }));
    const submitted = await exec(tools, "modal_submit", { command: "sleep 999" });
    const jobId = (submitted.details as { id?: string }).id;
    expect(typeof jobId).toBe("string");
    expect(["queued", "preparing", "running"]).toContain((submitted.details as { state: string }).state);

    const cancelled = await exec(tools, "modal_cancel", { job_id: jobId! });
    expect(text(cancelled)).not.toContain("Bad Request");
    expect(text(cancelled)).not.toContain("failed");
    expect(cancelled.details).toMatchObject({ id: jobId, state: "cancelled" });
    expect(modalJobManager.get("default", jobId!).state).toBe("cancelled");
  });

  it("modal_run returns at timeout_sec with a still-running notice instead of blocking", async () => {
    fake.behaviors.push({ kind: "hang" });
    const tools = makeModalChildTools();
    const started = Date.now();
    const run = await exec(tools, "modal_run", { command: "sleep 999", timeout_sec: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    const details = run.details as { id: string; state: string; error?: unknown };
    expect(details.error).toBeUndefined();
    expect(["queued", "preparing", "running"]).toContain(details.state);
    expect(text(run)).toContain("still");
    expect(text(run)).toContain(details.id);
    expect(text(run)).toMatch(/modal_wait\/modal_results/);
    expect(text(run)).toContain("--- stdout ---");

    const job = await modalJobManager.cancel("default", details.id);
    expect(job.state).toBe("cancelled");
  });

  it("aborting modal_run cancels the remote job and stops polling", async () => {
    fake.behaviors.push({ kind: "hang" });
    const tools = makeModalChildTools();
    const controller = new AbortController();
    const pending = exec(tools, "modal_run", { command: "sleep 999" }, controller.signal);
    await waitUntil(() => modalJobManager.store.list("default").length === 1);
    controller.abort();
    const outcome = await pending;
    const jobId = modalJobManager.store.list("default")[0].id;
    expect(outcome.details).toMatchObject({ error: "ABORTED", job_id: jobId });

    const job = await modalJobManager.wait("default", jobId, 3000);
    expect(job.state).toBe("cancelled");
  });

  it("bounds results text: large stdout is tail-truncated like the lead tool", async () => {
    const stdout = "line of remote output\n".repeat(5_000); // ~110 KiB
    fake.behaviors.push({ kind: "success", stdout });
    const tools = makeModalChildTools();
    const run = await exec(tools, "modal_run", { command: "echo big" });
    expect(run.details).toMatchObject({ state: "succeeded" });
    expect(text(run)).not.toContain("still");
    expect(text(run).length).toBeLessThanOrEqual(20_000);
    expect(text(run)).toContain("earlier characters truncated");
    const jobId = (run.details as { id: string }).id;

    const results = await exec(tools, "modal_results", { job_id: jobId });
    expect(text(results).length).toBeLessThanOrEqual(20_000);
    expect(text(results)).toContain("earlier characters truncated");
    expect(text(results)).toContain("--- stdout ---");
    // Tail-truncated: the *end* of stdout survives, followed by the stderr section.
    expect(text(results)).toMatch(/line of remote output\n+--- stderr ---\n\(empty\)$/);
    const details = results.details as Record<string, unknown>;
    expect(details).toMatchObject({ id: jobId, state: "succeeded" });
    expect(details).not.toHaveProperty("stdout");
    expect(details).not.toHaveProperty("sandboxTags");
    expect(details.accounting).not.toHaveProperty("ledgerEntryId");
  });
});
