/** Pure request-shaping helpers for the latex-assist endpoint. */

const CONTEXT_RADIUS = 40;
const PREAMBLE_MAX_LINES = 120;

export function lineRangeToOffsets(
  doc: string,
  startLine: number,
  endLine: number,
): { from: number; to: number } {
  const lines = doc.split("\n");
  let from = 0;
  for (let i = 0; i < startLine - 1; i++) from += lines[i].length + 1;
  let to = from;
  for (let i = startLine - 1; i < endLine; i++) to += lines[i].length + 1;
  return { from, to: Math.min(to - 1, doc.length) };
}

export function extractPreamble(doc: string): string {
  const idx = doc.indexOf("\\begin{document}");
  const head = idx >= 0 ? doc.slice(0, idx) : "";
  return head.split("\n").slice(0, PREAMBLE_MAX_LINES).join("\n").trim();
}

export function buildFixPayload(
  doc: string,
  fileName: string,
  line: number,
  message: string,
) {
  const total = doc.split("\n").length;
  const startLine = Math.max(1, line - CONTEXT_RADIUS);
  const endLine = Math.min(total, line + CONTEXT_RADIUS);
  const { from, to } = lineRangeToOffsets(doc, startLine, endLine);
  return {
    mode: "fix" as const,
    fileName,
    preamble: extractPreamble(doc),
    error: { line, message },
    context: { startLine, endLine, text: doc.slice(from, to) },
  };
}
