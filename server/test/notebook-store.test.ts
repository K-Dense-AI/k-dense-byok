import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
  appendNewNotebookEntries,
  appendNotebookEntry,
  readNotebookEntries,
  readProjectNotebooks,
  type NotebookEntry,
} from "../src/agent/notebook-store.ts";

const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "tc_1",
  type: "hypothesis",
  title: "Six populations recoverable",
  timestamp: 1_000,
  role: "agent",
  ...over,
});

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("notebook-store", () => {
  it("returns [] for a session with no notebook file", () => {
    expect(readNotebookEntries("nope-session")).toEqual([]);
  });

  it("appends entries and reads them back in order", () => {
    const s = "sess-store-a";
    appendNotebookEntry(s, entry({ id: "tc_1", timestamp: 1 }));
    appendNotebookEntry(s, entry({ id: "tc_2", timestamp: 2, type: "observation" }));
    const got = readNotebookEntries(s);
    expect(got.map((e) => e.id)).toEqual(["tc_1", "tc_2"]);
    expect(got[1].type).toBe("observation");
  });

  it("skips malformed lines instead of throwing", () => {
    const s = "sess-store-b";
    appendNotebookEntry(s, entry({ id: "ok" }));
    const { notebookPath } = require("../src/agent/notebook-store.ts");
    require("node:fs").appendFileSync(notebookPath(s), "{not json\n");
    expect(readNotebookEntries(s).map((e) => e.id)).toEqual(["ok"]);
  });

  it("rejects a traversal session id", () => {
    expect(() => readNotebookEntries("../../etc")).toThrow(/Invalid session id/);
  });

  it("round-trips the new link fields and reads a legacy row that lacks them", () => {
    const s = "sess-store-links";
    appendNotebookEntry(s, entry({ id: "linked", relatesTo: "prev", stance: "supports", supersedes: "old" }));
    appendNotebookEntry(s, entry({ id: "legacy" }));
    const got = readNotebookEntries(s);
    expect(got[0]).toMatchObject({ relatesTo: "prev", stance: "supports", supersedes: "old" });
    // A legacy-shaped row simply has no link fields.
    expect("relatesTo" in got[1]).toBe(false);
    expect("runId" in got[1]).toBe(false);
  });
});

describe("appendNewNotebookEntries", () => {
  it("skips ids already present so a restart cannot re-harvest a child's history", () => {
    const s = "sess-harvest";
    const first = appendNewNotebookEntries(s, [
      entry({ id: "child:1", timestamp: 1 }),
      entry({ id: "child:2", timestamp: 2 }),
    ]);
    expect(first.map((e) => e.id)).toEqual(["child:1", "child:2"]);

    // Harvest re-reads the child's whole session file; the parent notebook is
    // the durable record of what has already landed.
    const second = appendNewNotebookEntries(s, [
      entry({ id: "child:1", timestamp: 1 }),
      entry({ id: "child:2", timestamp: 2 }),
      entry({ id: "child:3", timestamp: 3 }),
    ]);
    expect(second.map((e) => e.id)).toEqual(["child:3"]);
    expect(readNotebookEntries(s).map((e) => e.id)).toEqual([
      "child:1",
      "child:2",
      "child:3",
    ]);
  });

  it("dedupes within a single batch and ignores id-less rows", () => {
    const s = "sess-harvest-dupes";
    const written = appendNewNotebookEntries(s, [
      entry({ id: "a" }),
      entry({ id: "a" }),
      entry({ id: "" }),
    ]);
    expect(written.map((e) => e.id)).toEqual(["a"]);
    expect(readNotebookEntries(s)).toHaveLength(1);
  });

  it("writes nothing for an empty batch", () => {
    expect(appendNewNotebookEntries("sess-harvest-empty", [])).toEqual([]);
    expect(readNotebookEntries("sess-harvest-empty")).toEqual([]);
  });
});

describe("readProjectNotebooks", () => {
  it("returns [] when the notebook dir does not exist", () => {
    expect(readProjectNotebooks("default")).toEqual([]);
  });

  it("enumerates each session's notebook sorted, skipping non-notebook files", () => {
    const projectId = "default";
    appendNotebookEntry("sess-b", entry({ id: "b1", timestamp: 1 }), projectId);
    appendNotebookEntry("sess-a", entry({ id: "a1", timestamp: 1 }), projectId);
    appendNotebookEntry("sess-a", entry({ id: "a2", timestamp: 2 }), projectId);

    const dir = resolvePaths(projectId).notebookDir;
    // The .annotations.json sidecar and an invalid-name file must both be ignored.
    fs.writeFileSync(path.join(dir, "sess-a.annotations.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(dir, "bad name.jsonl"), "{}", "utf-8");

    const nbs = readProjectNotebooks(projectId);
    expect(nbs.map((n) => n.sessionId)).toEqual(["sess-a", "sess-b"]);
    expect(nbs[0].entries.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(nbs[1].entries.map((e) => e.id)).toEqual(["b1"]);
  });
});
