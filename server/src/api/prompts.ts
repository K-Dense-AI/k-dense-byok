/**
 * Prompt-template endpoints (Settings → Prompt templates, composer slash menu).
 * Scoped like skills: project via `X-Project-Id`, template scope via `?scope=`.
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  PromptOperationFailure,
  readPromptTemplate,
  restoreDefaultPromptTemplates,
  seedPromptTemplates,
  writePromptTemplate,
  type PromptScope,
} from "../agent/prompts.ts";

interface ScopeQuery {
  scope?: string;
}

const scopeOf = (raw?: string): PromptScope | undefined =>
  raw === "global" ? "global" : raw === "project" ? "project" : undefined;

function fail(reply: { code: (n: number) => unknown }, err: unknown): { detail: string } {
  if (err instanceof PromptOperationFailure) {
    reply.code(err.status);
    return { detail: err.detail };
  }
  reply.code(500);
  return { detail: err instanceof Error ? err.message : "Prompt template operation failed" };
}

export async function registerPromptRoutes(app: FastifyInstance): Promise<void> {
  // Merged (project wins) when no scope: what the composer and the agent see.
  // Seeding is marker-gated and cheap, so every route may call it: a project
  // created before this feature gets its templates on first use.
  const paths = () => {
    const p = activePaths();
    seedPromptTemplates(p);
    return p;
  };

  app.get<{ Querystring: ScopeQuery }>("/prompts", async (req) => {
    return listPromptTemplates(paths(), scopeOf(req.query.scope));
  });

  app.post<{ Querystring: ScopeQuery; Body: { name?: unknown; description?: unknown; argumentHint?: unknown; content?: unknown } }>(
    "/prompts",
    async (req, reply) => {
      const scope = scopeOf(req.query.scope) ?? "project";
      const body = req.body ?? {};
      if (typeof body.name !== "string") {
        reply.code(400);
        return { detail: "name is required" };
      }
      try {
        return createPromptTemplate(paths(), scope, {
          name: body.name.trim().toLowerCase(),
          description: typeof body.description === "string" ? body.description : undefined,
          argumentHint: typeof body.argumentHint === "string" ? body.argumentHint : undefined,
          content: typeof body.content === "string" ? body.content : undefined,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post("/prompts/restore-defaults", async () => {
    return { restored: restoreDefaultPromptTemplates(paths()) };
  });

  app.get<{ Params: { name: string }; Querystring: ScopeQuery }>("/prompts/:name/source", async (req, reply) => {
    const scope = scopeOf(req.query.scope) ?? "project";
    try {
      const source = readPromptTemplate(paths(), scope, req.params.name);
      if (!source) {
        reply.code(404);
        return { detail: `No such template: ${req.params.name}` };
      }
      return source;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { name: string }; Querystring: ScopeQuery; Body: { content?: unknown } }>(
    "/prompts/:name/source",
    async (req, reply) => {
      const scope = scopeOf(req.query.scope) ?? "project";
      try {
        writePromptTemplate(paths(), scope, req.params.name, String(req.body?.content ?? ""));
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { name: string }; Querystring: ScopeQuery }>("/prompts/:name", async (req, reply) => {
    const scope = scopeOf(req.query.scope) ?? "project";
    try {
      deletePromptTemplate(paths(), scope, req.params.name);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
