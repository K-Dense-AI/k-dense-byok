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
    "Thread the narrative: when an observation tests an earlier hypothesis, log it with `relatesTo: <that entry's id>` and a `stance`; to correct an earlier entry, log a new one with `supersedes: <its id>`.",
  ],
  parameters: NotebookParams,
  execute: async (toolCallId, params) => {
    const title = (params.title ?? "").trim();
    if (!title) throw new Error("notebook entry needs a non-empty title");
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
}
