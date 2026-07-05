/**
 * Parse a LaTeX compile log into line-anchored diagnostics for the editor
 * gutter. Errors come from `-file-line-error` output (preferred; filtered to
 * the file being edited) with a classic `! message` / `l.N` fallback.
 * Warnings cover undefined references/citations and over/underfull boxes —
 * these carry no file attribution in the log, so they are attached to the
 * open file (correct for single-file docs; harmless noise otherwise).
 */
export interface TexDiagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

const MAX_DIAGNOSTICS = 100;

function parseErrors(log: string, fileName: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const seen = new Set<string>();
  const base = fileName.split("/").pop()?.toLowerCase() ?? "";

  const fileLineRe = /^(?:\.\/)?(\S+?):(\d+):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = fileLineRe.exec(log)) !== null) {
    const file = m[1].split("/").pop()?.toLowerCase() ?? "";
    if (base && file !== base) continue;
    const line = parseInt(m[2], 10);
    const message = m[3].trim();
    if (!Number.isFinite(line) || !message) continue;
    const key = `${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, message, severity: "error" });
  }
  if (out.length > 0) return out;

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
): TexDiagnostic[] {
  return [...parseErrors(log, fileName), ...parseWarnings(log)].slice(
    0,
    MAX_DIAGNOSTICS,
  );
}
