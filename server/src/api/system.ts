/**
 * System + misc endpoints: /skills (installed catalogue), /ollama/models and
 * /openai-compatible/models (local model discovery), and /sandbox/init
 * (heavier per-project bootstrap). /health and /config live in index.ts.
 */
import type { FastifyInstance } from "fastify";
import {
  OLLAMA_BASE_URL,
  OPENAI_COMPATIBLE_BASE_URL,
  OPENAI_COMPATIBLE_CONFIGURED,
} from "../config.ts";
import { activePaths } from "../projects.ts";
import {
  applyDefaultSkillStates,
  disableSkill,
  enableSkill,
  listProjectSkills,
  listSkillsWithProblems,
  readSkillSource,
  seedProjectSkills,
  SKILL_NAME_RE,
} from "../agent/skills.ts";
import {
  getSkillSyncStatus,
  isSkillSyncActive,
  replaceProjectSkillFromRemote,
  syncProjectSkillsFromRemote,
} from "../agent/skills-sync.ts";
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
    const paths = activePaths();
    applyDefaultSkillStates(paths);
    return listProjectSkills(paths).map((s) => ({
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
    applyDefaultSkillStates(paths);
    const { enabled, disabled, problems } = listSkillsWithProblems(paths);
    return {
      enabled: enabled.map(toInfo),
      disabled: disabled.map(toInfo),
      problems,
      sync: {
        ...getSkillSyncStatus(paths),
        syncing: isSkillSyncActive(),
      },
    };
  });

  app.post("/skills/sync", async (_req, reply) => {
    const paths = activePaths();
    try {
      const result = await syncProjectSkillsFromRemote(paths);
      return { ok: true, result };
    } catch (err) {
      reply.code(502);
      return {
        detail: err instanceof Error ? err.message : "Failed to synchronize skills",
      };
    }
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

  app.post<{ Params: { name: string } }>("/skills/:name/update", async (req, reply) => {
    const { name } = req.params;
    if (!SKILL_NAME_RE.test(name)) {
      reply.code(400);
      return { detail: `Invalid skill name "${name}"` };
    }
    try {
      const sync = await replaceProjectSkillFromRemote(activePaths(), name);
      return { ok: true, sync };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Failed to update skill";
      reply.code(detail.startsWith("No such upstream skill:") ? 404 : 502);
      return { detail };
    }
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

  // Same idea for any server speaking the standard OpenAI `/v1/models` shape
  // (LM Studio, vLLM, text-generation-webui, …). Kept as a parallel path to the
  // Ollama route above rather than factored into a shared helper: the two
  // discovery protocols are unrelated, and Ollama's is upstream-owned.
  //
  // `configured` tells the picker whether the user explicitly asked for this
  // provider, so it can stay hidden for everyone else instead of showing a
  // permanently dead section.
  app.get("/openai-compatible/models", async () => {
    const configured = OPENAI_COMPATIBLE_CONFIGURED;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(
        `${OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, "")}/v1/models`,
        { signal: ctrl.signal },
      );
      clearTimeout(t);
      if (!resp.ok) return { available: false, configured, models: [] };
      const data = (await resp.json()) as { data?: unknown };
      // Deliberately lenient: take `id` off each entry and skip anything that
      // doesn't have one, so a single odd row can't blank out the whole list.
      // Nothing beyond `id` is trusted — servers disagree on every other field.
      const seen = new Set<string>();
      const models = [];
      for (const entry of Array.isArray(data.data) ? data.data : []) {
        const id = (entry as { id?: unknown })?.id;
        if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id: `openai-compatible/${id}`,
          label: id,
          provider: "OpenAI-Compatible",
          tier: "budget",
          context_length: 0,
          pricing: { prompt: 0, completion: 0 },
          modality: "text->text",
          description: `Local OpenAI-compatible model: ${id}`,
        });
      }
      return { available: true, configured, models };
    } catch {
      return { available: false, configured, models: [] };
    }
  });
}
