/**
 * One-shot AI draft of a manuscript Methods section from a session's lab
 * notebook. Deliberately NOT a chat session — one Pi ModelRuntime completion,
 * budget-gated and ledgered under the synthetic session id "methods-draft"
 * (mirrors latex/assist.ts). The draft is written into the sandbox so it opens
 * in the normal file preview and stays part of the project record.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getModelRegistry, getModelRuntime } from "./session-registry.ts";
import { ONE_SHOT_REASONING } from "./one-shot-reasoning.ts";
import {
  assertModelAuthentication,
  modelReference,
  resolveModel,
} from "./models.ts";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";
import { billingCountsTowardBudget, billingForModel } from "../cost/billing.ts";
import { getProject, resolvePaths, touchProject } from "../projects.ts";
import { readNotebookEntries, type NotebookEntry } from "./notebook-store.ts";
import { withNotebookArtifactHealth } from "./notebook-artifacts.ts";
import { deriveEvidenceThreads, evidenceLinks } from "../../../web/src/lib/notebook-evidence-core.ts";
import { withNotebookPlanHistory } from "./notebook-research.ts";
import { planHistoryText } from "../../../web/src/lib/notebook-plans.ts";
import { resultReferenceText } from "../../../web/src/lib/notebook-result-links.ts";

export const METHODS_DRAFT_SESSION_ID = "methods-draft";
const MAX_OUTPUT_TOKENS = 4_000;
const BODY_CHAR_CAP = 2_000;
const DIGEST_CHAR_BUDGET = 60_000;

export class MethodsDraftError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface MethodsDraftResult {
  /** Sandbox-relative path of the written draft (forward slashes). */
  path: string;
  markdown: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  billingMode?: string;
  listPriceUsd?: number;
}

const SYSTEM_PROMPT = [
  "You are a scientific writing assistant. Draft the Methods section of a",
  "research manuscript from the lab-notebook entries below. Write in past",
  "tense, first-person plural, in the register of a peer-reviewed paper.",
  "Describe only what the notebook supports — never invent parameters,",
  "versions, thresholds, or sample sizes that are not recorded. Organize by",
  "analysis stage, not by timestamp. Where the notebook names an artifact",
  "file, reference it by filename. Respond with Markdown only, starting with",
  'a "## Methods" heading. Do not add an introduction or results.',
  "Preserve recorded limitations and explicitly flag incomplete or changed artifact evidence.",
  "Cite source entry ids for factual method statements. Missing parameters must remain unrecorded, never guessed.",
  "Technical failures and null results are not automatically evidence against a hypothesis.",
  "Next-experiment predictions and planning preferences are not observations, performed procedures or execution approvals; never write them as completed Methods.",
  "Robustness approval records are authorization, not execution. Preserve all failed/cancelled/invalid attempts; sensitivity runs are not independent replications and script-provided QC is not independent verification.",
  "A frozen plan records intended methods, not execution. Keep recorded deviations explicit and never describe a local freeze as external preregistration or proof that data were unseen. Unapproved drafts are not methods performed.",
].join(" ");

function digestEntry(e: NotebookEntry, t0: number, byId: Map<string, NotebookEntry>): string {
  const parts: string[] = [];
  const elapsed = Math.max(0, Math.round((e.timestamp - t0) / 1000));
  const meta: string[] = [];
  if (e.confidence) meta.push(`confidence: ${e.confidence}`);
  if (e.relatesTo) {
    const rel =
      e.stance === "supports" ? "supports" : e.stance === "refutes" ? "refutes" : "relates to";
    meta.push(`${rel}: ${byId.get(e.relatesTo)?.title ?? e.relatesTo}`);
  }
  parts.push(
    `[+${elapsed}s] ${e.type.toUpperCase()}: ${e.title}${meta.length ? ` (${meta.join("; ")})` : ""}`,
  );
  if (e.body) {
    parts.push(e.body.length > BODY_CHAR_CAP ? e.body.slice(0, BODY_CHAR_CAP) + " […]" : e.body);
  }
  if (e.code) {
    const src =
      e.code.source.length > BODY_CHAR_CAP
        ? e.code.source.slice(0, BODY_CHAR_CAP) + "\n# […]"
        : e.code.source;
    parts.push("```" + (e.code.lang ?? "") + "\n" + src + "\n```");
  }
  if (e.artifacts?.length) {
    parts.push(`artifacts: ${e.artifacts.map((p) => p.split("/").pop() ?? p).join(", ")}`);
  }
  parts.push(`source entry: ${e.id}`);
  for (const link of evidenceLinks(e)) parts.push(`evidence ${link.relation}: ${link.sessionId ? link.sessionId + "/" : ""}${link.entryId}${link.rationale ? " — " + link.rationale : ""}`);
  if (e.scope) parts.push(`applicability (authored): ${e.scope}`);
  if (e.revisitWhen) parts.push(`revisit condition (not a completed action): ${e.revisitWhen}`);
  if (e.outcome) parts.push(`outcome: ${e.outcome}`);
  for (const ref of e.resultSnapshots ?? e.results ?? []) parts.push(`saved scientific-result reference: ${resultReferenceText(ref)}`);
  if (e.limitations?.length) parts.push(`limitations: ${e.limitations.join("; ")}`);
  for (const check of e.artifactHealth ?? []) parts.push(`artifact check ${check.path}: ${check.status} — ${check.reason ?? ""}`);
  if (e.artifactHealthTruncated) parts.push(`${e.artifactHealthTruncated} artifact checks omitted (limit)`);
  return parts.join("\n");
}

export function buildMethodsDraftContext(
  entries: NotebookEntry[],
  meta: { sessionId: string; projectName?: string },
): Context {
  const threads = deriveEvidenceThreads(entries);
  const relevant = entries.filter(
    (e) => !e.proposalOnly && !e.nextExperiments && !e.nextExperimentDecision && !threads.get(e.id)?.supersededBy && (e.type === "method" || e.type === "decision" || e.type === "observation"),
  );
  const byId = new Map(entries.map((e) => [e.id, e]));
  const t0 = entries[0]?.timestamp ?? 0;
  const header: string[] = [];
  if (meta.projectName) header.push(`Project: ${meta.projectName}`);
  header.push(`Session: ${meta.sessionId}`);
  if (entries.length > 0) {
    const start = new Date(entries[0].timestamp).toISOString();
    const end = new Date(entries[entries.length - 1].timestamp).toISOString();
    header.push(`Span: ${start} → ${end}`);
  }
  header.push(`Entries in digest: ${relevant.length}`);

  // Keep every method/decision; truncate observations first when over budget.
  const digests = relevant.map((e) => ({ e, text: digestEntry(e, t0, byId) }));
  let total = digests.reduce((n, d) => n + d.text.length, 0);
  let omitted = 0;
  if (total > DIGEST_CHAR_BUDGET) {
    for (let i = digests.length - 1; i >= 0 && total > DIGEST_CHAR_BUDGET; i--) {
      if (digests[i].e.type !== "observation") continue;
      total -= digests[i].text.length;
      digests.splice(i, 1);
      omitted++;
    }
  }
  const plans = entries.filter((e) => e.planHistory || e.planHistoryError).map((e) => `Plan record for source entry ${e.id}:\n${e.planHistory ? planHistoryText(e.planHistory) : `UNAVAILABLE: ${e.planHistoryError}`}`).join("\n\n");
  const fullBody = [digests.map((d) => d.text).join("\n\n"), plans].filter(Boolean).join("\n\n");
  // Plan histories and old method-only notebooks can exceed the budget too.
  const body = fullBody.slice(0, DIGEST_CHAR_BUDGET);
  const truncated = (omitted > 0 ? `\n\n[digest truncated: ${omitted} observation entries omitted]` : "")
    + (fullBody.length > body.length ? "\n\n[INCOMPLETE CONTEXT: further method/plan records omitted at the digest limit. Flag the draft as partial; do not infer absent details.]" : "");
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${header.join("\n")}\n\n${body}${truncated}`,
        timestamp: Date.now(),
      },
    ],
  };
}

/** Unwrap a whole-answer fence; leave inline fences inside prose untouched. */
function unwrapWholeFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

// `completeSimple`, not `complete`: see one-shot-reasoning.ts.
const completeWithRuntime: CompleteFn = (model, context, options) =>
  getModelRuntime().completeSimple(model, context, options);

export async function runMethodsDraft(
  sessionId: string,
  projectId: string,
  opts: { model?: string } = {},
  completeFn: CompleteFn = completeWithRuntime,
): Promise<MethodsDraftResult> {
  let entries: NotebookEntry[];
  try {
    entries = withNotebookPlanHistory(await withNotebookArtifactHealth(readNotebookEntries(sessionId, projectId), projectId), projectId, sessionId);
  } catch (err) {
    throw new MethodsDraftError(400, (err as Error).message);
  }
  if (entries.length === 0) {
    throw new MethodsDraftError(400, "Notebook has no entries to draft from");
  }
  const active = deriveEvidenceThreads(entries);
  const hasWorkRecord = entries.some((e) =>
    (!e.proposalOnly && !e.nextExperiments && !e.nextExperimentDecision && !active.get(e.id)?.supersededBy && ["method", "observation", "decision"].includes(e.type))
    || e.planHistory?.events.some((event) => event.kind === "deviation"));
  if (!hasWorkRecord) throw new MethodsDraftError(400, "No methods, observations, decisions or deviations are recorded. A plan alone is not evidence of execution.");
  if (opts.model?.startsWith("fusion/")) {
    throw new MethodsDraftError(422, "Fusion models are not supported for the Methods draft");
  }
  const paths = resolvePaths(projectId);
  const projectName = getProject(projectId)?.name;
  const model = resolveModel(opts.model, getModelRegistry());
  if (completeFn === completeWithRuntime) {
    try {
      await assertModelAuthentication(model, getModelRuntime());
    } catch (error) {
      throw new MethodsDraftError(
        401,
        error instanceof Error ? error.message : "Model provider is not connected",
      );
    }
  }
  const billing = await billingForModel(model, getModelRuntime());
  const budget = isBudgetExceeded(projectId);
  if (billingCountsTowardBudget(billing) && budget.exceeded) {
    throw new MethodsDraftError(
      402,
      `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
        `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
    );
  }
  let msg: AssistantMessage;
  try {
    msg = await completeFn(model, buildMethodsDraftContext(entries, { sessionId, projectName }), {
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoning: ONE_SHOT_REASONING,
    });
  } catch (err) {
    throw new MethodsDraftError(502, err instanceof Error ? err.message : "model call failed");
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new MethodsDraftError(502, msg.errorMessage ?? "model call failed");
  }
  // `complete()` is `stream().result()`, so a provider stream that ends without
  // ever setting a terminal reason resolves with the initial "pending" one and a
  // partial message. Writing that to disk would look like a finished draft.
  if (msg.stopReason === "pending") {
    throw new MethodsDraftError(502, "Model stream ended without a stop reason");
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const markdown = unwrapWholeFence(text);
  if (!markdown.trim()) {
    throw new MethodsDraftError(502, "Model did not produce a usable draft");
  }
  // Session-id charset ([A-Za-z0-9._-]) keeps the filename traversal-safe.
  const fileName = `methods_draft_${sessionId}.md`;
  fs.writeFileSync(path.join(paths.sandbox, fileName), markdown + "\n", "utf-8");
  touchProject(projectId);
  const u = msg.usage;
  const costEntry = recordRun({
    sessionId: METHODS_DRAFT_SESSION_ID,
    projectId,
    model: modelReference(model),
    role: "agent",
    before: emptySnapshot(),
    after: {
      costUsd: u.cost.total,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      total: u.totalTokens,
    },
    billing,
  });
  return {
    path: fileName,
    markdown,
    model: modelReference(model),
    costUsd: costEntry?.costUsd ?? 0,
    inputTokens: u.input,
    outputTokens: u.output,
    billingMode: billing.billingMode,
    ...(costEntry?.listPriceUsd !== undefined
      ? { listPriceUsd: costEntry.listPriceUsd }
      : {}),
  };
}
