/** A missing-context response must never be inserted into the document. */
export type LatexAssistDecision =
  | { status: "replacement"; replacement: string }
  | { status: "needs_context"; message: string };

export function parseLatexAssistDecision(text: string): LatexAssistDecision | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  try {
    const value = JSON.parse(fenced ? fenced[1] : trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.status === "replacement" && typeof value.replacement === "string"
      && Object.keys(value).every((key) => key === "status" || key === "replacement")) {
      return { status: "replacement", replacement: value.replacement };
    }
    if (value.status === "needs_context" && typeof value.message === "string"
      && value.message.trim() && value.message.length <= 2000
      && Object.keys(value).every((key) => key === "status" || key === "message")) {
      return { status: "needs_context", message: value.message.trim() };
    }
  } catch { /* malformed or partial responses cannot be applied */ }
  return null;
}
