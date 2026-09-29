/**
 * Sanitize rich Jupyter cell outputs before they are injected into the DOM.
 *
 * `.ipynb` files in the sandbox are agent-written or user-uploaded (often
 * downloaded from the internet), so their `text/html` / `image/svg+xml`
 * outputs are untrusted markup. Rendering them raw in the app origin is
 * stored XSS with access to every backend route the UI uses, including the
 * one that runs `bash` as the OS user. Everything else that renders markup
 * (Streamdown, notebook-print) already sanitizes; this is the equivalent for
 * the notebook viewer.
 */
import DOMPurify from "dompurify";

/** DOMPurify has no `sanitize` outside a DOM (SSR); render nothing there. */
function canSanitize(): boolean {
  return typeof window !== "undefined" && DOMPurify.isSupported === true;
}

/** pandas-style HTML tables and similar; scripts, handlers and URL schemes stripped. */
export function sanitizeNotebookHtml(html: string): string {
  if (!canSanitize()) return "";
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Inline SVG (matplotlib et al.); `<script>`, `on*` and foreignObject stripped. */
export function sanitizeNotebookSvg(svg: string): string {
  if (!canSanitize()) return "";
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject"],
  });
}

/**
 * An SVG output as an `<img>` source. Inline SVG shares the app's document,
 * so even sanitized markup keeps global `<style>` (matplotlib's own
 * `*{stroke-linejoin:round}` leaks into the whole UI) and can overlay or
 * restyle the app. As an image it can run no script, load nothing and style
 * nothing outside itself — so the original markup is used as-is. Only the
 * namespace declarations an XML parse needs are added when missing.
 */
export function notebookSvgDataUrl(svg: string): string {
  let markup = svg.trim().replace(/^<\?xml[^>]*\?>\s*/, "");
  markup = markup.replace(/^(<!DOCTYPE[^>]*>\s*)/i, "");
  markup = markup.replace(/<svg\b([^>]*)>/i, (tag, attrs: string) => {
    let next = attrs;
    if (!/\sxmlns\s*=/.test(next)) next += ' xmlns="http://www.w3.org/2000/svg"';
    if (/xlink:/.test(markup) && !/\sxmlns:xlink\s*=/.test(next)) {
      next += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    }
    return `<svg${next}>`;
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/**
 * A full document for a sandboxed `srcdoc` iframe around an HTML output.
 * The frame gets no `allow-scripts` (nothing runs), its own document (styles
 * and fixed-position overlays stay inside it, and CSS selectors cannot see the
 * app's inputs), and a CSP that blocks every network load — remote images,
 * `@import`, fonts — so an output cannot beacon out either.
 */
export function notebookHtmlDocument(sanitizedHtml: string, dark: boolean): string {
  const fg = dark ? "#e5e5e5" : "#171717";
  const muted = dark ? "#404040" : "#e5e5e5";
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    "<style>" +
    `html,body{margin:0;padding:0;background:transparent;color:${fg};` +
    "font:12px/1.4 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}" +
    `table{border-collapse:collapse;font-size:12px}th,td{padding:2px 8px;border-bottom:1px solid ${muted};text-align:right}` +
    "th{font-weight:600}img,svg{max-width:100%}" +
    "</style></head><body>" +
    sanitizedHtml +
    "</body></html>"
  );
}
