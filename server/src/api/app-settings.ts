/**
 * App-wide defaults for new chats (Settings → Models → Defaults), global rather than
 * project-scoped: `<agentDir>/kady-settings.json` (see app-settings.ts).
 *   - GET /settings/defaults → { defaults }
 *   - PUT /settings/defaults → patch (a key set to null clears it) → { defaults }
 */
import type { FastifyInstance } from "fastify";
import {
  readAppDefaults,
  validateAppDefaultsPatch,
  writeAppDefaults,
  type AppDefaultsPatch,
} from "../app-settings.ts";
import { resolveModel } from "../agent/models.ts";
import { getModelRegistry } from "../agent/session-registry.ts";

export interface RegisterAppSettingsRoutesOptions {
  /** Agent dir holding kady-settings.json (tests point this at a temp dir). */
  agentDir?: string;
}

export async function registerAppSettingsRoutes(
  app: FastifyInstance,
  options: RegisterAppSettingsRoutesOptions = {},
): Promise<void> {
  app.get("/settings/defaults", async () => ({ defaults: readAppDefaults(options.agentDir) }));

  app.put<{ Body: AppDefaultsPatch }>("/settings/defaults", async (req, reply) => {
    const error = validateAppDefaultsPatch(req.body);
    if (error) {
      reply.code(400);
      return { detail: error };
    }
    const patch = req.body;
    // Shape alone would accept a typo'd direct-provider id that then fails
    // every new chat's first run; resolve it now, like the watchdog model.
    if (typeof patch.model === "string") {
      try {
        resolveModel(patch.model.trim(), getModelRegistry());
      } catch (err) {
        reply.code(400);
        return { detail: `Unknown default model: ${(err as Error).message}` };
      }
    }
    const written = writeAppDefaults(patch, options.agentDir);
    if (!written) {
      reply.code(409);
      return { detail: "kady-settings.json is not valid JSON; fix or delete it before changing defaults" };
    }
    return { defaults: written };
  });
}
