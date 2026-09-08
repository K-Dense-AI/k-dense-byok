import { describe, expect, it } from "vitest";
import { normalizeNextExperiments, nextExperimentsText, orderedExperiments, readExperimentBinding, readExperimentChoice } from "./next-experiments";
import { deriveEvidenceThreads, evidenceLinks } from "./notebook-evidence-core";
import { normalizeNotebookEntries } from "./notebook";
import { buildNotebookPrintHtml } from "./notebook-print";
import { experimentPlan, experimentView } from "../test/next-experiments-fixture";
describe("next-investigation protocol", () => {
  it("normalizes qualitative proposals, strips forged approval/information-gain fields and preserves conditional predictions", () => {
    const plan = normalizeNextExperiments({ ...experimentPlan, approved: true, informationGain: 0.99, execute: true });
    expect(plan).toEqual(experimentPlan); expect("approved" in plan).toBe(false); expect("informationGain" in plan).toBe(false);
    expect(nextExperimentsText(plan)).toContain("PREDICTED under treatment"); expect(nextExperimentsText(plan)).toContain("If inconclusive:"); expect(nextExperimentsText(plan)).toContain("not observed findings");
  });
  it("requires a prediction under every competing explanation exactly once", () => {
    const missing = structuredClone(experimentPlan); missing.experiments[0].predictions.pop(); expect(() => normalizeNextExperiments(missing)).toThrow(/predictions/);
    const duplicate = structuredClone(experimentPlan); duplicate.experiments[0].predictions[1].explanationId = "treatment"; expect(() => normalizeNextExperiments(duplicate)).toThrow(/every competing explanation/);
    const invented = structuredClone(experimentPlan); invented.experiments[0].predictions[0].explanationId = "invented"; expect(() => normalizeNextExperiments(invented)).toThrow(/unknown explanation/);
  });
  it("requires explicit decision branches, inconclusive actions, controls and justification for new collection", () => {
    for (const field of ["inconclusiveAction", "whyNewData"] as const) {
      const p = structuredClone(experimentPlan); p.experiments[1][field] = ""; expect(() => normalizeNextExperiments(p)).toThrow();
    }
    const p = structuredClone(experimentPlan); p.experiments[0].decisionBranches.pop(); expect(() => normalizeNextExperiments(p)).toThrow(/decision branches/);
    p.experiments[0].controls = []; expect(() => normalizeNextExperiments(p)).toThrow();
  });
  it("rejects cyclic/self/unknown dependencies and duplicate candidate/explanation identifiers", () => {
    const p = structuredClone(experimentPlan); p.experiments[0].dependsOn = ["balanced_followup"]; expect(() => normalizeNextExperiments(p)).toThrow(/cycle/);
    p.experiments[0].dependsOn = ["adjust_batch"]; expect(() => normalizeNextExperiments(p)).toThrow(/distinct other/);
    p.experiments[0].dependsOn = ["absent"]; expect(() => normalizeNextExperiments(p)).toThrow(/distinct other/);
    p.experiments[0].dependsOn = []; p.experiments[1].id = p.experiments[0].id; expect(() => normalizeNextExperiments(p)).toThrow(/unique/);
    p.explanations[1].id = p.explanations[0].id; expect(() => normalizeNextExperiments(p)).toThrow(/unique/);
  });
  it("uses source and effort bounds, and requires event ids for plan references", () => {
    const p = structuredClone(experimentPlan); p.experiments[0].cost.level = 0.5 as never; expect(() => normalizeNextExperiments(p)).toThrow(/qualitative/);
    p.experiments[0].cost.level = "unknown"; p.explanations[0].sources[0] = { kind: "plan-event", entryId: "h" }; expect(() => normalizeNextExperiments(p)).toThrow(/eventId/);
    p.explanations[0].sources[0] = { kind: "notebook", sessionId: "../other", entryId: "h" }; expect(() => normalizeNextExperiments(p)).toThrow(/sessionId/);
  });
  it("rejects array/object enum coercion instead of accepting malformed planning metadata", () => {
    const plan = structuredClone(experimentPlan); plan.experiments[1].kind = ["new-data"] as never; delete plan.experiments[1].whyNewData;
    expect(() => normalizeNextExperiments(plan)).toThrow(/kind/);
    const binding = structuredClone(experimentView.proposals[0].binding!); binding.origin = ["model-generated"] as never; expect(readExperimentBinding(binding)).toBeUndefined();
    const level = structuredClone(experimentPlan); level.experiments[0].cost.level = ["low"] as never; expect(() => normalizeNextExperiments(level)).toThrow(/qualitative/);
  });
  it("orders dependencies first and existing-data checks before equal-priority collection", () => {
    const p = structuredClone(experimentPlan); p.experiments.reverse(); p.experiments[0].priority = "first"; p.experiments[1].priority = "later";
    expect(orderedExperiments(p).map((e) => e.id)).toEqual(["adjust_batch", "balanced_followup"]);
    p.experiments[0].dependsOn = []; p.experiments[1].priority = "first";
    expect(orderedExperiments(p).map((e) => e.id)).toEqual(["adjust_batch", "balanced_followup"]);
  });
  it("never counts proposal/preference links or lets predictions retire observed evidence", () => {
    const h = { id: "h", title: "Hypothesis", type: "hypothesis" as const, timestamp: 0 };
    const o = { id: "o", title: "Observation", type: "observation" as const, timestamp: 1, evidence: [{ entryId: "h", relation: "challenges" as const }] };
    const proposal = { id: "p", title: "Proposal", type: "note" as const, timestamp: 2, nextExperiments: experimentPlan, supersedes: "o", evidence: [{ entryId: "h", relation: "supports" as const }] };
    const threads = deriveEvidenceThreads([h, o, proposal]); expect(threads.get("h")?.status).toBe("refuted"); expect(threads.get("o")?.supersededBy).toBeUndefined(); expect(threads.get("p")?.unresolvedLinks).toBe(1);
    expect(evidenceLinks(proposal)[0].relation).toBe("context");
    expect(deriveEvidenceThreads([h, { ...proposal, supersedes: undefined }]).get("h")?.status).toBe("open");
  });
  it("defensively reads metadata and preserves planning fields in normalized/print exports without active markup", () => {
    expect(readExperimentBinding({ origin: "model-generated", sourceDigests: {} })).toBeUndefined(); expect(readExperimentChoice({})).toBeUndefined();
    expect(readExperimentBinding(experimentView.proposals[0].binding)).toEqual(experimentView.proposals[0].binding);
    const p = structuredClone(experimentPlan); p.experiments[0].method = '<img src="https://should-not-load">';
    const e = normalizeNotebookEntries([{ id: "p", type: "note", timestamp: 1000, title: "Proposed tests", nextExperiments: p, nextExperimentBinding: experimentView.proposals[0].binding }])[0];
    expect(e.proposalOnly).toBe(true); expect(e.nextExperiments).toEqual(p);
    const html = buildNotebookPrintHtml([e], {}); expect(html).toContain("PREDICTED under treatment"); expect(html).toContain("&lt;img"); expect(html).not.toContain('<img src="https://should-not-load">');
  });
});
