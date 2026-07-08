/**
 * System + misc endpoints: /skills (installed catalogue), /ollama/models
 * (local model discovery), and /sandbox/init (heavier per-project bootstrap).
 * /health and /config live in index.ts.
 */
import type { FastifyInstance } from "fastify";
import { OLLAMA_BASE_URL } from "../config.ts";
import { activePaths } from "../projects.ts";
import {
  disableSkill,
  enableSkill,
  listDisabledSkills,
  listProjectSkills,
  readSkillSource,
  seedProjectSkills,
  SKILL_NAME_RE,
} from "../agent/skills.ts";
import { syncSandboxVenv } from "../sandbox-seed.ts";
import { getSystemStats } from "../system-stats.ts";

const GITHUB_REPO = "K-Dense-AI/k-dense-byok";
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000; // re-check at most once per hour
let versionCache: { ts: number; latestVersion: string | null } | null = null;

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Server-side proxy for the "latest release" check. Doing the GitHub fetch
  // here (instead of the browser) keeps the unauthenticated-rate-limit 403 out
  // of the user's console, lets us cache across reloads, and can use a token if
  // one is configured. Always 200s with a (possibly null) version.
  app.get("/version/latest", async () => {
    const now = Date.now();
    if (versionCache && now - versionCache.ts < VERSION_CACHE_TTL_MS) {
      return { latestVersion: versionCache.latestVersion };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const token = process.env.GITHUB_TOKEN;
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          signal: ctrl.signal,
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      clearTimeout(t);
      if (!resp.ok) {
        versionCache = { ts: now, latestVersion: null };
        return { latestVersion: null };
      }
      const data = (await resp.json()) as { tag_name?: string };
      const latestVersion = (data.tag_name ?? "").replace(/^v/, "") || null;
      versionCache = { ts: now, latestVersion };
      return { latestVersion };
    } catch {
      versionCache = { ts: now, latestVersion: null };
      return { latestVersion: null };
    }
  });

  // Live host-resource snapshot for the header monitor. Global (not
  // project-scoped); polled by the UI every few seconds.
  app.get("/system/resources", async () => getSystemStats());

  app.get("/skills", async () => {
    return listProjectSkills(activePaths()).map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
    }));
  });

  const toInfo = (s: { name: string; description: string }) => ({
    id: s.name,
    name: s.name,
    description: s.description,
  });

  app.get("/skills/all", async () => {
    const paths = activePaths();
    return {
      enabled: listProjectSkills(paths).map(toInfo),
      disabled: listDisabledSkills(paths).map(toInfo),
    };
  });

  app.get<{ Params: { name: string } }>("/skills/:name/source", async (req, reply) => {
    if (!SKILL_NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid skill name "${req.params.name}"` };
    }
    const content = readSkillSource(activePaths(), req.params.name);
    if (content === null) {
      reply.code(404);
      return { detail: `No such skill: ${req.params.name}` };
    }
    return { content };
  });

  app.post<{ Params: { name: string } }>("/skills/:name/enable", async (req, reply) => {
    const r = enableSkill(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/skills/:name/disable", async (req, reply) => {
    const r = disableSkill(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  // Seed the project's skills (network clone allowed). Used by first-run / a
  // "populate skills" action. Cheap no-op once skills exist.
  app.post<{ Querystring: { remote?: string; venv?: string } }>("/sandbox/init", async (req) => {
    const paths = activePaths();
    const allowRemote = req.query.remote !== "false";
    const count = seedProjectSkills(paths, allowRemote);
    const venvSynced = req.query.venv === "true" ? syncSandboxVenv(paths) : false;
    return { ok: true, skills: count, venvSynced };
  });

  // Proxy local Ollama tags → the UI Model shape. Returns available:false if
  // Ollama isn't running (the picker just hides the section).
  app.get("/ollama/models", async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/tags`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) return { available: false, models: [] };
      const data = (await resp.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => ({
        id: `ollama/${m.name}`,
        label: m.name,
        provider: "Ollama",
        tier: "budget",
        context_length: 0,
        pricing: { prompt: 0, completion: 0 },
        modality: "text->text",
        description: `Local Ollama model: ${m.name}`,
      }));
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  });
}
