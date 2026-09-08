import type { NextExperimentPlan, NextExperimentView } from "../lib/next-experiments";
import { memoryHit, memorySearch } from "./memory-fixture";
export const experimentSource = { sessionId: "chat-a", entryId: "hypothesis-a" };
const sources = [{ kind: "notebook" as const, ...experimentSource }];
export const experimentPlan: NextExperimentPlan = {
  target: experimentSource,
  question: "Does treatment lower marker X, or is the apparent effect a batch artifact?",
  decision: "Decide whether to pursue a treatment mechanism or resolve the batch confound first.",
  existingDataAssessment: "Inspect saved batch labels and negative controls before collecting new specimens; batch overlap is not yet known.",
  explanations: [
    { id: "treatment", label: "Treatment-specific signal", description: "Treatment could lower marker X within comparable batches.", sources },
    { id: "batch", label: "Batch confounding", description: "Run-date differences could explain the apparent treatment signal.", sources },
  ],
  experiments: [{
    id: "adjust_batch", title: "Check within-batch contrasts using existing data", kind: "existing-data", priority: "first",
    rationale: "Can reveal non-identifiability before spending on a new cohort.", sources, dependsOn: [],
    method: "Check treatment-by-batch overlap, then compare within-batch estimates using a reviewed model.", measurement: "Within-batch treatment contrast and its uncertainty, if identifiable.", controls: ["Inspect negative controls and missing batch labels."],
    predictions: [{ explanationId: "treatment", expectedOutcome: "A compatible contrast would persist within comparable batches." }, { explanationId: "batch", expectedOutcome: "The contrast would weaken after accounting for batch, or prove non-identifiable." }],
    decisionBranches: [{ outcome: "Compatible within-batch contrast with adequate overlap", decisionChange: "Prioritize a separately approved independent validation." }, { outcome: "No overlap, or the contrast is explained by batch", decisionChange: "Do not interpret the association as a treatment mechanism." }],
    inconclusiveAction: "Document non-identifiability and refine the balanced-design proposal without claiming no treatment effect.",
    requiredInputs: ["Current data table and batch/treatment labels; availability must be checked."], resources: "Local analysis environment and a statistician's model review; no execution authorized.",
    time: { level: "low", rationale: "Only if existing labels and code are usable." }, cost: { level: "low", rationale: "Existing-data review may avoid collection costs; compute is not quoted." }, limitations: ["Adjustment cannot recover a treatment contrast without overlap."],
  }, {
    id: "balanced_followup", title: "Plan a batch-balanced independent validation", kind: "new-data", priority: "next",
    rationale: "Consider only after the existing-data check identifies the remaining uncertainty.", sources, dependsOn: ["adjust_batch"],
    method: "Design an independent blinded validation with treatment randomized within batch; freeze a protocol before collection.", measurement: "Predeclared marker-X contrast and interval in independent specimens.", controls: ["Randomization, blinding, negative controls and eligibility criteria require review."],
    predictions: [{ explanationId: "treatment", expectedOutcome: "A compatible effect would recur in independently balanced batches." }, { explanationId: "batch", expectedOutcome: "The earlier association would not recur systematically when batch is balanced." }],
    decisionBranches: [{ outcome: "A precise compatible contrast", decisionChange: "Consider mechanism-focused follow-up without treating one study as proof." }, { outcome: "A precise incompatible contrast", decisionChange: "Reconsider the mechanism and examine differences in applicability." }],
    inconclusiveAction: "Do not vote by significance; assess precision, QC and design limitations before revising the plan.",
    requiredInputs: ["New independently sampled specimens; ethics, procurement and consent are not authorized."], resources: "Laboratory access, reviewed sampling/power assumptions, staff and instrument time remain unconfirmed.",
    time: { level: "unknown", rationale: "Depends on recruitment, ethics review and instrument availability." }, cost: { level: "unknown", rationale: "Obtain actual procurement and compute quotes separately." }, limitations: ["A validation cohort may not represent the original target population."],
    whyNewData: "Existing data cannot remove a complete treatment/batch confound or provide independent validation.",
  }],
};
export const experimentView: NextExperimentView = {
  context: { projectId: "project-a", source: experimentSource, digest: "c".repeat(64), capturedAt: 2000, targetStatus: "active",
    sources: [{ hit: { ...memoryHit, source: sources[0], title: "Treatment lowers marker X", type: "hypothesis", recordStatus: "active", related: [], limitations: [], qualifiers: ["Authored hypothesis, not a verified conclusion."] }, text: "Initial signal may be confounded by batch.", textTruncated: false }],
    artifacts: [{ path: "data.csv", capturedAt: 2000, sha256: "f".repeat(64), size: 100 }], artifactsOmitted: 0, coverage: memorySearch.coverage, warnings: [], },
  proposals: [{ source: { sessionId: "chat-a", entryId: "proposal-a" }, digest: "b".repeat(64), timestamp: 2500, author: "agent", status: "active", plan: experimentPlan, contextStatus: "current", decisions: [],
    binding: { kind: "proposal-context", origin: "model-generated", capturedAt: 2000, contextDigest: "c".repeat(64), sourceDigests: [{ source: sources[0], digest: "a".repeat(64) }], generation: { requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", requestDigest: "d".repeat(64), model: "openrouter/test/model", costUsd: 0.003 } } }], warnings: [],
};
