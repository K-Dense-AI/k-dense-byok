import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, resolvePaths } from "../src/projects.ts";
import { appendNotebookEntry, readNotebookEntries } from "../src/agent/notebook-store.ts";
import { buildNextExperimentContext } from "../src/agent/next-experiment-context.ts";
import { generateNextExperiments, nextExperimentView, chooseNextExperiment, proposalGenerationContext, NEXT_EXPERIMENTS_SESSION_ID } from "../src/agent/next-experiments.ts";
import { generationDirectory, inspectGeneration } from "../src/agent/next-experiment-receipts.ts";
import { notebookEntriesFromSessionFile } from "../src/agent/notebook-harvest.ts";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { packageRecordGraph } from "../src/evidence/source-graph.ts";
import { methodsScaffold } from "../src/evidence/report.ts";
import { previewAnalysisPlan, freezeAnalysisPlan, recordPlanDeviation } from "../src/agent/notebook-plans.ts";
import { notebookToMarkdown } from "../src/agent/notebook-export.ts";
import { buildMethodsDraftContext, runMethodsDraft } from "../src/agent/methods-draft.ts";
import { searchNotebookMemory } from "../src/agent/notebook-memory.ts";
import { deriveEvidenceThreads, notebookEntryKey } from "../../web/src/lib/notebook-evidence-core.ts";
import { sessionCostSummary, emptySnapshot, recordRun } from "../src/cost/ledger.ts";
import { experimentPlan, experimentSource as source } from "../../web/src/test/next-experiments-fixture.ts";
import { ONE_SHOT_REASONING } from "../src/agent/one-shot-reasoning.ts";
const project = "project-a";
const model = "openrouter/openai/gpt-4o";
function message(text: string, override: Partial<AssistantMessage> = {}): AssistantMessage { return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } }, stopReason: "stop", timestamp: 0, ...override } as AssistantMessage; }
function setup(id = project, limit?: number) {
  createProject({ name: id, projectId: id, spendLimitUsd: limit });
  appendNotebookEntry(source.sessionId, { id: source.entryId, type: "hypothesis", title: "Treatment lowers marker X", body: "Potential batch confounding remains unresolved.", artifacts: ["data.csv"], role: "agent", timestamp: 1 }, id);
  const file = path.join(resolvePaths(id).sandbox, "data.csv"); fs.writeFileSync(file, "sample,batch,treatment\na,1,yes\nb,1,no\n"); return file;
}
async function input(id = project) { return { requestId: crypto.randomUUID(), model, constraints: "Prefer existing data", approveModelCall: true, expectedContextDigest: (await buildNextExperimentContext(id, source)).context.digest }; }
const good = () => Promise.resolve(message(JSON.stringify(experimentPlan)));
beforeEach(() => { vi.restoreAllMocks(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); });
describe("source-linked next investigations", () => {
  it("builds bounded context from scientific records, linking contradictions without running work", async () => {
    setup(); appendNotebookEntry("other-chat", { id: "obs", type: "observation", title: "Batch conflicts with treatment interpretation", role: "agent", timestamp: 2, outcome: "inconclusive", evidence: [{ ...source, relation: "challenges" }] }, project);
    const { context } = await buildNextExperimentContext(project, source);
    expect(context.sources.map((s) => s.hit.source.sessionId)).toContain("other-chat");
    expect(context.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(context.sources.find((s) => s.hit.source.entryId === "obs")?.hit.outcome).toBe("inconclusive");
    expect(fs.existsSync(path.join(resolvePaths(project).sandbox, ".kady/modal"))).toBe(false);
    expect(sessionCostSummary(NEXT_EXPERIMENTS_SESSION_ID, project).totalUsd).toBe(0);
  });
  it("binds context to the project even when original records and bytes are identical", async () => {
    setup(); setup("project-b");
    const a = await buildNextExperimentContext(project, source), b = await buildNextExperimentContext("project-b", source);
    expect(a.context.digest).not.toBe(b.context.digest);
    await expect(generateNextExperiments("project-b", source, await input(), good)).rejects.toMatchObject({ status: 409 });
  });
  it("requires explicit approval, fresh context and a supported model before any call", async () => {
    const file = setup(); const body = await input(); const complete = vi.fn(good);
    await expect(generateNextExperiments(project, source, { ...body, approveModelCall: false }, complete)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(generateNextExperiments(project, source, { ...body, model: "fusion/test" }, complete)).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
    fs.writeFileSync(file, "changed");
    await expect(generateNextExperiments(project, source, body, complete)).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    expect(complete).not.toHaveBeenCalled();
  });
  it("ledgered generation saves a note, excludes itself from source context, and safely repeats the same response", async () => {
    setup(); const body = await input(); const complete = vi.fn(good);
    const result = await generateNextExperiments(project, source, body, complete);
    expect(complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ reasoning: ONE_SHOT_REASONING }));
    expect(result.binding).toMatchObject({ origin: "model-generated", contextDigest: body.expectedContextDigest, contextChangedDuringGeneration: false, generation: { costUsd: 0.003 } });
    const rows = readNotebookEntries(source.sessionId, project); expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: "note", proposalOnly: true, evidence: [{ entryId: source.entryId, relation: "context" }] });
    expect(deriveEvidenceThreads(rows).get(source.entryId)?.status).toBe("open");
    const view = await nextExperimentView(project, source); expect(view.proposals[0].contextStatus).toBe("current"); expect(view.context.digest).toBe(body.expectedContextDigest);
    expect(view.context.sources.some((s) => s.hit.source.entryId === result.source.entryId)).toBe(false);
    expect((await generateNextExperiments(project, source, body, complete)).reused).toBe(true); expect(complete).toHaveBeenCalledTimes(1);
    expect(sessionCostSummary(NEXT_EXPERIMENTS_SESSION_ID, project).totalUsd).toBeCloseTo(0.003);
    expect(inspectGeneration(project, source, body.requestId).state).toBe("succeeded");
  });
  it("preserves invalid/failed call accounting and refuses to spend again with that request id", async () => {
    setup(); const body = await input(); const complete = vi.fn(async () => message("not JSON"));
    await expect(generateNextExperiments(project, source, body, complete)).rejects.toMatchObject({ code: "INVALID_PROPOSAL", costUsd: 0.003 });
    await expect(generateNextExperiments(project, source, body, complete)).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
    expect(complete).toHaveBeenCalledTimes(1); expect(readNotebookEntries(source.sessionId, project)).toHaveLength(1);
    expect(sessionCostSummary(NEXT_EXPERIMENTS_SESSION_ID, project).totalUsd).toBeCloseTo(0.003);
    expect(inspectGeneration(project, source, body.requestId).state).toBe("failed");
  });
  it("fails before dispatch when the request intent cannot be durably published", async () => {
    setup(); const body = await input(); const complete = vi.fn(good); const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => { if (String(to).endsWith("intent.json")) throw new Error("Simulated storage failure"); return link(from, to); });
    await expect(generateNextExperiments(project, source, body, complete)).rejects.toMatchObject({ status: 503, code: "REQUEST_NOT_DISPATCHED" });
    expect(complete).not.toHaveBeenCalled(); expect(sessionCostSummary(NEXT_EXPERIMENTS_SESSION_ID, project).totalUsd).toBe(0);
  });
  it("does not turn invented citations or truncated responses into saved proposals", async () => {
    setup(); const plan = structuredClone(experimentPlan); plan.experiments[0].sources[0].entryId = "invented";
    await expect(generateNextExperiments(project, source, await input(), async () => message(JSON.stringify(plan)))).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
    await expect(generateNextExperiments(project, source, await input(), async () => message(JSON.stringify(experimentPlan), { stopReason: "length" }))).rejects.toMatchObject({ code: "MODEL_INCOMPLETE" });
    expect(readNotebookEntries(source.sessionId, project)).toHaveLength(1);
    expect(sessionCostSummary(NEXT_EXPERIMENTS_SESSION_ID, project).totalUsd).toBeCloseTo(0.006);
  });
  it("keeps the reviewed old context and warns when evidence changes during a call", async () => {
    const file = setup(); const body = await input();
    const result = await generateNextExperiments(project, source, body, async () => { fs.writeFileSync(file, "new observations"); return good(); });
    expect(result.binding?.contextChangedDuringGeneration).toBe(true);
    expect((await nextExperimentView(project, source)).proposals[0].contextStatus).toBe("changed");
  });
  it("does not repeat uncertain launches or reuse a request id for different constraints", async () => {
    setup(); const body = await input(); const complete = vi.fn(good); await generateNextExperiments(project, source, body, complete);
    await expect(generateNextExperiments(project, source, { ...body, constraints: "Different" }, complete)).rejects.toMatchObject({ code: "REQUEST_REUSED" });
    fs.unlinkSync(path.join(generationDirectory(project, source, body.requestId), "outcome.json"));
    await expect(generateNextExperiments(project, source, body, complete)).rejects.toMatchObject({ code: "GENERATION_UNCONFIRMED" });
    expect(inspectGeneration(project, source, body.requestId).state).toBe("unconfirmed"); expect(complete).toHaveBeenCalledTimes(1);
  });
  it("restores a saved receipt after a lost notebook append without another model call", async () => {
    setup(); const body = await input(); const complete = vi.fn(good); await generateNextExperiments(project, source, body, complete);
    const file = path.join(resolvePaths(project).sandbox, ".kady/notebook", `${source.sessionId}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n")[0] + "\n");
    expect((await generateNextExperiments(project, source, body, complete)).reused).toBe(true);
    expect(readNotebookEntries(source.sessionId, project)).toHaveLength(2); expect(complete).toHaveBeenCalledTimes(1);
  });
  it("allows only one in-flight call per hypothesis and rejects a spent budget", async () => {
    setup(project, 0.01); let release!: (m: AssistantMessage) => void;
    const complete = vi.fn(() => new Promise<AssistantMessage>((r) => { release = r; })); const body = await input();
    const pending = generateNextExperiments(project, source, body, complete);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await expect(generateNextExperiments(project, source, { ...body, requestId: crypto.randomUUID() }, good)).rejects.toMatchObject({ code: "GENERATION_ACTIVE" });
    release(message(JSON.stringify(experimentPlan))); await pending;
    recordRun({ projectId: project, sessionId: "spent", role: "agent", model, before: emptySnapshot(), after: { ...emptySnapshot(), costUsd: 1 } });
    await expect(generateNextExperiments(project, source, await input(), good)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
  it("records explicit append-only preferences against exact proposal and context identities without execution", async () => {
    setup(); await generateNextExperiments(project, source, await input(), good); const view = await nextExperimentView(project, source); const p = view.proposals[0];
    const body = { requestId: crypto.randomUUID(), proposal: p.source, candidateId: "adjust_batch", disposition: "prioritize", reason: "Clarify identifiability before new recruitment", expectedProposalDigest: p.digest, expectedContextDigest: view.context.digest };
    const saved = await chooseNextExperiment(project, source, body); expect(saved.entry).toMatchObject({ role: "you", type: "decision", proposalOnly: true, nextExperimentDecision: { disposition: "prioritize" } });
    expect((await chooseNextExperiment(project, source, body)).reused).toBe(true);
    await expect(chooseNextExperiment(project, source, { ...body, reason: "Different" })).rejects.toMatchObject({ statusCode: 409 });
    const after = await nextExperimentView(project, source); expect(after.context.digest).toBe(view.context.digest); expect(after.proposals[0].decisions).toHaveLength(1);
    expect(deriveEvidenceThreads(readNotebookEntries(source.sessionId, project)).get(source.entryId)?.status).toBe("open");
    expect(fs.existsSync(path.join(resolvePaths(project).sandbox, ".kady/modal"))).toBe(false);
    await expect(runMethodsDraft(source.sessionId, project, {}, good)).rejects.toThrow(/plan alone is not evidence/);
  });
  it("requires a new context review for choices, and acknowledges historical proposal assumptions", async () => {
    const file = setup(); await generateNextExperiments(project, source, await input(), good); const before = await nextExperimentView(project, source); const p = before.proposals[0]; fs.writeFileSync(file, "replacement");
    const body = { requestId: crypto.randomUUID(), proposal: p.source, candidateId: "adjust_batch", disposition: "defer", reason: "Source changed", expectedProposalDigest: p.digest, expectedContextDigest: before.context.digest };
    await expect(chooseNextExperiment(project, source, body)).rejects.toMatchObject({ statusCode: 409 });
    const current = await nextExperimentView(project, source); body.expectedContextDigest = current.context.digest;
    await expect(chooseNextExperiment(project, source, body)).rejects.toMatchObject({ statusCode: 400 });
    expect((await chooseNextExperiment(project, source, { ...body, acknowledgeUnverifiedContext: true })).entry.nextExperimentDecision?.proposalContextStatus).toBe("changed");
  });
  it("keeps superseded-target history readable but will not generate or choose against it", async () => {
    setup(); await generateNextExperiments(project, source, await input(), good); const body = await input();
    appendNotebookEntry(source.sessionId, { id: "amended", type: "hypothesis", title: "Revised hypothesis", supersedes: source.entryId, role: "agent", timestamp: Date.now() }, project);
    expect((await nextExperimentView(project, source)).context.targetStatus).toBe("superseded");
    await expect(generateNextExperiments(project, source, body, good)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("allows native authored proposals but never accepts authored verification/approval metadata", async () => {
    setup(); const tool = makeNotebookTool(project, () => source.sessionId);
    await expect(tool.execute("p-invalid", { type: "observation", title: "Predictions", nextExperiments: experimentPlan } as never, undefined as never)).rejects.toThrow(/note/);
    await tool.execute("p", { type: "note", title: "Next investigation", nextExperiments: experimentPlan, nextExperimentBinding: { origin: "model-generated", contextDigest: "fake" }, nextExperimentDecision: { disposition: "prioritize" }, evidence: [{ entryId: source.entryId, relation: "supports" }] } as never, undefined as never);
    const entry = readNotebookEntries(source.sessionId, project).at(-1)!;
    expect(entry.nextExperimentBinding?.origin).toBe("agent-authored"); expect(entry.nextExperimentDecision).toBeUndefined(); expect(entry.proposalOnly).toBe(true);
    expect(deriveEvidenceThreads(readNotebookEntries(source.sessionId, project)).get(source.entryId)?.status).toBe("open");
    expect((await nextExperimentView(project, source)).proposals[0].contextStatus).toBe("unverified");
    const memory = await searchNotebookMemory(project, { query: "within-batch contrasts" }); expect(memory.hits.some((h) => h.source.entryId === "p" && h.qualifiers.some((q) => q.includes("not an observation")))).toBe(true);
    const markdown = notebookToMarkdown([entry], { sessionId: source.sessionId }); expect(markdown).toContain("PREDICTED under treatment"); expect(markdown).toContain("THEN reconsider decision");
    expect(String(buildMethodsDraftContext([entry], { sessionId: source.sessionId }).messages[0].content)).not.toContain("Next investigation");
  });
  it("namespaces child-local proposal refs and ignores forged metadata; invalid proposals never become evidence", () => {
    setup(); const file = path.join(resolvePaths(project).sandbox, "child.jsonl"); const plan = structuredClone(experimentPlan); delete plan.target.sessionId; for (const e of [...plan.explanations, ...plan.experiments]) for (const r of e.sources) delete r.sessionId;
    fs.writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", name: "notebook", id: "p", arguments: { type: "note", title: "Child ideas", nextExperiments: plan, nextExperimentBinding: { contextDigest: "fake" }, evidence: [{ entryId: source.entryId, relation: "supports" }] } }] } }) + "\n");
    const rows = notebookEntriesFromSessionFile(file, "reviewer"); expect(rows[0].nextExperiments?.target.entryId).toBe(`reviewer:${source.entryId}`); expect(rows[0].nextExperiments?.experiments[0].sources[0].entryId).toBe(`reviewer:${source.entryId}`); expect(rows[0].nextExperimentBinding).toMatchObject({ origin: "harvested", sourceDigests: [] });
    plan.experiments[0].predictions = [];
    fs.writeFileSync(file, JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", name: "notebook", id: "bad", arguments: { type: "note", title: "Invalid prediction", nextExperiments: plan, evidence: [{ entryId: source.entryId, relation: "supports" }] } }] } }));
    const invalid = notebookEntriesFromSessionFile(file, "reviewer")[0]; expect(invalid.proposalOnly).toBe(true); expect(invalid.nextExperiments).toBeUndefined();
    const h = { id: `reviewer:${source.entryId}`, title: "Hypothesis", type: "hypothesis" as const, timestamp: 0 };
    expect(deriveEvidenceThreads([h, invalid]).get(notebookEntryKey(h))?.status).toBe("open");
  });
  it("keeps the current frozen plan alongside recent deviations in bounded proposal context", async () => {
    setup(); const plan = { hypothesis: "Treatment effect", primaryOutcome: "Marker X contrast", exclusions: "QC only", model: "Batch-adjusted model", multiplicity: "One primary test", qc: "Review labels", stopping: "Fixed existing cohort", exposureNotes: "Exploratory analysis", datasets: ["data.csv"], intent: "exploratory", priorExposure: "outcomes-inspected" };
    const preview = await previewAnalysisPlan(project, source, { plan, expectedHead: null }); const frozen = await freezeAnalysisPlan(project, source, { previewId: preview.id, acknowledgeLocalFreeze: true });
    let head = frozen.head;
    for (let i = 0; i < 6; i++) { const history = recordPlanDeviation(project, source, { expectedHead: head, planId: frozen.events[0].id, field: "model", actual: `Model revision ${i}`, reason: "Sensitivity review", timing: "after-results" }); head = history.head; }
    const { context } = await buildNextExperimentContext(project, source);
    expect(context.sources.some((s) => s.hit.type === "plan" && s.hit.recordStatus === "active")).toBe(true);
    expect(context.sources.filter((s) => s.hit.source.kind === "plan-event").length).toBeLessThanOrEqual(4);
  });
  it("never labels a matching but missing-file planning context verified/current", async () => {
    const file = setup(); fs.unlinkSync(file); const result = await generateNextExperiments(project, source, await input(), good);
    expect(result.binding?.artifacts?.[0].reason).toBe("missing"); expect((await nextExperimentView(project, source)).proposals[0].contextStatus).toBe("unverified");
  });
  it("bundles planning sources as context, retaining user-note gaps and excluding preferences from performed Methods", async () => {
    setup(); appendNotebookEntry("earlier", { id: "failed-method", type: "method", title: "Previously ran overlap diagnostics", body: "Inspected label overlap", role: "agent", timestamp: 2 }, project);
    const plan = structuredClone(experimentPlan); plan.experiments[0].sources.push({ kind: "notebook", sessionId: "earlier", entryId: "failed-method" }, { kind: "user-note", sessionId: "earlier", entryId: "user-note-1" });
    appendNotebookEntry(source.sessionId, { id: "p", type: "note", title: "Ideas", role: "agent", timestamp: 3, nextExperiments: plan, evidence: [{ entryId: source.entryId, relation: "context" }] }, project);
    appendNotebookEntry(source.sessionId, { id: "preference", type: "decision", title: "PREFERRED FUTURE METHOD", body: "Might run a future experiment", proposalOnly: true, role: "you", timestamp: 4, evidence: [{ entryId: "p", relation: "context" }] }, project);
    const issues: import("../../web/src/lib/evidence-packages.ts").EvidenceIssue[] = []; const graph = await packageRecordGraph(project, [source], issues);
    expect(graph.records.some((r) => r.ref.source.entryId === "failed-method")).toBe(true); expect(graph.relationships.some((r) => r.relation === "planning source (not evidence)")).toBe(true);
    expect(issues.some((i) => i.code === "planning-user-note-reference")).toBe(true);
    const scaffold = methodsScaffold(graph.records, [], false); expect(scaffold).toContain("Previously ran overlap diagnostics"); expect(scaffold).not.toContain("PREFERRED FUTURE METHOD");
    expect(graph.records.find((r) => r.ref.source.entryId === "p")?.document.original?.entry.nextExperiments).toEqual(plan);
  });
  it("tolerates malformed optional saved metadata and bounds source text sent to the model", async () => {
    setup(); appendNotebookEntry(source.sessionId, { id: "p", type: "note", title: "Ideas", role: "agent", timestamp: 2, nextExperiments: experimentPlan, nextExperimentBinding: { sourceDigests: {} } as never }, project);
    appendNotebookEntry(source.sessionId, { id: "bad-choice", type: "decision", title: "Malformed", role: "you", timestamp: 3, nextExperimentDecision: {} as never }, project);
    const view = await nextExperimentView(project, source); expect(view.proposals[0]).toMatchObject({ contextStatus: "unverified", decisions: [] });
    const huge = structuredClone(view.context); huge.sources = Array.from({ length: 24 }, () => ({ ...huge.sources[0], text: "x".repeat(1800), hit: { ...huge.sources[0].hit, limitations: Array.from({ length: 16 }, () => "z".repeat(2000)) } }));
    const ctx = proposalGenerationContext(huge, ""); const payload = JSON.parse(String(ctx.messages[0].content));
    expect(Buffer.byteLength(JSON.stringify(payload.sources))).toBeLessThanOrEqual(30000); expect(payload.sourcesOmitted).toBeGreaterThan(0); expect(ctx.tools).toBeUndefined();
    expect(ctx.systemPrompt).toContain("untrusted historical data"); expect(ctx.systemPrompt).toContain("never observations");
  });
});
