/**
 * System + misc endpoints: /skills (installed catalogue), /ollama/models
 * (local model discovery), and /sandbox/init (heavier per-project bootstrap).
 * /health and /config live in index.ts.
 */
import type { FastifyInstance } from "fastify";
import { OLLAMA_BASE_URL } from "../config.ts";
import { activePaths } from "../projects.ts";
import { listProjectSkills, seedProjectSkills } from "../agent/skills.ts";

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/skills", async () => {
    return listProjectSkills(activePaths()).map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
    }));
  });

  // Seed the project's skills (network clone allowed). Used by first-run / a
  // "populate skills" action. Cheap no-op once skills exist.
  app.post<{ Querystring: { remote?: string } }>("/sandbox/init", async (req) => {
    const allowRemote = req.query.remote !== "false";
    const count = seedProjectSkills(activePaths(), allowRemote);
    return { ok: true, skills: count };
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
