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
import { recordSubagentRun } from "../cost/ledger.ts";
import { getMcpTools } from "./mcp.ts";
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

/** Max live (in-memory) sessions kept per project; oldest idle ones are evicted. */
const MAX_LIVE_PER_PROJECT = 10;

// Insertion-ordered Map doubles as an LRU: we delete+re-set an entry on access
// so the first matching key for a project is always the least-recently-used.
const live = new Map<string, AgentSession>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

/** Dispose the least-recently-used idle sessions for a project over the cap. */
function evictOverCap(projectId: string): void {
  const prefix = `${projectId}:`;
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix));
  let remaining = keys.length;
  for (const k of keys) {
    if (remaining <= MAX_LIVE_PER_PROJECT) break;
    const s = live.get(k);
    if (s && s.isStreaming) continue; // never evict an in-flight session
    s?.dispose();
    live.delete(k);
    remaining--;
  }
}

async function build(
  projectId: string,
  paths: ProjectPaths,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  const fallbackModel = defaultModel(modelRegistry);
  const mcpTools = await getMcpTools(projectId, paths);
  // The spawn_subagent tool is created before the session exists, so it reads
  // the live model + sessionId through this holder (set right after creation).
  const holder: { session?: AgentSession } = {};
  const { session } = await createAgentSession({
    cwd: paths.sandbox,
    model: fallbackModel,
    authStorage,
    modelRegistry,
    sessionManager,
    tools: [...BUILTIN_TOOLS, "spawn_subagent", ...mcpTools.map((t) => t.name)],
    customTools: [
      makeSpawnSubagentTool({
        projectId,
        cwd: paths.sandbox,
        authStorage,
        modelRegistry,
        getModel: () => holder.session?.model ?? fallbackModel,
        onStats: (stats, modelId) =>
          recordSubagentRun(projectId, holder.session?.sessionId ?? "", modelId, stats),
        mcpTools,
      }),
      ...mcpTools,
    ],
  });
  holder.session = session;
  return session;
}

/** Create a brand-new persistent session for the active project. */
export async function createSession(
  projectId: string,
  paths: ProjectPaths,
): Promise<AgentSession> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const sm = SessionManager.create(paths.sandbox, paths.sessionsDir);
  const session = await build(projectId, paths, sm);
  live.set(keyFor(projectId, session.sessionId), session);
  evictOverCap(projectId);
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
  if (existing) {
    live.delete(k); // re-insert to mark most-recently-used
    live.set(k, existing);
    return existing;
  }

  const infos = await SessionManager.list(paths.sandbox, paths.sessionsDir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) return null;
  const sm = SessionManager.open(info.path, paths.sessionsDir, paths.sandbox);
  const session = await build(projectId, paths, sm);
  live.set(k, session);
  evictOverCap(projectId);
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
