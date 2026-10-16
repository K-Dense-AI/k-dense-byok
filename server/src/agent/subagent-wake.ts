/**
 * Since pi-subagents 0.77 a background result or supervisor question reaching
 * an idle parent is appended as a hidden custom message, then the parent is
 * woken with this fixed user prompt (`sendUserMessage(…, { deliverAs: "steer" })`,
 * src/shared/parent-wake.js, not a public export). It is plumbing addressed to
 * the model, not something the user typed, so the chat never shows it as a
 * user bubble. `test/subagent-wake.test.ts` checks it against the installed
 * package.
 */
export const PARENT_WAKE_TEXT =
  "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";

export function isParentWake(text: string): boolean {
  return text.trim() === PARENT_WAKE_TEXT;
}
