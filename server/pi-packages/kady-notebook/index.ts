/**
 * kady-notebook — a Pi package that gives CHILD pi processes the `notebook`
 * tool, so subagents can log lab-notebook entries. The parent (in-process)
 * session already has its own notebook tool, so this package registers nothing
 * there: it self-gates on PI_SUBAGENT_CHILD (set only in child processes) to
 * avoid a duplicate `notebook` tool name in the parent.
 *
 * The child tool does NOT write files. A child's tool call is recorded in its
 * session JSONL; the parent harvests it on completion (see
 * server/src/agent/notebook-harvest.ts) and is the single writer.
 *
 * Schema mirrors the in-process tool (server/src/agent/notebook.ts). It is kept
 * self-contained here because a package is loaded standalone by the child pi
 * process; server/test/notebook-package.test.ts asserts field parity.
 */
import { Type } from "typebox";
import { AnalysisPlanSchema, NotebookResultsSchema } from "./plan-schema.ts";
import { NextExperimentsSchema } from "./next-experiments-schema.ts";
import { RobustnessDraftSchema } from "./robustness-schema.ts";
import { notebookSearchTool } from "./memory-tool.ts";
import { callMemoryApi } from "./memory-client.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

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
        "Sandbox-relative paths this entry produced or references (figures, tables, scripts).",
    }),
  ),
  code: Type.Optional(CodeSchema),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
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

export const notebookChildTool: ToolDefinition<typeof NotebookParams> = {
  name: "notebook",
  label: "Notebook",
  description: [
    "Log an entry to the shared living lab notebook as you work.",
    "Record your real reasoning: a `hypothesis` when you form an idea to test, a `method` before/after you run something, an `observation` for a result, a `decision` when a result changes your plan.",
    "Attach `artifacts` (sandbox-relative paths) whenever an entry corresponds to a figure, table, or script you wrote.",
    "Every call returns the new entry's id. When a later result bears on an earlier entry, link them: `relatesTo: <id>` with a `stance` (supports/refutes/neutral). To correct an earlier entry, log a new one with `supersedes: <id>` — history is append-only.",
    "This does NOT block; it returns immediately and your run continues. Log liberally at natural milestones.",
  ].join("\n"),
  promptSnippet:
    "notebook: log a hypothesis/method/observation/decision entry to the shared lab notebook",
  promptGuidelines: [
    "Keep a running lab notebook: call `notebook` at natural milestones as you work, not in one dump at the end.",
    "Attach `artifacts` for any entry tied to a file you wrote so the notebook links to real output.",
    "Use notebook_search to retrieve relevant prior work before repeating analyses. Record scope and revisitWhen for decisions, rejected methods and null/inconclusive outcomes. Cite original sources rather than copying old text into a new finding.",
    "Use evidence: [{entryId, relation, rationale}] to connect observations to hypotheses or decisions. Relations are supports/challenges/inconclusive/context. Preserve disagreements and record limitations. Technical failures are not negative scientific evidence; null results do not automatically refute hypotheses. Repeated analyses are not independent replications.",
    "Propose nextExperiments only on a NOTE targeting a saved hypothesis. Compare competing explanations and every test's predicted outcomes/decision consequences, including inconclusive outcomes. Use explicit source refs from notebook_search, prefer existing data, justify new collection, and use qualitative priorities/time/cost—not fabricated probabilities or information gain. Never execute a proposal or report its predictions as observed evidence.",
    "You may propose robustness on a hypothesis with a real --spec/--output Python script, defensible variations and seeds. Never launch proposed jobs or claim approval; the scientist must review the exact snapshot and compute budget in Stress-test finding. Do not search for significance or hide failed specifications.",
    "You may propose analysisPlan on a hypothesis; it is only a draft until the user reviews and freezes it in the UI. Never claim approval or external preregistration. Results can reference saved scientific_result calls in explicit parent/project sessionIds; local child result references remain unverified after harvest.",
    "Legacy relatesTo/stance links still work. To correct an entry use supersedes and explicitly restate its evidence links: amendments do not inherit relationships. Local entry ids refer to this child's notebook; only use sessionId for an explicit parent/project reference.",
  ],
  parameters: NotebookParams,
  execute: async (toolCallId, params) => {
    const title = (params.title ?? "").trim();
    if (!title) throw new Error("notebook entry needs a non-empty title");
    if (params.nextExperiments && params.type !== "note") throw new Error("Next-experiment proposals belong on note entries");
    if (params.robustness && params.type !== "hypothesis") throw new Error("Robustness proposals belong on hypothesis entries");
    if (params.analysisPlan && params.type !== "hypothesis") throw new Error("Analysis-plan drafts belong on hypothesis entries");
    return {
      content: [
        {
          type: "text" as const,
          text: `logged notebook entry (id: ${toolCallId}) — reference this id in relatesTo/supersedes to link later entries`,
        },
      ],
      details: {},
    };
  },
};

export default function (pi: ExtensionAPI): void {
  // Parent (in-process) session loads this package too, but already has its own
  // in-process notebook tool — register only in child processes to avoid a
  // duplicate tool name.
  if (!process.env.PI_SUBAGENT_CHILD) return;
  pi.registerTool(notebookChildTool);
  pi.registerTool(notebookSearchTool(callMemoryApi));
}
