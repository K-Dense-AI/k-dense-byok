import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import {
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
