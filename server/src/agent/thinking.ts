/**
 * Thinking-level validation for the run endpoint. Pi's session clamps the
 * level per model capability; this only guards the untrusted wire value.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** The value as a ThinkingLevel, or undefined if it isn't one (caller keeps the session's current level). */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}
