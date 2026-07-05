/**
 * One-shot AI assistance for the LaTeX editor: fix a compile error or apply
 * an instruction to a selection. Deliberately NOT a chat session — a single
 * pi-ai complete() call, budget-gated and ledgered under the synthetic
 * session id "latex-assist" so project cost summaries include it.
 */
import { complete, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModelRegistry } from "../agent/session-registry.ts";
import { resolveModel } from "../agent/models.ts";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";

export const ASSIST_SESSION_ID = "latex-assist";
const MAX_OUTPUT_TOKENS = 4_000;

export interface AssistRequest {
  mode: "fix" | "edit";
  fileName: string;
  preamble?: string;
  error?: { line: number; message: string };
  context?: { startLine: number; endLine: number; text: string };
  instruction?: string;
  selection?: string;
  model?: string;
}

export interface AssistResult {
  replacement: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class AssistError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SYSTEM_PROMPT = [
  "You are a LaTeX editing assistant embedded in an editor.",
  "You are given a snippet from a .tex file and must return a corrected or",
  "rewritten version of EXACTLY that snippet — nothing more.",
  "Respond with the replacement inside a single fenced code block",
  "(```latex ... ```). No explanations, no line numbers, no surrounding",
  "document scaffolding unless the snippet itself contained it.",
].join(" ");

export function buildAssistContext(req: AssistRequest): Context {
  const parts: string[] = [`File: ${req.fileName}`];
  if (req.preamble?.trim()) {
    parts.push(`Document preamble (for package context):\n${req.preamble.trim()}`);
  }
  if (req.mode === "fix") {
    const { error, context } = req;
    parts.push(
      `The snippet below spans lines ${context!.startLine}-${context!.endLine}.`,
      `Compilation failed at line ${error!.line} with:\n${error!.message}`,
      `Snippet:\n${context!.text}`,
      "Return the full corrected snippet (same span).",
    );
  } else {
    parts.push(
      `Instruction: ${req.instruction}`,
      `Selected text:\n${req.selection}`,
      "Return the rewritten selection only.",
    );
  }
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n\n"), timestamp: Date.now() }],
  };
}

export function extractReplacement(text: string): string | null {
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  if (fenced) {
    // Keep the block's internal indentation; drop only trailing newlines.
    const body = fenced[1].replace(/\n+$/, "");
    return body.trim() ? body : null;
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

function validate(req: AssistRequest): void {
  if (req.mode === "fix") {
    if (!req.error || !req.context?.text) {
      throw new AssistError(422, "fix mode requires error and context");
    }
  } else if (req.mode === "edit") {
    if (!req.instruction?.trim() || req.selection === undefined) {
      throw new AssistError(422, "edit mode requires instruction and selection");
    }
  } else {
    throw new AssistError(422, "mode must be fix or edit");
  }
}

type CompleteFn = typeof complete;

export async function runLatexAssist(
  req: AssistRequest,
  projectId: string,
  completeFn: CompleteFn = complete,
): Promise<AssistResult> {
  validate(req);
  const budget = isBudgetExceeded(projectId);
  if (budget.exceeded) {
    throw new AssistError(
      402,
      `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
        `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
    );
  }
  if (req.model?.startsWith("fusion/")) {
    throw new AssistError(422, "Fusion models are not supported for editor AI assist");
  }
  const model = resolveModel(req.model, getModelRegistry());
  let msg: AssistantMessage;
  try {
    msg = await completeFn(model, buildAssistContext(req), {
      apiKey: process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    throw new AssistError(502, err instanceof Error ? err.message : "model call failed");
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new AssistError(502, msg.errorMessage ?? "model call failed");
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const replacement = extractReplacement(text);
  if (replacement === null) {
    throw new AssistError(502, "Model did not produce a usable replacement");
  }
  const u = msg.usage;
  recordRun({
    sessionId: ASSIST_SESSION_ID,
    projectId,
    model: msg.model,
    role: "agent",
    before: emptySnapshot(),
    after: {
      costUsd: u.cost.total,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      total: u.totalTokens,
    },
  });
  return {
    replacement,
    model: msg.model,
    costUsd: u.cost.total,
    inputTokens: u.input,
    outputTokens: u.output,
  };
}
