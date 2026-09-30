import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { waitForRunRelease } from "./run-pipeline.ts";

/**
 * Pause extension submissions while manual compaction owns the session.
 * Pi's sendCustomMessage(triggerTurn) bypasses prompt()'s compaction guard,
 * including from compaction_end hooks before Kady has recorded summary usage.
 * Pi's extension dispatchers call these public methods dynamically and attach
 * their own error handlers, so preserve each returned promise and rejection.
 */
export function deferSessionMessages(
  session: Pick<AgentSession, "sessionId" | "sendCustomMessage" | "sendUserMessage">,
  projectId: string,
): () => void {
  const custom = session.sendCustomMessage;
  const user = session.sendUserMessage;
  let resume!: () => void;
  let queue = new Promise<void>((resolve) => { resume = resolve; });
  const enqueue = (deliver: () => Promise<void>): Promise<void> => {
    const delivery = queue.then(async () => {
      await waitForRunRelease(projectId, session.sessionId);
      try {
        await deliver();
      } finally {
        // agent_settled precedes provenance flush and ledger writes. Starting
        // the next turn before that claim clears would hide it from the observer.
        await waitForRunRelease(projectId, session.sessionId);
      }
    });
    // One bad submission must not discard later notices or turns.
    queue = delivery.catch(() => {});
    return delivery;
  };
  session.sendCustomMessage = (message, options) => enqueue(() => custom.call(session, message, options));
  session.sendUserMessage = (content, options) => enqueue(() => user.call(session, content, options));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.sendCustomMessage = custom;
    session.sendUserMessage = user;
    resume();
  };
}
