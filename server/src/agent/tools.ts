/**
 * Custom Pi tools for the single flat agent.
 *
 * `spawn_subagent` is the one concession to the old orchestrator/expert split:
 * the main agent can fan a self-contained subtask out to a fresh in-memory Pi
 * session (same cwd, model, and built-in tools) and get back its final text.
 * Subagents do NOT get the spawn tool themselves (no recursion).
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
  type AuthStorage,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isBudgetExceeded } from "../cost/ledger.ts";

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface SubagentStats {
  cost: number;
  tokens: { input: number; output: number; cacheRead: number; total: number };
}

export interface SubagentDeps {
  /** Project whose spend cap gates each delegation. */
  projectId: string;
  cwd: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** Resolved lazily so the subagent uses the parent session's CURRENT model. */
  getModel: () => Model<Api>;
  /** Called with the subagent's final usage so the caller can ledger it. */
  onStats?: (stats: SubagentStats, modelId: string) => void;
}

export function makeSpawnSubagentTool(deps: SubagentDeps): ToolDefinition {
  return defineTool({
    name: "spawn_subagent",
    label: "Spawn subagent",
    description:
      "Delegate a self-contained subtask to an independent agent with its own " +
      "context window and the same file/bash tools. Use for heavy or parallel " +
      "work (e.g. independent analyses) so the main thread stays focused. " +
      "Returns the subagent's final answer as text.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Full instructions for the subagent: the objective, relevant file " +
          "paths, constraints, and explicit success criteria.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      // The per-run budget check happens before the turn starts; re-check here
      // so one turn can't fan out unbounded subagent spend past the cap.
      const budget = isBudgetExceeded(deps.projectId);
      if (budget.exceeded) {
        return {
          content: [
            {
              type: "text",
              text:
                `Delegation blocked: the project has reached its spend limit ` +
                `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
                `Finish the task without subagents or ask the user to raise the limit.`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const model = deps.getModel();
      const { session } = await createAgentSession({
        cwd: deps.cwd,
        model,
        authStorage: deps.authStorage,
        modelRegistry: deps.modelRegistry,
        sessionManager: SessionManager.inMemory(deps.cwd),
        tools: BUILTIN_TOOLS,
      });
      try {
        await session.prompt(params.prompt);
        const text = session.getLastAssistantText() ?? "";
        const stats = session.getSessionStats();
        deps.onStats?.(
          {
            cost: stats.cost,
            tokens: {
              input: stats.tokens.input,
              output: stats.tokens.output,
              cacheRead: stats.tokens.cacheRead,
              total: stats.tokens.total,
            },
          },
          model.id,
        );
        return {
          content: [{ type: "text", text: text || "(subagent returned no text)" }],
          details: { cost: stats.cost, tokens: stats.tokens.total },
        };
      } finally {
        session.dispose();
      }
    },
  });
}
