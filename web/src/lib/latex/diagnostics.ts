/**
 * Parse a LaTeX compile log into line-anchored diagnostics for the editor
 * gutter. Errors come from `-file-line-error` output (preferred; filtered to
 * the file being edited) with a classic `! message` / `l.N` fallback.
 * Warnings cover undefined references/citations and over/underfull boxes —
 * Unattributed warnings are only attached when editing the compile target.
 */
import { resolveRelative } from "./magic-comments";

export interface TexDiagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

const MAX_DIAGNOSTICS = 100;

const normalize = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");

/** TeX's file-line format allows spaces and Windows drive letters in paths. */
export function parseFileLineDiagnostic(raw: string): (TexDiagnostic & { file: string }) | null {
  const match = /^(.+?):(\d+):\s*(.+)$/.exec(raw);
  if (!match || Number(match[2]) < 1) return null;
  return { file: normalize(match[1].trim()), line: Number(match[2]), message: match[3].trim(), severity: "error" };
}

export function diagnosticMatchesFile(file: string, source: string, target = source): boolean {
  file = normalize(file);
  source = normalize(source);
  // Absolute engine paths may include the sandbox root; relative ones are
  // relative to the compile target, not to the currently edited chapter.
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) return file.endsWith("/" + source) || file === source;
  return resolveRelative(normalize(target), file) === source;
}

function parseErrors(log: string, fileName: string, target: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const seen = new Set<string>();
  let hasAttributedErrors = false;
  for (const raw of log.split("\n")) {
    const diagnostic = parseFileLineDiagnostic(raw);
    if (!diagnostic) continue;
    hasAttributedErrors = true;
    if (!diagnosticMatchesFile(diagnostic.file, fileName, target)) continue;
    const { line, message } = diagnostic;
    const key = `${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, message, severity: "error" });
  }
  if (hasAttributedErrors || fileName !== target) return out;

  let lastErr: string | null = null;
  for (const raw of log.split("\n")) {
    const em = /^! (.+)/.exec(raw);
    if (em) {
      lastErr = em[1].trim();
      continue;
    }
    const lm = /^l\.(\d+)/.exec(raw);
    if (lm && lastErr) {
      const line = parseInt(lm[1], 10);
      const key = `${line}:${lastErr}`;
      if (Number.isFinite(line) && !seen.has(key)) {
        seen.add(key);
        out.push({ line, message: lastErr, severity: "error" });
      }
      lastErr = null;
    }
  }
  return out;
}

function parseWarnings(log: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (line: number, message: string) => {
    const key = `${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, message, severity: "warning" });
  };

  let m: RegExpExecArray | null;
  const refRe =
    /LaTeX Warning: (Reference|Citation) ([`'][^']*') on page \d+ undefined on input line (\d+)/g;
  while ((m = refRe.exec(log)) !== null) {
    push(parseInt(m[3], 10), `${m[1]} ${m[2]} undefined`);
  }
  const boxRe = /^(Overfull|Underfull) (\\[hv]box \([^)]+\)) in paragraph at lines (\d+)--\d+/gm;
  while ((m = boxRe.exec(log)) !== null) {
    push(parseInt(m[3], 10), `${m[1]} ${m[2]}`);
  }
  const genericRe = /LaTeX Warning: (?!Reference|Citation)([^\n]+?) on input line (\d+)\./g;
  while ((m = genericRe.exec(log)) !== null) {
    push(parseInt(m[2], 10), m[1].trim());
  }
  return out;
}

export function parseCompileDiagnostics(
  log: string,
  fileName: string,
  target = fileName,
): TexDiagnostic[] {
  return [...parseErrors(log, fileName, target), ...(fileName === target ? parseWarnings(log) : [])].slice(
    0,
    MAX_DIAGNOSTICS,
  );
}
