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
