/**
 * One-shot AI assistance for the LaTeX editor: fix a compile error or apply
 * an instruction to a selection. Deliberately NOT a chat session — a single
 * Pi ModelRuntime completion, budget-gated and ledgered under the synthetic
 * session id "latex-assist" so project cost summaries include it.
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { getModelRegistry, getModelRuntime } from "../agent/session-registry.ts";
import {
  assertModelAuthentication,
  modelReference,
  resolveModel,
} from "../agent/models.ts";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";
import { billingCountsTowardBudget, billingForModel } from "../cost/billing.ts";

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
  billingMode?: string;
  listPriceUsd?: number;
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

type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: StreamOptions,
) => Promise<AssistantMessage>;

const completeWithRuntime: CompleteFn = (model, context, options) =>
  getModelRuntime().complete(model, context, options);

export async function runLatexAssist(
  req: AssistRequest,
  projectId: string,
  completeFn: CompleteFn = completeWithRuntime,
): Promise<AssistResult> {
  validate(req);
  if (req.model?.startsWith("fusion/")) {
    throw new AssistError(422, "Fusion models are not supported for editor AI assist");
  }
  const model = resolveModel(req.model, getModelRegistry());
  if (completeFn === completeWithRuntime) {
    try {
      await assertModelAuthentication(model, getModelRuntime());
    } catch (error) {
      throw new AssistError(
        401,
        error instanceof Error ? error.message : "Model provider is not connected",
      );
    }
  }
  const billing = await billingForModel(model, getModelRuntime());
  const budget = isBudgetExceeded(projectId);
  if (billingCountsTowardBudget(billing) && budget.exceeded) {
    throw new AssistError(
      402,
      `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
        `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
    );
  }
  let msg: AssistantMessage;
  try {
    msg = await completeFn(model, buildAssistContext(req), {
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    throw new AssistError(502, err instanceof Error ? err.message : "model call failed");
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new AssistError(502, msg.errorMessage ?? "model call failed");
  }
  // `complete()` is `stream().result()`, so a provider stream that ends without
  // ever setting a terminal reason resolves with the initial "pending" one and a
  // partial message. Accepting it would splice a truncated replacement into the
  // user's LaTeX, so treat a missing stop reason as the failure it is.
  if (msg.stopReason === "pending") {
    throw new AssistError(502, "Model stream ended without a stop reason");
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
  const entry = recordRun({
    sessionId: ASSIST_SESSION_ID,
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
    replacement,
    model: modelReference(model),
    costUsd: entry?.costUsd ?? 0,
    inputTokens: u.input,
    outputTokens: u.output,
    billingMode: billing.billingMode,
    ...(entry?.listPriceUsd !== undefined
      ? { listPriceUsd: entry.listPriceUsd }
      : {}),
  };
}
