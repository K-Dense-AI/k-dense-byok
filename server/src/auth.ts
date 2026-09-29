/**
 * Optional access token for the Kady API (Jupyter-style).
 *
 * On a single-user laptop the backend listens on loopback and the request
 * guard (`request-guard.ts`) is what keeps web pages out; no token is needed
 * and none is asked for. Two setups need more, because anything that can open
 * a TCP connection to the port can drive an agent with a shell as this user:
 *
 * - the backend is bound beyond loopback (`KADY_HOST`), so other machines can
 *   connect — the token is then required by default;
 * - a shared workstation / login node, where other OS users reach
 *   127.0.0.1 — opt in with `KADY_REQUIRE_AUTH=1`.
 *
 * The token is `KADY_AUTH_TOKEN` when provided (the launcher generates one),
 * otherwise generated at boot. It is left in `process.env` on purpose: the
 * child `pi` processes (kady-modal, research memory) inherit it to call back
 * into this API. That makes it readable by the agent's own shell — the same
 * user — which is the documented local trust boundary, not a regression.
 *
 * The browser presents it as `X-Kady-Token` on fetches, and as a `kady_token`
 * query parameter on URLs it cannot attach headers to (`<img>`, downloads,
 * pdf.js). The query form is redacted from request logs.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isExposedBind } from "./cors.ts";

export const AUTH_HEADER = "x-kady-token";
export const AUTH_QUERY_PARAM = "kady_token";
const MIN_TOKEN_LENGTH = 16;

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

/** Whether this process should demand a token at all. */
export function authRequired(): boolean {
  const explicit = envFlag("KADY_REQUIRE_AUTH");
  if (explicit !== undefined) return explicit;
  if (process.env.KADY_AUTH_TOKEN?.trim()) return true;
  return isExposedBind();
}

let activeToken: string | null | undefined;

/**
 * The token in force, generating (and exporting for child processes) one
 * when auth is required and none was supplied. `null` = auth disabled.
 */
export function ensureAuthToken(): string | null {
  if (activeToken !== undefined) return activeToken;
  if (!authRequired()) {
    activeToken = null;
    return null;
  }
  let token = process.env.KADY_AUTH_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    token = crypto.randomBytes(24).toString("base64url");
  }
  process.env.KADY_AUTH_TOKEN = token;
  activeToken = token;
  return token;
}

/** Test hook: forget the resolved token so env changes take effect. */
export function resetAuthForTests(): void {
  activeToken = undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function presentedToken(req: FastifyRequest): string | undefined {
  const header = req.headers[AUTH_HEADER];
  if (typeof header === "string" && header) return header;
  const authz = req.headers.authorization;
  if (typeof authz === "string" && /^bearer\s+/i.test(authz)) {
    return authz.replace(/^bearer\s+/i, "").trim();
  }
  const q = (req.query as Record<string, unknown> | undefined)?.[AUTH_QUERY_PARAM];
  return typeof q === "string" && q ? q : undefined;
}

/** Strip the token from a URL before it is logged. */
export function redactAuthFromUrl(url: string): string {
  if (!url.includes(`${AUTH_QUERY_PARAM}=`)) return url;
  return url.replace(new RegExp(`([?&]${AUTH_QUERY_PARAM}=)[^&#]*`, "g"), "$1[redacted]");
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const token = ensureAuthToken();
    // Preflights carry no custom headers by design; the actual request is
    // checked. The health probe reveals nothing and the launcher polls it.
    if (!token || req.method === "OPTIONS" || req.url === "/health") {
      done();
      return;
    }
    const presented = presentedToken(req);
    if (presented && safeEqual(presented, token)) {
      done();
      return;
    }
    // Model-auth failures are 401s too; this header is what tells the UI
    // to ask for the access token rather than a provider key.
    reply.header("X-Kady-Auth", "required");
    reply.code(401).send({
      detail:
        "This Kady server requires an access token. Open the link printed in the " +
        "terminal that started Kady, or paste the token when the app asks for it.",
      reason: "auth_required",
    });
  });
}
