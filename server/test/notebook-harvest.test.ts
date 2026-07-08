import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { notebookEntriesFromSessionFile } from "../src/agent/notebook-harvest.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-harvest-"));
});

/** One assistant message row carrying the given content blocks. */
const asstRow = (content: unknown[], ts = "2026-07-05T20:49:15.610Z") =>
  JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: ts,
    message: { role: "assistant", content, timestamp: ts },
  });

const toolCall = (id: string, name: string, args: unknown) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function writeSession(name: string, rows: string[]): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, rows.join("\n") + "\n", "utf-8");
  return f;
}

describe("notebookEntriesFromSessionFile", () => {
  it("extracts notebook tool-calls, stamping role and a namespaced id", () => {
    const f = writeSession("s.jsonl", [
      asstRow([
        toolCall("toolu_1", "notebook", {
          type: "hypothesis",
          title: "Six clusters",
          confidence: "high",
          artifacts: ["figures/fig.png"],
        }),
      ]),
      asstRow([toolCall("toolu_2", "bash", { command: "ls" })]), // ignored
      asstRow([
        toolCall("toolu_3", "notebook", { type: "observation", title: "ARI 0.995" }),
      ]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "stats-checker");
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      id: "stats-checker:toolu_1",
      role: "stats-checker",
      type: "hypothesis",
      title: "Six clusters",
      confidence: "high",
      artifacts: ["figures/fig.png"],
    });
    expect(typeof got[0].timestamp).toBe("number");
    expect(got[1].id).toBe("stats-checker:toolu_3");
    expect(got[1].type).toBe("observation");
  });

  it("returns [] for a missing file", () => {
    expect(notebookEntriesFromSessionFile(path.join(dir, "nope.jsonl"), "a")).toEqual([]);
  });

  it("skips malformed rows and invalid entries (bad type, blank title)", () => {
    const f = writeSession("s2.jsonl", [
      "{not json",
      asstRow([toolCall("toolu_1", "notebook", { type: "bogus", title: "x" })]),
      asstRow([toolCall("toolu_2", "notebook", { type: "note", title: "   " })]),
      asstRow([toolCall("toolu_3", "notebook", { type: "note", title: "kept" })]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "a");
    expect(got.map((e) => e.title)).toEqual(["kept"]);
  });

  it("namespaces relatesTo/supersedes with the agent name, keeps a valid stance, ignores runId", () => {
    const f = writeSession("s3.jsonl", [
      asstRow([
        toolCall("toolu_10", "notebook", {
          type: "observation",
          title: "linked",
          relatesTo: "toolu_1",
          stance: "supports",
          supersedes: "toolu_0",
          runId: "run_injected",
        }),
      ]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "scout");
    expect(got[0]).toMatchObject({
      relatesTo: "scout:toolu_1",
      supersedes: "scout:toolu_0",
      stance: "supports",
    });
    // runId is stamped by the parent at append time — never read from child args.
    expect("runId" in got[0]).toBe(false);
    expect(got[0].runId).toBeUndefined();
  });

  it("drops an invalid stance value", () => {
    const f = writeSession("s4.jsonl", [
      asstRow([
        toolCall("toolu_11", "notebook", {
          type: "observation",
          title: "bad stance",
          relatesTo: "toolu_1",
          stance: "maybe",
        }),
      ]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "scout");
    expect(got[0].relatesTo).toBe("scout:toolu_1");
    expect(got[0].stance).toBeUndefined();
  });
});
