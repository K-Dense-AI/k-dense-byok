/**
 * Native `notebook` tool: Kady logs its own research narrative as structured
 * lab-notebook entries (hypothesis / method / observation / decision / note).
 *
 * Modeled on the `interview` tool, but NON-BLOCKING: it validates, server-
 * stamps (id = toolCallId, timestamp, role), appends to the durable store,
 * and returns immediately so the run keeps flowing. The entry rides the normal
 * `tool_start` SSE frame (tool name "notebook", args = the entry), which the
 * center-panel Lab Notebook view renders live.
 *
 * In-process custom tool → seen only by the lead agent, not by pi-subagents'
 * child `pi` processes (a Phase 5 follow-on promotes it to a Pi package).
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolvePaths } from "../projects.ts";
import { stripSandboxRoot } from "./events.ts";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";
import { currentRunId } from "./run-ids.ts";

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
      "This does NOT block; it returns immediately and your run continues. Log liberally at natural milestones rather than in one dump at the end.",
    ].join("\n"),
    promptSnippet:
      "notebook: log a structured hypothesis/method/observation/decision entry to the live lab notebook",
    promptGuidelines: [
      "Keep a running lab notebook: call `notebook` at natural milestones — when forming a hypothesis, before and after running an analysis, and whenever a result changes your plan.",
      "Prefer several small, timely entries over one big summary at the end; the user watches the notebook fill in as you work.",
      "Attach `artifacts` for any entry tied to a file you wrote (figure, table, script) so the notebook links to the real output.",
      "Thread the narrative: when an observation tests an earlier hypothesis, log it with `relatesTo: <that entry's id>` and a `stance` (supports/refutes/neutral); when a decision follows from evidence, relate it to the observation. Entry ids come back in each notebook tool result.",
      "Never rewrite history — to correct an earlier entry, log a new entry with `supersedes: <its id>`.",
    ],
    parameters: NotebookParams,
    execute: async (toolCallId, params, _signal) => {
      const title = (params.title ?? "").trim();
      if (!title) throw new Error("notebook entry needs a non-empty title");

      const sandboxRoot = resolvePaths(projectId).sandbox;
      const artifacts = params.artifacts?.map((a) => stripSandboxRoot(a, sandboxRoot));

      // Server-stamped fields go AFTER the spread: NotebookParams allows
      // additional properties, so a model-supplied `runId`/`id`/`role` in
      // params must not survive into the stored row.
      const entry: NotebookEntry = {
        ...params,
        title,
        ...(artifacts !== undefined ? { artifacts } : {}),
        id: toolCallId,
        timestamp: Date.now(),
        role: "agent",
        runId: currentRunId(getSessionId()),
      };
      try {
        appendNotebookEntry(getSessionId(), entry, projectId);
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
