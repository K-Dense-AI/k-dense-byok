/** Pure request-shaping helpers for the latex-assist endpoint. */

import { findDocBodyStart } from "./prose";

const CONTEXT_RADIUS = 40;
const PREAMBLE_MAX_LINES = 120;
const DOC_BEGIN = "\\begin{document}";

export function lineRangeToOffsets(
  doc: string,
  startLine: number,
  endLine: number,
): { from: number; to: number } {
  const lines = doc.split("\n");
  // Compile logs can report lines from other files (or past EOF), so clamp
  // into this doc rather than indexing off the end of `lines`.
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  let from = 0;
  for (let i = 0; i < start - 1; i++) from += lines[i].length + 1;
  let to = from;
  for (let i = start - 1; i < end; i++) to += lines[i].length + 1;
  return { from, to: Math.min(to - 1, doc.length) };
}

export function extractPreamble(doc: string): string {
  // findDocBodyStart is %-comment-aware, so a commented-out `%\begin{document}`
  // doesn't truncate the preamble; 0 means no (uncommented) \begin{document}.
  const bodyStart = findDocBodyStart(doc);
  const head = bodyStart > 0 ? doc.slice(0, bodyStart - DOC_BEGIN.length) : "";
  return head.split("\n").slice(0, PREAMBLE_MAX_LINES).join("\n").trim();
}

export function buildFixPayload(
  doc: string,
  fileName: string,
  line: number,
  message: string,
) {
  const total = doc.split("\n").length;
  const errLine = Math.max(1, Math.min(line, total));
  const startLine = Math.max(1, errLine - CONTEXT_RADIUS);
  const endLine = Math.min(total, errLine + CONTEXT_RADIUS);
  const { from, to } = lineRangeToOffsets(doc, startLine, endLine);
  return {
    mode: "fix" as const,
    fileName,
    preamble: extractPreamble(doc),
    error: { line: errLine, message },
    context: { startLine, endLine, text: doc.slice(from, to) },
  };
}
