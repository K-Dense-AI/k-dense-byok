/**
 * Text fixups applied to model/server markdown before it is rendered.
 *
 * Both live in one place because they run on every streamed chunk of every
 * message, and both compensate for the renderer reading plain prose as syntax.
 */

/**
 * Insert a paragraph break before an ATX heading glued onto the previous line
 * (e.g. "…by condition:## Results"), which the stream concatenation can produce.
 */
function separateGluedHeadings(md: string): string {
  return md.replace(/([^\n])(#{1,6}\s+\S)/g, "$1\n\n$2");
}

/**
 * Escape every `$` that cannot delimit inline math, so currency survives.
 *
 * Single-dollar math stays on because papers write `$x$`, but micromark pairs
 * `$` the way it pairs backticks: "limit reached ($0.07 / $0.05)" renders as
 * math and both amounts lose their sign. Pandoc's stricter rule — an opener is
 * not followed by whitespace, a closer is not preceded by one — rejects exactly
 * that pairing, so a `$` with no legal partner is emitted as a literal.
 */
function escapeUnpairedDollars(md: string): string {
  let out = "";
  let i = 0;
  while (i < md.length) {
    const ch = md[i];
    if (ch === "\\") {
      out += md.slice(i, i + 2);
      i += 2;
      continue;
    }
    // Code spans and fences are copied verbatim: `$5` there is already literal.
    if (ch === "`") {
      const run = /^`+/.exec(md.slice(i))![0];
      const close = md.indexOf(run, i + run.length);
      const end = close === -1 ? md.length : close + run.length;
      out += md.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "$") {
      if (md[i + 1] === "$") {
        const close = md.indexOf("$$", i + 2);
        const end = close === -1 ? md.length : close + 2;
        out += md.slice(i, end);
        i = end;
        continue;
      }
      const close = inlineMathClose(md, i);
      if (close === -1) {
        out += "\\$";
        i += 1;
        continue;
      }
      out += md.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index of the `$` closing the span opened at `open`, or -1 when it is prose. */
function inlineMathClose(md: string, open: number): number {
  const next = md[open + 1];
  if (!next || /\s/.test(next)) return -1;
  for (let j = open + 2; j < md.length; j++) {
    const c = md[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    // A blank line ends the paragraph, so the span can never be closed.
    if (c === "\n" && md[j + 1] === "\n") return -1;
    if (c !== "$") continue;
    // The renderer would stop at this `$` whatever it looks like, so a
    // pandoc-illegal one means the pair as a whole isn't math — not that some
    // later `$` closes it. "$5 and $6" must escape, not span both amounts.
    return /\s/.test(md[j - 1]!) ? -1 : j;
  }
  return -1;
}

/** Prepare streamed markdown for the renderer. */
export function normalizeMarkdown(md: string): string {
  return escapeUnpairedDollars(separateGluedHeadings(md));
}
