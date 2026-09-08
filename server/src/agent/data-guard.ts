/**
 * Raw-data guard for the lead session: a Pi `tool_call` hook that
 *
 *   - blocks `write`/`edit`/`bash` mutations of protected paths (default
 *     `user_data/**`) with a reason the model can act on, and
 *   - asks the user (permission card in the chat) before destructive shell
 *     commands elsewhere, when the project policy says so.
 *
 * Background specialists get the same protected-path block from the vendored
 * `kady-guard` package (no UI there, so destructive commands are blocked).
 * Policy is read fresh on every call so project-settings edits apply
 * immediately to live sessions.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  classifyBashCommand,
  classifyFilePath,
  protectedBlockReason,
} from "./bash-classifier.ts";
import { readGuardPolicy } from "./guard-policy.ts";
import { requestPermission } from "./permissions.ts";

export function makeDataGuardExtension(
  projectId: string,
  getSessionId: () => string,
  sandboxRoot: string,
  options: { readPolicy?: typeof readGuardPolicy; request?: typeof requestPermission } = {},
): ExtensionFactory {
  const readPolicy = options.readPolicy ?? readGuardPolicy;
  const request = options.request ?? requestPermission;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const policy = readPolicy(sandboxRoot);
      const opts = { protectedGlobs: policy.protectedPaths, sandboxRoot };

      if (event.toolName === "write" || event.toolName === "edit") {
        const target = (event.input as { path?: unknown }).path;
        if (typeof target !== "string") return undefined;
        const verdict = classifyFilePath(target, opts);
        if (verdict.kind === "protected") {
          return { block: true, reason: protectedBlockReason(verdict.path, verdict.glob, `${event.toolName} ${verdict.path}`) };
        }
        return undefined;
      }

      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string" || !command.trim()) return undefined;
      const verdict = classifyBashCommand(command, opts);
      if (verdict.kind === "protected") {
        return { block: true, reason: protectedBlockReason(verdict.path, verdict.glob, verdict.detail) };
      }
      if (verdict.kind === "destructive" && policy.destructiveConfirm) {
        const outcome = await request(projectId, getSessionId(), {
          toolCallId: event.toolCallId,
          toolName: "bash",
          command,
          reason: `Destructive shell command: ${verdict.detail}`,
        });
        if (outcome === "allowed") return undefined;
        const reason =
          outcome === "denied"
            ? `The user declined this command (${verdict.detail}). Do not retry it; ask the user how to proceed.`
            : outcome === "timeout"
              ? `No answer within the permission window for: ${verdict.detail}. The user did NOT approve it. Do not retry it; state that approval is still needed.`
              : outcome === "no_ui"
                ? `Destructive command not permitted without an interactive confirmation (${verdict.detail}). Ask the user in chat first.`
                : `Run stopped before the user could approve: ${verdict.detail}.`;
        return { block: true, reason, terminate: outcome === "cancelled" };
      }
      return undefined;
    });
  };
}
