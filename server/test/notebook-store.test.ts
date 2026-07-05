import fs from "node:fs";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  appendNotebookEntry,
  readNotebookEntries,
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
});
