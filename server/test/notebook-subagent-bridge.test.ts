import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  makeSubagentNotebookExtension,
  seedBuiltinAgentNotebookTools,
} from "../src/agent/notebook-bridge.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";
import { setSessionRunId } from "../src/agent/run-ids.ts";
import { resolvePaths } from "../src/projects.ts";
import { PROJECTS_ROOT } from "../src/config.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

/** Fake ExtensionAPI capturing the handlers the extension registers. */
function fakePi() {
  const onHandlers: Record<string, (e: unknown) => unknown> = {};
  const eventHandlers: Record<string, (d: unknown) => unknown> = {};
  return {
    onHandlers,
    eventHandlers,
    api: {
      on: (name: string, h: (e: unknown) => unknown) => { onHandlers[name] = h; },
      events: { on: (name: string, h: (d: unknown) => unknown) => { eventHandlers[name] = h; } },
      registerTool: () => {},
    },
  };
}

function writeChildSession(projectId: string, name: string): string {
  const paths = resolvePaths(projectId);
  const dir = path.join(paths.sandbox, ".pi", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  const row = JSON.stringify({
    type: "message",
    timestamp: "2026-07-05T20:49:15.610Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_c1", name: "notebook", arguments: { type: "observation", title: "child result" } }],
    },
  });
  fs.writeFileSync(f, row + "\n", "utf-8");
  return f;
}

describe("makeSubagentNotebookExtension", () => {
  it("harvests child notebook entries into the parent notebook on tool_result, deduped", () => {
    const projectId = "default";
    const parentSession = "parent-sess";
    const childFile = writeChildSession(projectId, "child.jsonl");

    const pi = fakePi();
    const ext = makeSubagentNotebookExtension(projectId, () => parentSession);
    ext(pi.api as never);

    const evt = {
      toolName: "subagent",
      details: { results: [{ agent: "stats-checker", sessionFile: childFile }] },
    };
    // deliver twice — second must be a no-op (dedup)
    pi.onHandlers["tool_result"](evt);
    pi.onHandlers["tool_result"](evt);

    const entries = readNotebookEntries(parentSession, projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "stats-checker:toolu_c1",
      role: "stats-checker",
      type: "observation",
      title: "child result",
    });
  });

  it("ignores non-subagent tool_result events", () => {
    const pi = fakePi();
    makeSubagentNotebookExtension("default", () => "p2")(pi.api as never);
    pi.onHandlers["tool_result"]({ toolName: "bash", details: {} });
    expect(readNotebookEntries("p2", "default")).toEqual([]);
  });

  it("stamps harvested entries with the parent's in-flight run id (tool_result)", () => {
    const projectId = "default";
    const parentSession = "parent-run-sync";
    // Distinct child file per case so the module-level harvestedIds dedup never
    // suppresses a fresh harvest.
    const childFile = writeChildSession(projectId, "child-sync.jsonl");

    setSessionRunId(parentSession, "run_y");
    const pi = fakePi();
    makeSubagentNotebookExtension(projectId, () => parentSession)(pi.api as never);
    pi.onHandlers["tool_result"]({
      toolName: "subagent",
      details: { results: [{ agent: "stats-checker", sessionFile: childFile }] },
    });
    setSessionRunId(parentSession, null);

    const entries = readNotebookEntries(parentSession, projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe("run_y");
  });

  it("stamps harvested entries with the run id on subagent:async-complete", () => {
    const projectId = "default";
    const parentSession = "parent-run-async";
    const childFile = writeChildSession(projectId, "child-async.jsonl");

    setSessionRunId(parentSession, "run_z");
    const pi = fakePi();
    makeSubagentNotebookExtension(projectId, () => parentSession)(pi.api as never);
    pi.eventHandlers["subagent:async-complete"]({
      results: [{ agent: "scout", sessionFile: childFile }],
    });
    setSessionRunId(parentSession, null);

    const entries = readNotebookEntries(parentSession, projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe("run_z");
  });

  it("leaves harvested entries unstamped when no run is live", () => {
    const projectId = "default";
    const parentSession = "parent-no-run";
    const childFile = writeChildSession(projectId, "child-norun.jsonl");

    setSessionRunId(parentSession, null); // explicit: no run in flight
    const pi = fakePi();
    makeSubagentNotebookExtension(projectId, () => parentSession)(pi.api as never);
    pi.onHandlers["tool_result"]({
      toolName: "subagent",
      details: { results: [{ agent: "worker", sessionFile: childFile }] },
    });

    const entries = readNotebookEntries(parentSession, projectId);
    expect(entries).toHaveLength(1);
    expect("runId" in entries[0]).toBe(false);
  });
});

describe("seedBuiltinAgentNotebookTools", () => {
  function readSettings(projectId: string): Record<string, unknown> {
    const paths = resolvePaths(projectId);
    const file = path.join(paths.sandbox, ".pi", "settings.json");
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  }

  it("appends notebook to every builtin agent that pins a tools allowlist", () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(paths.sandbox, { recursive: true });

    expect(seedBuiltinAgentNotebookTools(paths)).toBe(true);

    const settings = readSettings("default");
    const overrides = (settings.subagents as Record<string, unknown>)
      .agentOverrides as Record<string, { tools?: string[] }>;
    // researcher ships with a tools allowlist in pi-subagents — the exact list
    // tracks the installed package, but notebook must be appended after it.
    const researcher = overrides.researcher;
    expect(researcher?.tools).toBeDefined();
    expect(researcher.tools).toContain("notebook");
    expect(researcher.tools).toContain("web_search");
    expect(researcher.tools?.at(-1)).toBe("notebook");
    for (const override of Object.values(overrides)) {
      expect(override.tools).toContain("notebook");
    }
  });

  it("is idempotent and preserves other override fields (e.g. disabled)", () => {
    const paths = resolvePaths("default");
    const dir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        packages: ["/x/kady-notebook"],
        subagents: { agentOverrides: { researcher: { disabled: true } } },
      }),
      "utf-8",
    );

    expect(seedBuiltinAgentNotebookTools(paths)).toBe(true);
    expect(seedBuiltinAgentNotebookTools(paths)).toBe(false); // second run: no-op

    const settings = readSettings("default");
    const overrides = (settings.subagents as Record<string, unknown>)
      .agentOverrides as Record<string, { tools?: string[]; disabled?: boolean }>;
    expect(overrides.researcher.disabled).toBe(true);
    expect(overrides.researcher.tools).toContain("notebook");
    expect(settings.packages).toEqual(["/x/kady-notebook"]);
  });

  it("leaves a user-pinned tools override untouched", () => {
    const paths = resolvePaths("default");
    const dir = path.join(paths.sandbox, ".pi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        subagents: { agentOverrides: { researcher: { tools: ["read"] } } },
      }),
      "utf-8",
    );

    seedBuiltinAgentNotebookTools(paths);

    const settings = readSettings("default");
    const overrides = (settings.subagents as Record<string, unknown>)
      .agentOverrides as Record<string, { tools?: string[] }>;
    expect(overrides.researcher.tools).toEqual(["read"]);
  });
});
