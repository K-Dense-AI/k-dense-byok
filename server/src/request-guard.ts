/**
 * First hook on every request: refuse callers the browser security model
 * would otherwise let through, and send every response with headers that keep
 * sandbox content from running on this origin.
 *
 * CORS alone only stops a foreign page from *reading* a response. It does not
 * stop the request: a `<form>` POST (text/plain, urlencoded, multipart) from
 * any website reaches a handler with no preflight, an `<img>` fires a GET,
 * and a DNS-rebound hostname makes the attacker's page same-origin, so CORS
 * never applies at all. For an API that can start an agent with a shell, the
 * request itself is the attack.
 *
 * - A Host header naming something an attacker could rebind → 403.
 * - An Origin that is not an allowed UI (`cors.ts`) → 403, preflights included.
 * - A no-cors subresource load (`<img>`, `<script>`, `<video>`) embedded by
 *   another origin → 403 unless its Referer is an allowed UI. Browsers mark
 *   these with `Sec-Fetch-*` and send no Origin, so without this a page on any
 *   site — or on any other localhost port — could fire side-effecting GETs.
 *
 * Requests with no Origin and no cross-site fetch metadata (curl, the child
 * `pi` processes on loopback, top-level navigations, `app.inject` in tests)
 * pass; browsers attach Origin to every cross-origin fetch and every non-GET.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCorsOriginAllowed, isHostAllowed } from "./cors.ts";

export type GuardVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "host_not_allowed" | "origin_not_allowed" | "cross_site_embed";
      detail: string;
    };

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function checkRequest(headers: FastifyRequest["headers"]): GuardVerdict {
  const host = headers.host;
  if (!isHostAllowed(host)) {
    return {
      ok: false,
      reason: "host_not_allowed",
      detail:
        `Host "${host}" is not allowed. If you reach Kady by this name on purpose, ` +
        "add it to KADY_ALLOWED_HOSTS.",
    };
  }
  const origin = one(headers.origin);
  if (origin !== undefined) {
    if (isCorsOriginAllowed(origin)) return { ok: true };
    return {
      ok: false,
      reason: "origin_not_allowed",
      detail:
        `Origin "${origin}" may not call the Kady API. To open the UI from another ` +
        "address, add that origin to KADY_ALLOWED_ORIGINS.",
    };
  }
  const site = one(headers["sec-fetch-site"]);
  const mode = one(headers["sec-fetch-mode"]);
  if (site && site !== "same-origin" && site !== "none" && mode !== "navigate") {
    // Our own UI embeds images and media from here too; its Referer (the
    // browser default policy sends the origin cross-origin) names it.
    const referer = originOf(one(headers.referer));
    if (!referer || !isCorsOriginAllowed(referer)) {
      return {
        ok: false,
        reason: "cross_site_embed",
        detail: "Kady API resources cannot be embedded by other sites.",
      };
    }
  }
  return { ok: true };
}

/**
 * Sandbox files are served from this origin (`/sandbox/raw`), and a sandbox
 * holds untrusted content by design: downloaded supplements, uploaded zips,
 * agent-written HTML reports and SVG figures. Opened as a page, an HTML or
 * SVG file would run script with full access to this API. CSP `sandbox`
 * gives every response an opaque origin with scripts disabled (its requests
 * then carry `Origin: null`, which the guard refuses); `<img>`, `<video>` and
 * `fetch()` consumers are unaffected. PDFs are exempt so a browser's built-in
 * viewer still opens them in a tab — viewers run PDF script in their own
 * isolated engine, not in this origin's DOM.
 */
const CONTENT_CSP = [
  "sandbox",
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
].join("; ");

export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const verdict = checkRequest(req.headers);
    if (verdict.ok) {
      done();
      return;
    }
    req.log.warn(
      {
        host: req.headers.host,
        origin: req.headers.origin,
        fetchSite: req.headers["sec-fetch-site"],
        method: req.method,
        url: req.url.split("?")[0],
      },
      `request refused: ${verdict.reason}`,
    );
    reply.code(403).send({ detail: verdict.detail, reason: verdict.reason });
  });

  app.addHook("onSend", (_req, reply, payload, done) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // URLs here may carry `kady_token` (auth.ts); never leak them onward.
    reply.header("Referrer-Policy", "no-referrer");
    const type = String(reply.getHeader("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/pdf")) {
      reply.header("Content-Security-Policy", CONTENT_CSP);
    }
    done(null, payload);
  });
}
