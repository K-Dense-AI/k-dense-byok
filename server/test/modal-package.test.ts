import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import factory, {
  makeModalChildTools,
  modalChildTools,
  ModalJobIdParams as ChildJobIdParams,
  ModalRunParams as ChildRunParams,
  ModalSubmitBatchParams as ChildBatchParams,
  ModalWaitParams as ChildWaitParams,
} from "../pi-packages/kady-modal/index.ts";
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
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";

const properties = (schema: unknown) =>
  (schema as { properties?: Record<string, unknown> }).properties ?? {};

const originalChild = process.env.PI_SUBAGENT_CHILD;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
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
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "job-1", state: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const sessionFile = "/tmp/pi-sessions/child.jsonl";
      const tools = makeModalChildTools(() => ({ sessionFile, sessionId: "sess-1" }));
      const submit = tools.find((tool) => tool.name === "modal_submit")!;
      await submit.execute("tc", { command: "echo hi" }, undefined as never);
      const batch = tools.find((tool) => tool.name === "modal_submit_batch")!;
      await batch.execute("tc2", { jobs: [{ command: "echo a" }] }, undefined as never);
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
    }
    // Identity-less tools (schema parity export) send neither key.
    const bare: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bare.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "job-2", state: "queued" }), { status: 200 });
    }) as typeof fetch;
    try {
      await modalChildTools
        .find((tool) => tool.name === "modal_submit")!
        .execute("tc3", { command: "echo bare" }, undefined as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(bare[0]).not.toHaveProperty("subagent_session_file");
    expect(bare[0]).not.toHaveProperty("subagent_run_id");
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
