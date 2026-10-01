import { describe, expect, it } from "vitest";
import { normalizeNotebookExecution } from "./notebook-execution";
import { normalizeNotebookEntries, parseNotebookFrame } from "./notebook";

describe("notebook execution state", () => {
  it("does not accept bare completion or a fabricated verified status", () => {
    expect(normalizeNotebookExecution({ status: "completed", evidence: "  " })).toEqual({ status: "unverified" });
    expect(normalizeNotebookExecution({ status: "verified", evidence: "Trust me" })).toBeUndefined();
    expect(normalizeNotebookExecution(undefined)).toBeUndefined();
  });

  it("retains a reported completion through provisional and saved entries without promoting it to verification", () => {
    const execution = { status: "completed", evidence: "uv run python analysis.py; exit 0; derived/run-2/log.txt" };
    const entry = parseNotebookFrame({ type: "tool_start", toolName: "notebook", toolCallId: "m", args: { type: "method", title: "Analysis", execution } });
    expect(entry?.execution).toEqual(execution);
    expect(normalizeNotebookEntries([entry!])[0].execution).toEqual(execution);
    expect(normalizeNotebookEntries([{ ...entry!, execution: { status: "completed" } }])[0].execution?.status).toBe("unverified");
  });
});
