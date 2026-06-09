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

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface SubagentDeps {
  cwd: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
  /** Called with the subagent's cumulative cost so the caller can ledger it. */
  onCost?: (usd: number) => void;
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
      const { session } = await createAgentSession({
        cwd: deps.cwd,
        model: deps.model,
        authStorage: deps.authStorage,
        modelRegistry: deps.modelRegistry,
        sessionManager: SessionManager.inMemory(deps.cwd),
        tools: BUILTIN_TOOLS,
      });
      try {
        await session.prompt(params.prompt);
        const text = session.getLastAssistantText() ?? "";
        const stats = session.getSessionStats();
        if (deps.onCost && stats.cost) deps.onCost(stats.cost);
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
