/**
 * Optional access token for the Kady backend (see server/src/auth.ts).
 *
 * A default single-user install never needs one and nothing here changes its
 * behaviour: with no stored token, headers and URLs are left untouched. When
 * the backend is exposed beyond loopback (or `KADY_REQUIRE_AUTH=1`), the
 * launcher opens the UI as `…/#kady-token=<token>`; the fragment never reaches
 * a server or a Referer. We keep the token in localStorage, strip it from the
 * address bar, and present it as `X-Kady-Token` on fetches and as a
 * `kady_token` query parameter on URLs the browser loads itself (`<img>`,
 * downloads, pdf.js).
 */

const TOKEN_KEY = "kady:apiToken";
const HASH_PARAM = "kady-token";
const QUERY_PARAM = "kady_token";
export const AUTH_REQUIRED_EVENT = "kady:auth-required";

function captureTokenFromLocation(): void {
  if (typeof window === "undefined") return;
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash.includes(`${HASH_PARAM}=`)) return;
    const params = new URLSearchParams(hash);
    const token = params.get(HASH_PARAM)?.trim();
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    params.delete(HASH_PARAM);
    const rest = params.toString();
    const url = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`;
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // Storage blocked: the token simply is not remembered.
  }
}

captureTokenFromLocation();

export function getApiToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** Accepts a bare token or a whole `…#kady-token=…` link. */
export function setApiToken(input: string): void {
  if (typeof window === "undefined") return;
  let token = input.trim();
  const at = token.indexOf(`${HASH_PARAM}=`);
  if (at !== -1) {
    token = decodeURIComponent(token.slice(at + HASH_PARAM.length + 1).split(/[&\s]/)[0] ?? "");
  }
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // best-effort
  }
}

export function withApiTokenHeader(headers: Headers): Headers {
  const token = getApiToken();
  if (token && !headers.has("X-Kady-Token")) headers.set("X-Kady-Token", token);
  return headers;
}

/** Append the token to a backend URL the browser will load by itself. */
export function withApiToken(url: string): string {
  const token = getApiToken();
  if (!token) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${QUERY_PARAM}=${encodeURIComponent(token)}${hash}`;
}

/** Tell the token gate the backend refused us (see ApiTokenGate). */
export function noteAuthFailure(res: Response): void {
  if (typeof window === "undefined") return;
  if (!res || res.status !== 401 || res.headers?.get?.("X-Kady-Auth") !== "required") return;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}
