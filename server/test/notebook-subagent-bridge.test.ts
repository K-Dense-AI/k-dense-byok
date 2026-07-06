import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeSubagentNotebookExtension } from "../src/agent/notebook-bridge.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";
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
});
