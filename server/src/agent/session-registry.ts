/**
 * Live AgentSession registry.
 *
 * Each chat tab maps to one Pi AgentSession persisted as a JSONL file under the
 * project's `sandbox/.pi/sessions/`. We hold the live session objects in a Map
 * (keyed by projectId:sessionId) so streaming runs reuse warm state, and
 * cold-open from disk after a restart. AuthStorage + ModelRegistry are process
 * singletons (shared OpenRouter key across all projects).
 */
import fs from "node:fs";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { defaultModel, setupAuth } from "./models.ts";
import { BUILTIN_TOOLS, makeSpawnSubagentTool } from "./tools.ts";

const authStorage = AuthStorage.create();
setupAuth(authStorage);
const modelRegistry = ModelRegistry.create(authStorage);

export function getAuthStorage(): AuthStorage {
  return authStorage;
}
export function getModelRegistry(): ModelRegistry {
  return modelRegistry;
}

const live = new Map<string, AgentSession>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

async function build(
  paths: ProjectPaths,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  const model = defaultModel(modelRegistry);
  const { session } = await createAgentSession({
    cwd: paths.sandbox,
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    tools: [...BUILTIN_TOOLS, "spawn_subagent"],
    customTools: [
      makeSpawnSubagentTool({ cwd: paths.sandbox, authStorage, modelRegistry, model }),
    ],
  });
  return session;
}

/** Create a brand-new persistent session for the active project. */
export async function createSession(
  projectId: string,
  paths: ProjectPaths,
): Promise<AgentSession> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const sm = SessionManager.create(paths.sandbox, paths.sessionsDir);
  const session = await build(paths, sm);
  live.set(keyFor(projectId, session.sessionId), session);
  return session;
}

/** Return a live session, cold-opening its JSONL file from disk if needed. */
export async function getSession(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
): Promise<AgentSession | null> {
  const k = keyFor(projectId, sessionId);
  const existing = live.get(k);
  if (existing) return existing;

  const infos = await SessionManager.list(paths.sandbox, paths.sessionsDir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) return null;
  const sm = SessionManager.open(info.path, paths.sessionsDir, paths.sandbox);
  const session = await build(paths, sm);
  live.set(k, session);
  return session;
}

export async function listSessions(paths: ProjectPaths): Promise<SessionInfo[]> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  return SessionManager.list(paths.sandbox, paths.sessionsDir);
}

export function disposeSession(projectId: string, sessionId: string): void {
  const k = keyFor(projectId, sessionId);
  const s = live.get(k);
  if (s) {
    s.dispose();
    live.delete(k);
  }
}
