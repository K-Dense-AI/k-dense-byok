/**
 * Native `notebook` tool: Kady logs its own research narrative as structured
 * lab-notebook entries (hypothesis / method / observation / decision / note).
 *
 * Unlike `interview`, it never waits for user input: it validates, measures
 * bounded citation identities asynchronously, server-stamps attribution and
 * appends to the durable store so the run keeps flowing. The entry rides the normal
 * `tool_start` SSE frame (tool name "notebook", args = the entry), which the
 * center-panel Lab Notebook view renders live.
 *
 * The lead uses this in-process tool; children use the mirrored vendored
 * kady-notebook package, whose entries are harvested on completion.
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolvePaths } from "../projects.ts";
import { stripSandboxRoot } from "./events.ts";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";
import { currentRunId } from "./run-ids.ts";
import { captureNotebookArtifacts } from "./notebook-artifacts.ts";
import { normalizeEvidenceLinks } from "../../../web/src/lib/notebook-evidence-core.ts";
import { NextExperimentsSchema } from "../../pi-packages/kady-notebook/next-experiments-schema.ts";
import { normalizeNextExperiments } from "../../../web/src/lib/next-experiments.ts";
import { bindAuthoredProposal } from "./next-experiment-context.ts";
import { RobustnessDraftSchema } from "../../pi-packages/kady-notebook/robustness-schema.ts";
import { normalizeRobustnessDraft } from "../../../web/src/lib/notebook-robustness.ts";
import { normalizeAnalysisPlan } from "../../../web/src/lib/notebook-plans.ts";
import { normalizeResultLinks } from "../../../web/src/lib/notebook-result-links.ts";
import { snapshotNotebookResults } from "./notebook-results.ts";
import { AnalysisPlanSchema, NotebookResultsSchema } from "../../pi-packages/kady-notebook/plan-schema.ts";

const CodeSchema = Type.Object({
  source: Type.String({ description: "The code/snippet text" }),
  lang: Type.Optional(Type.String({ description: "Language for highlighting" })),
});

export const NotebookParams = Type.Object({
  type: Type.Union(
    [
      Type.Literal("hypothesis"),
      Type.Literal("method"),
      Type.Literal("observation"),
      Type.Literal("decision"),
      Type.Literal("note"),
    ],
    {
      description:
        "hypothesis = an idea to test, method = what you did/ran, observation = a result, decision = a choice you made and why, note = anything else",
    },
  ),
  title: Type.String({ description: "One-line headline for this entry" }),
  body: Type.Optional(Type.String({ description: "Markdown detail (optional)" })),
  artifacts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative paths this entry produced or references (figures, tables, scripts). Attach whenever the entry corresponds to a file you wrote.",
    }),
  ),
  code: Type.Optional(CodeSchema),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Your confidence (mainly for hypothesis/decision)",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form labels" })),
  relatesTo: Type.Optional(
    Type.String({
      description:
        "Id of an earlier notebook entry this one responds to (every notebook call returns its entry id). Pair with `stance`.",
    }),
  ),
  stance: Type.Optional(
    Type.Union(
      [Type.Literal("supports"), Type.Literal("refutes"), Type.Literal("neutral")],
      { description: "How this entry bears on the `relatesTo` target" },
    ),
  ),
  evidence: Type.Optional(Type.Array(Type.Object({
    entryId: Type.String({ minLength: 1, maxLength: 500 }),
    sessionId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" })),
    relation: Type.Union([Type.Literal("supports"), Type.Literal("challenges"), Type.Literal("inconclusive"), Type.Literal("context")]),
    rationale: Type.Optional(Type.String({ maxLength: 2000 })),
  }), { maxItems: 32, description: "Earlier entries this result bears on. Multiple typed links are allowed. Omit sessionId for this chat. These are your interpretations, not verified verdicts." })),
  limitations: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 16 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Applicability: dataset/version, cohort, organism, assay or conditions. Do not generalize beyond what was tested." })),
  revisitWhen: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "What new data, controls or changed assumptions would justify revisiting this finding or rejected method? This is a condition, not an automatic action." })),
  outcome: Type.Optional(Type.Union([Type.Literal("signal"), Type.Literal("null"), Type.Literal("inconclusive"), Type.Literal("technical-failure")], { description: "Distinguish scientific outcomes from technical failures. A null or inconclusive result is not automatically evidence against a hypothesis." })),
  analysisPlan: Type.Optional(AnalysisPlanSchema),
  robustness: Type.Optional(RobustnessDraftSchema),
  nextExperiments: Type.Optional(NextExperimentsSchema),
  results: Type.Optional(NotebookResultsSchema),
  supersedes: Type.Optional(
    Type.String({
      description:
        "Id of an earlier entry this one amends or replaces — use instead of re-logging corrected content without linkage",
    }),
  ),
});

export type NotebookParamsT = Static<typeof NotebookParams>;

export function makeNotebookTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof NotebookParams> {
  return {
    name: "notebook",
    label: "Notebook",
    description: [
      "Log an entry to your living lab notebook — the scientist watching you works from it.",
      "Record your real reasoning as you go: a `hypothesis` when you form an idea to test, a `method` before/after you run an analysis, an `observation` when you get a result, and a `decision` when a result makes you change course.",
      "Attach `artifacts` (sandbox-relative paths) whenever an entry corresponds to a figure, table, or script you just wrote — they become clickable links in the notebook.",
      "Every call returns the new entry's id. When a later result bears on an earlier entry, link them: `relatesTo: <id>` with a `stance` (supports/refutes/neutral). To correct an earlier entry, log a new one with `supersedes: <id>` — history is append-only.",
      "No user response is required; the server captures bounded citation identities and the run continues. Log liberally at natural milestones rather than in one dump at the end.",
    ].join("\n"),
    promptSnippet:
      "notebook: log a structured hypothesis/method/observation/decision entry to the live lab notebook",
    promptGuidelines: [
      "Keep a running lab notebook: call `notebook` at natural milestones — when forming a hypothesis, before and after running an analysis, and whenever a result changes your plan.",
      "Prefer several small, timely entries over one big summary at the end; the user watches the notebook fill in as you work.",
      "Attach `artifacts` for any entry tied to a file you wrote (figure, table, script) so the notebook links to the real output.",
      "Use evidence: [{entryId, relation, rationale}] to connect observations to hypotheses or decisions. Relations are supports/challenges/inconclusive/context. Preserve disagreements and record limitations. A technical failure is not negative scientific evidence; a non-significant result does not automatically refute a hypothesis. Repeated analyses of the same dataset are not independent replications.",
      "Legacy relatesTo/stance links still work. When amending evidence, explicitly restate its links; supersedes retires the old entry but never inherits its relationships.",
      "Never rewrite history — to correct an earlier entry, log a new entry with `supersedes: <its id>`.",
      "Make decisions reusable: record scope (dataset/version/cohort/conditions) and revisitWhen for rejected approaches, null/inconclusive findings and failures. Never turn technical failure into evidence of no effect. Search prior project records with notebook_search before repeating analyses; cite original entry ids rather than re-logging retrieved text as a new finding.",
      "Propose an analysisPlan on a hypothesis entry before analysis. It is only a draft: the scientist must review and freeze it in the notebook. Never claim a tool-authored proposal is approved or preregistered. Report deviations from a frozen plan as observations; the user can record/correct them in its deviation ledger.",
      "To stress-test a finding, write a real Python analysis script accepting --spec/--output, then propose robustness on its hypothesis with defensible variations, explicit inputs, common metric/unit, seeds and pinned packages. This is only a proposal: do not launch the proposed jobs through modal tools or claim user approval. The scientist reviews the snapshot and estimated budget in Stress-test finding. Do not search specifications for significance; retain failures and null/inconclusive outcomes.",
      "To propose the next investigation, log a NOTE with nextExperiments targeting a saved hypothesis. Compare competing explanations, predict outcomes under every explanation, and say what each possible/inconclusive result would change. Ground sources with notebook_search; prefer existing-data checks and justify new collection. Priorities/time/cost are qualitative judgments, never computed probabilities or information gain. A proposal is not an observation, an approval or permission to execute; record actual results separately.",
      "Link structured outputs using results: [{toolCallId, sessionId?}], with ids returned by scientific_result. The notebook resolves the saved cards instead of asking you to duplicate measurements.",
    ],
    parameters: NotebookParams,
    execute: async (toolCallId, params, _signal) => {
      const title = (params.title ?? "").trim();
      if (!title) throw new Error("notebook entry needs a non-empty title");

      const sessionId = getSessionId();
      const runId = currentRunId(projectId, sessionId);
      const timestamp = Date.now();
      const sandboxRoot = resolvePaths(projectId).sandbox;
      if (params.analysisPlan && params.type !== "hypothesis") throw new Error("Analysis-plan drafts belong on hypothesis entries");
      const analysisPlan = params.analysisPlan ? normalizeAnalysisPlan(params.analysisPlan) : undefined;
      if (params.robustness && params.type !== "hypothesis") throw new Error("Robustness proposals belong on hypothesis entries");
      const robustness = params.robustness ? normalizeRobustnessDraft(params.robustness) : undefined;
      if (params.nextExperiments && params.type !== "note") throw new Error("Next-experiment proposals belong on note entries, not observations or performed methods");
      const nextExperiments = params.nextExperiments ? normalizeNextExperiments(params.nextExperiments) : undefined;
      const nextExperimentBinding = nextExperiments ? await bindAuthoredProposal(projectId, sessionId, nextExperiments) : undefined;
      const results = params.results ? normalizeResultLinks(params.results) : undefined;
      const resultSnapshots = results?.length ? await snapshotNotebookResults(projectId, sessionId, results) : undefined;
      const artifacts = params.artifacts?.map((a) => stripSandboxRoot(a, sandboxRoot));
      const artifactSnapshots = artifacts?.length ? await captureNotebookArtifacts(projectId, artifacts) : undefined;

      // NotebookParams permits extra properties for provider compatibility.
      // Only allowlisted narrative fields may enter the durable record.
      const entry: NotebookEntry = {
        // Copy allowed narrative fields only: additional tool properties must
        // never forge snapshots, read-time health, session ids or attribution.
        type: params.type, title, body: params.body, code: params.code,
        confidence: params.confidence, tags: params.tags,
        relatesTo: params.relatesTo, stance: params.stance, supersedes: params.supersedes,
        ...(params.evidence ? { evidence: normalizeEvidenceLinks(params.evidence) } : {}),
        limitations: params.limitations, outcome: params.outcome,
        scope: params.scope, revisitWhen: params.revisitWhen,
        ...(analysisPlan ? { analysisPlan } : {}),
        ...(robustness ? { robustness } : {}),
        ...(nextExperiments ? { nextExperiments, nextExperimentBinding, proposalOnly: true,
          stance: "neutral" as const,
          evidence: [...normalizeEvidenceLinks(params.evidence).map((e) => ({ ...e, relation: "context" as const })), { entryId: nextExperiments.target.entryId, sessionId: nextExperiments.target.sessionId ?? sessionId, relation: "context" as const }],
        } : {}),
        ...(results ? { results } : {}),
        ...(resultSnapshots ? { resultSnapshots } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
        ...(artifactSnapshots ? { artifactSnapshots } : {}),
        id: toolCallId, timestamp, role: "agent", runId,
      };
      try {
        appendNotebookEntry(sessionId, entry, projectId);
      } catch (exc) {
        // Never abort a run over a notebook write; report softly to the model.
        return {
          content: [
            {
              type: "text" as const,
              text: `notebook entry not saved (${(exc as Error).message}); continue your work.`,
            },
          ],
          details: { error: true },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `logged notebook entry (id: ${toolCallId}) — reference this id in relatesTo/supersedes to link later entries`,
          },
        ],
        details: { logged: true },
      };
    },
  };
}
