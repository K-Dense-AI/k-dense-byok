/**
 * Which browser origins and Host headers may talk to this backend.
 *
 * The backend is an unauthenticated local API that can run an agent with a
 * shell, edit credentials and add MCP servers, so "which web page may call it"
 * is the security boundary against the browser:
 *
 * - Origins: the UI's own port (`KADY_FRONTEND_PORT`, default 3000) on a
 *   loopback name or one of this machine's interface addresses. Not any port:
 *   the agent routinely starts local servers (`python -m http.server`,
 *   Streamlit, Jupyter, a second `next dev` that lands on 3001) that serve
 *   untrusted HTML, and a page from any of them would otherwise pass as the
 *   UI. Anything else must be listed in `KADY_ALLOWED_ORIGINS`. The old
 *   blanket allow-list of every RFC 1918 range let any intranet page (a
 *   printer admin UI, an XSS on any internal http site) drive a user's agent;
 *   it now applies only when the operator deliberately binds the backend off
 *   loopback (`KADY_HOST`) and has not listed origins explicitly.
 * - Hosts: DNS rebinding points an attacker's hostname at 127.0.0.1, which
 *   makes the attacker's page same-origin with us and bypasses CORS entirely.
 *   Only names an attacker cannot rebind are accepted: loopback names, IP
 *   literals, this machine's hostname, and `KADY_ALLOWED_HOSTS`.
 */
import os from "node:os";
import { HOST } from "./config.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Legacy LAN allow-list, kept only for an explicitly exposed backend. */
const PRIVATE_LAN_ORIGINS = [
  /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}:\d+$/,
];

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(h) || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h);
}

/** True when the backend was deliberately bound beyond loopback. */
export function isExposedBind(host = process.env.KADY_HOST ?? HOST): boolean {
  const h = host.trim().toLowerCase();
  return !(isLoopbackHostname(h) || h === "[::1]");
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.startsWith("[") && hostname.endsWith("]");
}

/** This machine's own interface addresses, as URL hostnames. */
function localInterfaceHostnames(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        if (!iface.address) continue;
        // Drop any IPv6 zone id: a URL hostname never carries it.
        const addr = iface.address.split("%")[0].toLowerCase();
        out.add(iface.family === "IPv6" || addr.includes(":") ? `[${addr}]` : addr);
      }
    }
  } catch {
    // Some sandboxes forbid enumerating interfaces; loopback still works.
  }
  return out;
}

function machineHostnames(): Set<string> {
  const out = new Set<string>();
  try {
    const name = os.hostname().toLowerCase();
    if (name) {
      out.add(name);
      out.add(name.split(".")[0]);
      if (!name.endsWith(".local")) out.add(`${name.split(".")[0]}.local`);
    }
  } catch {
    // ignore
  }
  return out;
}

interface Policy {
  origins: Set<string>;
  hosts: Set<string>;
  allowPrivateLan: boolean;
  interfaces: Set<string>;
  interfacesAt: number;
}

let cached: { key: string; policy: Policy } | null = null;

function policy(): Policy {
  const key = [
    process.env.KADY_ALLOWED_ORIGINS ?? "",
    process.env.KADY_ALLOWED_HOSTS ?? "",
    process.env.KADY_HOST ?? "",
  ].join("\u0000");
  const now = Date.now();
  if (cached && cached.key === key) {
    // Interfaces change (VPN up, Wi-Fi roam); refresh them now and then.
    if (now - cached.policy.interfacesAt > 30_000) {
      cached.policy.interfaces = localInterfaceHostnames();
      cached.policy.interfacesAt = now;
    }
    return cached.policy;
  }
  const origins = new Set<string>();
  for (const entry of splitList(process.env.KADY_ALLOWED_ORIGINS)) {
    const normalized = normalizeOrigin(entry);
    if (normalized) origins.add(normalized);
  }
  const hosts = new Set<string>(machineHostnames());
  for (const entry of splitList(process.env.KADY_ALLOWED_HOSTS)) {
    hosts.add(entry.toLowerCase().replace(/:\d+$/, ""));
  }
  // A backend bound to a named interface is reached by that name.
  const bind = (process.env.KADY_HOST ?? HOST).trim().toLowerCase();
  if (bind && !isIpLiteral(bind) && bind !== "0.0.0.0" && bind !== "::") hosts.add(bind);
  for (const origin of origins) {
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // normalizeOrigin already validated it
    }
  }
  const allowPrivateLan =
    isExposedBind(process.env.KADY_HOST ?? HOST) && origins.size === 0;
  const next: Policy = {
    origins,
    hosts,
    allowPrivateLan,
    interfaces: localInterfaceHostnames(),
    interfacesAt: now,
  };
  cached = { key, policy: next };
  return next;
}

/** Port the UI is served on; the launcher pins it (default 3000). */
function uiPort(): string {
  const raw = process.env.KADY_FRONTEND_PORT?.trim();
  return raw && /^\d{1,5}$/.test(raw) ? raw : "3000";
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * Whether a browser page from `origin` may call this API. Requests without
 * an Origin header come from non-browser clients (curl, the child `pi`
 * processes, tests) or from same-origin GETs; those are allowed here and the
 * Host check below is what protects them from DNS rebinding.
 */
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false; // includes the opaque "null" origin
  const p = policy();
  if (p.origins.has(normalized)) return true;
  const url = new URL(normalized);
  const hostname = url.hostname;
  if (p.allowPrivateLan && PRIVATE_LAN_ORIGINS.some((re) => re.test(normalized))) return true;
  if (effectivePort(url) !== uiPort()) return false;
  return isLoopbackHostname(hostname) || p.interfaces.has(hostname);
}

/** Hostname part of a Host header (`[::1]:8000` → `[::1]`). */
export function hostHeaderHostname(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Whether the Host header names us under a name an attacker cannot point at
 * this machine. IP literals cannot be rebound, so LAN deployments reached by
 * address keep working; named deployments list their name in
 * `KADY_ALLOWED_HOSTS`.
 */
export function isHostAllowed(host: string | undefined): boolean {
  if (!host) return true; // HTTP/1.0 or in-process inject; nothing to rebind
  const hostname = hostHeaderHostname(host);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIpLiteral(hostname)) return true;
  return policy().hosts.has(hostname);
}

export function corsResponseHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !isCorsOriginAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
