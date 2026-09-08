import { describe, expect, it } from "vitest";
import { normalizeAnalysisPlan, planHistoryText, type AnalysisPlanInput, type AnalysisPlanHistory, type FrozenPlanEvent } from "./notebook-plans";
import { buildNotebookPrintHtml } from "./notebook-print";
const plan: AnalysisPlanInput = { hypothesis: "Treatment effect", primaryOutcome: "Mean score", exclusions: "QC only", model: "Linear model", multiplicity: "One test", qc: "No missingness", stopping: "100 samples", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
const source = { sessionId: "s", entryId: "h" };
const frozen: FrozenPlanEvent = { version: 1, kind: "freeze", id: "plan-1", sequence: 1, previousDigest: null, digest: "digest", source, actor: "user", recordedAt: 1000, revision: 1, previewId: "preview", plan, datasets: [{ path: "data.csv", capturedAt: 1000, reason: "missing" }], revisionReason: "", acknowledgedUnverified: true, sourceDigest: "source" };
const history: AnalysisPlanHistory = { source, head: "digest-2", events: [frozen, { version: 1, kind: "deviation", id: "d1", sequence: 2, previousDigest: "digest", digest: "digest-2", source, actor: "user", recordedAt: 2000, planId: "plan-1", field: "model", planned: "Linear model", actual: "Robust model", reason: "Heavy tails", timing: "after-results" }] };

describe("analysis-plan protocol and exports", () => {
  it("validates every scientific field and strips forged approval properties", () => {
    expect(normalizeAnalysisPlan({ ...plan, approved: true, actor: "user", digest: "fake" })).toEqual(plan);
    expect(() => normalizeAnalysisPlan({ ...plan, model: " " })).toThrow(/Statistical model/);
    expect(() => normalizeAnalysisPlan({ ...plan, datasets: [] })).toThrow(/1–8/);
    expect(() => normalizeAnalysisPlan({ ...plan, priorExposure: "verified-naive" })).toThrow(/exposure/);
  });
  it("exports every immutable revision and deviation with local-only qualifications", () => {
    const text = planHistoryText(history);
    expect(text).toContain("Frozen revision 1"); expect(text).toContain("Robust model");
    expect(text).toContain("after-results (self-reported)");
    expect(text).toContain("not external preregistration"); expect(text).toContain("unverified (missing)");
  });
  it("preserves plan/deviation and result-reference metadata in printed notebooks", () => {
    const html = buildNotebookPrintHtml([{ id: "h", type: "hypothesis", title: "Question", timestamp: 1000, planHistory: history }, { id: "o", type: "observation", title: "Finding", timestamp: 2000, results: [{ toolCallId: "r", sessionId: "s" }], resultSnapshots: [{ toolCallId: "r", sessionId: "s", status: "available", sha256: "pinned" }] }]);
    expect(html).toContain("Frozen revision 1"); expect(html).toContain("Robust model");
    expect(html).toContain("s/r · sha256 pinned");
  });
  it("does not execute or interpret plain-text plan fields as HTML", () => {
    const malicious = { ...frozen, plan: { ...plan, model: "<script>bad()</script> **not markup**" } };
    const html = buildNotebookPrintHtml([{ id: "h", type: "hypothesis", title: "Q", timestamp: 1, planHistory: { source, head: "digest", events: [malicious] } }]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("**not markup**");
  });
});
