/**
 * Who am I? — identity of a pi-subagents child, as seen from inside the child.
 *
 * Kady's vendored child packages (kady-modal, kady-pdf-annotations) stamp
 * their work with the delegated run so the parent can attribute it: Modal jobs
 * a child submits are re-attributed to the parent chat on completion, and PDF
 * annotations name the specialist that wrote them.
 *
 * Up to pi-subagents 0.64 every child was its own `pi` process and the runner
 * exported `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT` into its
 * environment. Since 0.65 children are native Pi `AgentSession`s hosted in a
 * detached runner process — several per process — so a per-child environment
 * no longer exists and those variables are gone. What a child *can* still learn
 * is its own session: the session file the parent later receives as
 * `results[].sessionFile` (the same key the cost ledger, notebook and provenance
 * harvests already correlate on), the session id, and the display name
 * pi-subagents assigns (`<agent>: <task excerpt>`).
 *
 * The legacy variables are still honoured first so a wrapper that sets them
 * (or a test) keeps working.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SubagentChildIdentity {
  /** pi-subagents run id, when a legacy environment exports it. */
  runId?: string;
  /** Agent (specialist) name, from the environment or the session name. */
  agent?: string;
  /** Pi session id of this child. */
  sessionId?: string;
  /** Absolute path of this child's session JSONL, when persisted. */
  sessionFile?: string;
  /** pi-subagents' human-readable session name (`<agent>: <excerpt>`). */
  sessionName?: string;
}

/**
 * The agent name pi-subagents encodes at the front of a child session name.
 * `deriveChildSessionName` builds `<agent>: <excerpt>`, or the bare agent when
 * there is no excerpt; anything else is not a child session name we recognise.
 */
export function agentFromSessionName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const head = trimmed.split(": ", 1)[0]?.trim() ?? "";
  // Agent names are slug-like (pi-subagents validates them); a head with
  // whitespace is a task excerpt from a name that carried no agent.
  return head && !/\s/.test(head) ? head : undefined;
}

function legacyEnvIdentity(): Pick<SubagentChildIdentity, "runId" | "agent"> {
  const runId = process.env.PI_SUBAGENT_RUN_ID?.trim();
  const agent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
  return { ...(runId ? { runId } : {}), ...(agent ? { agent } : {}) };
}

/**
 * Subscribe to the child's `session_start` and return a getter for its
 * identity. The getter is safe to call before the session starts (it then
 * reports only what the environment says), and re-reads the environment on
 * every call so a late `PI_SUBAGENT_*` export is still seen.
 */
export function trackSubagentChildIdentity(pi: ExtensionAPI): () => SubagentChildIdentity {
  let session: Pick<SubagentChildIdentity, "sessionId" | "sessionFile" | "sessionName"> = {};
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      const manager = ctx?.sessionManager;
      if (!manager) return;
      const sessionFile = manager.getSessionFile?.();
      const sessionName = manager.getSessionName?.();
      session = {
        sessionId: manager.getSessionId?.(),
        ...(sessionFile ? { sessionFile } : {}),
        ...(sessionName ? { sessionName } : {}),
      };
    });
  }
  return () => {
    const env = legacyEnvIdentity();
    const agent = env.agent ?? agentFromSessionName(session.sessionName);
    return {
      ...env,
      ...(agent ? { agent } : {}),
      ...session,
    };
  };
}
