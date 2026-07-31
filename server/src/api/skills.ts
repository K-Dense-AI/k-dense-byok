/**
 * Skill management endpoints.
 *
 * Every route is scoped twice: by project (the `X-Project-Id` header, via
 * `activePaths()`) and by skill scope — `?scope=project` (the default, a
 * project sandbox) or `?scope=global` (the user-level Pi agent dir, shared by
 * all projects and inherited by subagent child processes).
 *
 * Split out of `system.ts` once skills grew from "list and toggle" into install,
 * author, edit, remove and update-check.
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import {
  applyDefaultSkillStates,
  disableSkill,
  enableSkill,
  globalSkillRoot,
  listProjectSkills,
  listSkillsWithProblems,
  projectSkillRoot,
  readSkillSource,
  seedProjectSkills,
  skillRootForScope,
  SKILL_NAME_RE,
  type SkillRoot,
} from "../agent/skills.ts";
import {
  getSkillOrigins,
  getSkillProvenance,
  getSkillSyncStatus,
  isSkillSyncActive,
  replaceProjectSkillFromRemote,
  syncProjectSkillsFromRemote,
} from "../agent/skills-sync.ts";
import {
  checkSkillUpdate,
  createSkill,
  installStagedSkills,
  previewSkillSource,
  removeSkill,
  SkillOperationFailure,
  updateSkillFromSource,
  writeSkillSource,
} from "../agent/skills-install.ts";
import { syncSandboxVenv } from "../sandbox-seed.ts";

interface ScopeQuery {
  scope?: string;
}

/** Map a thrown SkillOperationFailure to its status; rethrow anything else. */
function replyWithFailure(reply: { code: (n: number) => unknown }, err: unknown): {
  detail: string;
} {
  if (err instanceof SkillOperationFailure) {
    reply.code(err.status);
    return { detail: err.detail };
  }
  reply.code(500);
  return { detail: err instanceof Error ? err.message : "Skill operation failed" };
}

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {
  const toInfo = (
    skill: { name: string; description: string },
    root: SkillRoot,
    origins: Record<string, string>,
  ) => {
    const provenance = getSkillProvenance(root, skill.name);
    return {
      id: skill.name,
      name: skill.name,
      description: skill.description,
      origin: origins[skill.name] ?? "catalogue",
      ...(provenance?.source ? { source: provenance.source } : {}),
      ...(provenance?.ref ? { ref: provenance.ref } : {}),
    };
  };

  /**
   * Enabled skills only — the chat composer's picker.
   *
   * With no explicit scope this merges both roots, because that is what the
   * agent actually loads: a skill installed for all projects is available in
   * this one, and a picker that hid it would disagree with the agent. Project
   * entries win on a name clash, matching Pi's own first-wins resolution.
   */
  app.get<{ Querystring: ScopeQuery }>("/skills", async (req) => {
    const paths = activePaths();
    applyDefaultSkillStates(paths);
    if (req.query.scope) {
      const root = skillRootForScope(paths, req.query.scope);
      const origins = getSkillOrigins(root);
      return listProjectSkills(root).map((s) => toInfo(s, root, origins));
    }

    const project = projectSkillRoot(paths);
    const global = globalSkillRoot();
    const byName = new Map<string, ReturnType<typeof toInfo>>();
    for (const [root, origins] of [
      [global, getSkillOrigins(global)] as const,
      [project, getSkillOrigins(project)] as const,
    ]) {
      for (const skill of listProjectSkills(root)) {
        byName.set(skill.name, toInfo(skill, root, origins));
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  app.get<{ Querystring: ScopeQuery }>("/skills/all", async (req) => {
    const paths = activePaths();
    applyDefaultSkillStates(paths);
    const root = skillRootForScope(paths, req.query.scope);
    const { enabled, disabled, problems } = listSkillsWithProblems(root);
    const origins = getSkillOrigins(root);

    // Pi resolves project skills before user-level ones and skill-name
    // collisions are first-wins, so a project skill of the same name wins.
    // Surfacing that is the difference between "my global skill is off" and a
    // silent no-op.
    const shadowedBy =
      root.kind === "global" ? projectSkillRoot(paths) : globalSkillRoot();
    const shadowNames = new Set(
      [
        ...listSkillsWithProblems(shadowedBy).enabled,
        ...listSkillsWithProblems(shadowedBy).disabled,
      ].map((s) => s.name),
    );

    return {
      scope: root.kind,
      enabled: enabled.map((s) => toInfo(s, root, origins)),
      disabled: disabled.map((s) => toInfo(s, root, origins)),
      problems,
      shadowed: [...enabled, ...disabled]
        .map((s) => s.name)
        .filter((name) => shadowNames.has(name)),
      sync: {
        ...getSkillSyncStatus(root),
        syncing: isSkillSyncActive(),
      },
    };
  });

  // Refresh the catalogue. Project-scoped by definition: the user-level root
  // holds only skills the user installed or wrote.
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

  app.get<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name/source",
    async (req, reply) => {
      if (!SKILL_NAME_RE.test(req.params.name)) {
        reply.code(400);
        return { detail: `Invalid skill name "${req.params.name}"` };
      }
      const root = skillRootForScope(activePaths(), req.query.scope);
      const content = readSkillSource(root, req.params.name);
      if (content === null) {
        reply.code(404);
        return { detail: `No such skill: ${req.params.name}` };
      }
      return { content, origin: getSkillProvenance(root, req.params.name)?.origin };
    },
  );

  app.put<{
    Params: { name: string };
    Querystring: ScopeQuery;
    Body: { content?: string };
  }>("/skills/:name/source", async (req, reply) => {
    const root = skillRootForScope(activePaths(), req.query.scope);
    try {
      writeSkillSource(root, req.params.name, req.body?.content ?? "");
      return { ok: true };
    } catch (err) {
      return replyWithFailure(reply, err);
    }
  });

  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name/enable",
    async (req, reply) => {
      const root = skillRootForScope(activePaths(), req.query.scope);
      const r = enableSkill(root, req.params.name);
      if (!r.ok) {
        reply.code(r.status);
        return { detail: r.detail };
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name/disable",
    async (req, reply) => {
      const root = skillRootForScope(activePaths(), req.query.scope);
      const r = disableSkill(root, req.params.name);
      if (!r.ok) {
        reply.code(r.status);
        return { detail: r.detail };
      }
      return { ok: true };
    },
  );

  /**
   * Take the upstream copy of a skill. Catalogue skills come from the shared
   * catalogue download; skills installed from elsewhere are re-fetched from
   * their own recorded source.
   */
  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name/update",
    async (req, reply) => {
      const { name } = req.params;
      if (!SKILL_NAME_RE.test(name)) {
        reply.code(400);
        return { detail: `Invalid skill name "${name}"` };
      }
      const paths = activePaths();
      const root = skillRootForScope(paths, req.query.scope);
      const origin = getSkillProvenance(root, name)?.origin ?? "catalogue";
      try {
        if (origin === "catalogue" && root.kind === "project") {
          const sync = await replaceProjectSkillFromRemote(paths, name);
          return { ok: true, sync };
        }
        const result = await updateSkillFromSource(root, name);
        return { ok: true, ...result };
      } catch (err) {
        if (err instanceof SkillOperationFailure) return replyWithFailure(reply, err);
        const detail = err instanceof Error ? err.message : "Failed to update skill";
        reply.code(detail.startsWith("No such upstream skill:") ? 404 : 502);
        return { detail };
      }
    },
  );

  /**
   * Ask a user-installed skill's own source whether it changed. On-demand only:
   * user skills are never auto-updated.
   */
  app.post<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name/check-update",
    async (req, reply) => {
      const root = skillRootForScope(activePaths(), req.query.scope);
      try {
        return { ok: true, ...(await checkSkillUpdate(root, req.params.name)) };
      } catch (err) {
        return replyWithFailure(reply, err);
      }
    },
  );

  app.delete<{ Params: { name: string }; Querystring: ScopeQuery }>(
    "/skills/:name",
    async (req, reply) => {
      const root = skillRootForScope(activePaths(), req.query.scope);
      try {
        return { ok: true, ...removeSkill(root, req.params.name) };
      } catch (err) {
        return replyWithFailure(reply, err);
      }
    },
  );

  // Download a source and report what it holds, without installing.
  app.post<{ Body: { source?: string; ref?: string; scope?: string } }>(
    "/skills/preview",
    async (req, reply) => {
      try {
        return await previewSkillSource(activePaths(), {
          source: req.body?.source ?? "",
          ref: req.body?.ref,
          scope: req.body?.scope,
        });
      } catch (err) {
        return replyWithFailure(reply, err);
      }
    },
  );

  app.post<{
    Body: {
      source?: string;
      ref?: string;
      names?: string[];
      scope?: string;
      stagingToken?: string;
      replace?: boolean;
      acknowledged?: boolean;
    };
  }>("/skills/install", async (req, reply) => {
    const body = req.body ?? {};
    try {
      const result = await installStagedSkills(activePaths(), {
        source: body.source ?? "",
        ref: body.ref,
        names: Array.isArray(body.names) ? body.names : [],
        scope: body.scope,
        stagingToken: body.stagingToken,
        replace: body.replace,
        acknowledged: body.acknowledged,
      });
      return { ok: true, ...result };
    } catch (err) {
      return replyWithFailure(reply, err);
    }
  });

  app.post<{ Body: { name?: string; description?: string; scope?: string } }>(
    "/skills/create",
    async (req, reply) => {
      const body = req.body ?? {};
      try {
        return { ok: true, ...createSkill(activePaths(), {
          name: body.name ?? "",
          description: body.description,
          scope: body.scope,
        }) };
      } catch (err) {
        return replyWithFailure(reply, err);
      }
    },
  );

  // Seed the project's skills (download allowed). Used by first-run / a
  // "populate skills" action. Cheap no-op once skills exist.
  app.post<{ Querystring: { remote?: string; venv?: string } }>(
    "/sandbox/init",
    async (req) => {
      const paths = activePaths();
      const allowRemote = req.query.remote !== "false";
      const count = await seedProjectSkills(paths, allowRemote);
      const venvSynced = req.query.venv === "true" ? syncSandboxVenv(paths) : false;
      return { ok: true, skills: count, venvSynced };
    },
  );
}
