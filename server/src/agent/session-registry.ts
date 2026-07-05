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
import path from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { modalConfigured } from "../config.ts";
import { getMcpTools } from "./mcp.ts";
import { defaultModel, setupAuth } from "./models.ts";
import { seedAgentFiles } from "./agent-files.ts";
import { makeInterviewTool } from "./interview.ts";
import { makeNotebookTool } from "./notebook.ts";
import { makeModalTool } from "./modal-tool.ts";
import { makeSubagentLedgerExtension, subagentsExtensionPath } from "./subagent-bridge.ts";
import { makeFusionRequestExtension } from "./fusion-bridge.ts";
import { WEB_ACCESS_TOOLS, ensureWebAccess } from "./web-access-bridge.ts";
import { BUILTIN_TOOLS } from "./tools.ts";

// pi-subagents runs each delegation as a child `pi` CLI process. The binary
// ships with our pi-coding-agent dependency; make sure spawn("pi") resolves
// even when the server wasn't started through an npm script.
const localBin = path.resolve(import.meta.dirname, "..", "..", "node_modules", ".bin");
if (!(process.env.PATH ?? "").split(path.delimiter).includes(localBin)) {
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

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
  // Make the scientific agent roster visible to pi-subagents' project-agent
  // discovery (sandbox/.pi/agents/) before the session starts.
  seedAgentFiles(paths);
  // Reference pi-web-access from sandbox/.pi/settings.json and pre-trust the
  // sandbox so both this session and pi-subagents' child `pi` processes load
  // the web tools (web-access-bridge.ts explains why children need this).
  ensureWebAccess(paths);
  // The ledger extension is created before the session exists, so it reads
  // the live sessionId through this holder (set right after creation).
  const holder: { session?: AgentSession } = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.sandbox,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [subagentsExtensionPath()],
    extensionFactories: [
      makeSubagentLedgerExtension(projectId, () => holder.session?.sessionId ?? ""),
      // Rewrites the outgoing provider body to an OpenRouter Fusion request when
      // the /run handler stashed a Fusion config for this session (setFusionConfig).
      makeFusionRequestExtension(() => holder.session?.sessionId ?? ""),
    ],
  });
  await resourceLoader.reload();
  // The interview tool blocks mid-run on answers posted to the HTTP API; it
  // reads the live sessionId through the same holder as the ledger extension.
  const interviewTool = makeInterviewTool(projectId, () => holder.session?.sessionId ?? "");
  // Non-blocking lab-notebook tool: logs the agent's own narrative entries.
  const notebookTool = makeNotebookTool(projectId, () => holder.session?.sessionId ?? "");
  // Remote-compute tool, only when Modal BYOK creds are present. Built per
  // session (same holder-based late-bound sessionId as the interview tool); a
  // session created before keys are set picks it up on its next cold-open.
  const modalTool = modalConfigured()
    ? makeModalTool(projectId, () => holder.session?.sessionId ?? "")
    : null;
  const { session } = await createAgentSession({
    cwd: paths.sandbox,
    model: fallbackModel,
    authStorage,
    modelRegistry,
    sessionManager,
    resourceLoader,
    tools: [
      ...BUILTIN_TOOLS,
      "subagent",
      "interview",
      "notebook",
      ...WEB_ACCESS_TOOLS,
      ...(modalTool ? ["modal_run"] : []),
      ...mcpTools.map((t) => t.name),
    ],
    customTools: [interviewTool, notebookTool, ...(modalTool ? [modalTool] : []), ...mcpTools],
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
