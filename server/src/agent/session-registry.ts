/**
 * Live AgentSession registry.
 *
 * Each chat tab maps to one Pi AgentSession persisted as a JSONL file under the
 * project's `sandbox/.pi/sessions/`. We hold the live session objects in a Map
 * (keyed by projectId:sessionId) so streaming runs reuse warm state, and
 * cold-open from disk after a restart. ModelRuntime + ModelRegistry are process
 * singletons sharing Kady's OpenRouter runtime key and Pi OAuth store.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import { getMcpTools } from "./mcp.ts";
import { defaultModel, setupModelRuntime } from "./models.ts";
import { seedAgentFiles } from "./agent-files.ts";
import { makeInterviewTool } from "./interview.ts";
import { makeNotebookTool } from "./notebook.ts";
import { notebookSearchTool } from "../../pi-packages/kady-notebook/memory-tool.ts";
import { executeMemoryRecall } from "./notebook-memory.ts";
import { makeScientificResultTool } from "./scientific-result.ts";
import { clearSessionCompute, makeModalTools, MODAL_TOOL_NAMES } from "./modal-tool.ts";
import {
  makeSubagentLedgerExtension,
  makeSubagentRefusalExtension,
  subagentsExtensionPath,
} from "./subagent-bridge.ts";
import { makeFusionRequestExtension } from "./fusion-bridge.ts";
import { WEB_ACCESS_TOOLS, ensureWebAccess } from "./web-access-bridge.ts";
import {
  seedNotebookPackage,
  seedBuiltinAgentNotebookTools,
  makeSubagentNotebookExtension,
} from "./notebook-bridge.ts";
import { makeSubagentProvenanceExtension } from "../provenance/bridge.ts";
import {
  makeSubagentModalExtension,
  seedBuiltinAgentModalTools,
  seedModalPackage,
} from "./modal-bridge.ts";
import {
  makePdfAnnotationTools,
  PDF_ANNOTATION_TOOL_NAMES,
} from "./pdf-annotation-tool.ts";
import {
  seedBuiltinAgentPdfAnnotationTools,
  seedPdfAnnotationPackage,
} from "./pdf-annotation-bridge.ts";
import { BUILTIN_TOOLS } from "./tools.ts";
import { seedSubagentRuntimeSettings } from "./subagent-runtime-settings.ts";

// Entry points normally establish this in env.ts. Keep the registry safe when
// imported directly (tests/scripts) so child Pi processes still share the same
// Kady-scoped auth store as the in-process runtime.
process.env.PI_CODING_AGENT_DIR ??= KADY_PI_AGENT_DIR;

// pi-subagents ≥0.65 runs children as native Pi sessions (background ones in a
// detached runner it imports from our pi-coding-agent dependency), so no `pi`
// binary is spawned for delegation any more. The `pi` bin is still put on PATH
// for the few places that shell out to it (Herdr panes, the profile model
// probe) so they resolve even when the server wasn't started via npm.
const localBin = path.resolve(import.meta.dirname, "..", "..", "node_modules", ".bin");
if (!(process.env.PATH ?? "").split(path.delimiter).includes(localBin)) {
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

const modelRuntime = await ModelRuntime.create({
  allowModelNetwork: false,
  authPath: path.join(KADY_PI_AGENT_DIR, "auth.json"),
});
await setupModelRuntime(modelRuntime);
const modelRegistry = new ModelRegistry(modelRuntime);

export function getModelRuntime(): ModelRuntime {
  return modelRuntime;
}
export function getModelRegistry(): ModelRegistry {
  return modelRegistry;
}

/** Max live (in-memory) sessions kept per project; oldest idle ones are evicted. */
const MAX_LIVE_PER_PROJECT = 10;

/**
 * Hook for the session observer (agent/session-observer.ts). Registered from
 * index.ts rather than imported here: the observer needs the run pipeline,
 * which imports this module for pin/unpin, and this module has top-level
 * awaits — keep the cycle out.
 */
export type SessionObserverFactory = (ctx: {
  projectId: string;
  paths: ProjectPaths;
  session: AgentSession;
}) => () => void;
let observerFactory: SessionObserverFactory | null = null;
export function setSessionObserver(factory: SessionObserverFactory | null): void {
  observerFactory = factory;
}
/** Detach functions of attached observers, keyed like `live`. */
const observers = new Map<string, () => void>();

// Insertion-ordered Map doubles as an LRU: we delete+re-set an entry on access
// so the first matching key for a project is always the least-recently-used.
const live = new Map<string, AgentSession>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

// Sessions with a claimed run. A run holds its claim across async model setup
// before `isStreaming` ever flips, so eviction cannot rely on isStreaming
// alone — a tab opened during that window could dispose the session that is
// about to stream.
const pinned = new Set<string>();

/** Protect a session from eviction for the lifetime of a claimed run. */
export function pinSession(projectId: string, sessionId: string): void {
  pinned.add(keyFor(projectId, sessionId));
}

export function unpinSession(projectId: string, sessionId: string): void {
  pinned.delete(keyFor(projectId, sessionId));
}

/** Dispose the least-recently-used idle sessions for a project over the cap. */
function evictOverCap(projectId: string): void {
  const prefix = `${projectId}:`;
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix));
  let remaining = keys.length;
  for (const k of keys) {
    if (remaining <= MAX_LIVE_PER_PROJECT) break;
    const s = live.get(k);
    if (!s || s.isStreaming || pinned.has(k)) continue; // in-flight or claimed
    release(projectId, k, s);
    remaining--;
  }
}

/** Dispose one live session and drop everything keyed off it. */
function release(projectId: string, key: string, session: AgentSession): void {
  // Detach before dispose so an in-flight system run can finalize its handle
  // while the session is still queryable.
  const detach = observers.get(key);
  if (detach) {
    observers.delete(key);
    try {
      detach();
    } catch {
      /* an observer failure must not block disposal */
    }
  }
  session.dispose();
  live.delete(key);
  pinned.delete(key);
  clearSessionCompute(projectId, key.slice(projectId.length + 1));
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
  // sandbox so both this session and pi-subagents' background children (native
  // sessions in a detached runner that loads the sandbox's ambient packages)
  // get the web tools (web-access-bridge.ts explains why children need this).
  ensureWebAccess(paths);
  // Reference the kady-notebook package so child sessions get the notebook
  // tool (sandbox trust is already handled by ensureWebAccess above).
  seedNotebookPackage(paths);
  // Builtin pi-subagents specialists pin a tools allowlist that would filter
  // the notebook tool out of their child processes — extend it via overrides.
  seedBuiltinAgentNotebookTools(paths);
  // Child-only localhost bridge for the same durable project-scoped Modal
  // jobs. Builtin allowlists are extended only when they retain our generated
  // shape; user-pinned lists remain authoritative.
  seedModalPackage(paths);
  seedBuiltinAgentModalTools(paths);
  // PDF annotation tools are in-process for the lead and package-backed for
  // child agents so both can create expert markup visible in the viewer.
  seedPdfAnnotationPackage(paths);
  seedBuiltinAgentPdfAnnotationTools(paths);
  // Every child tool above arrives as an ambient package, which pi-subagents
  // ≥0.65 loads only into *background* children — so force background
  // launches; and keep the external-CLI builtins (Claude Code/Codex/Cursor)
  // off until a user turns one on in Settings → Specialists.
  seedSubagentRuntimeSettings(paths);
  // The ledger extension is created before the session exists, so it reads
  // the live sessionId through this holder (set right after creation).
  const holder: { session?: AgentSession } = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.sandbox,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [subagentsExtensionPath()],
    extensionFactories: [
      makeSubagentLedgerExtension(
        projectId,
        () => holder.session?.sessionId ?? "",
        () => holder.session?.model,
        (providerId) => modelRuntime.isUsingOAuth(providerId),
      ),
      // Rewrites the outgoing provider body to an OpenRouter Fusion request when
      // the /run handler stashed a Fusion config for this session (setFusionConfig).
      makeFusionRequestExtension(projectId, () => holder.session?.sessionId ?? ""),
      // Harvest notebook entries the roster's subagents logged (child pi
      // processes get the notebook tool via seedNotebookPackage above) into
      // the parent notebook — the parent is the single writer.
      makeSubagentNotebookExtension(projectId, () => holder.session?.sessionId ?? ""),
      // Reconstruct provenance for the child's tool calls from its session file
      // and append it to the parent's log. Needs no tool inside the child — the
      // session file is the record, which is what makes it unauthorable.
      makeSubagentProvenanceExtension(projectId, () => holder.session?.sessionId ?? ""),
      // A child refused by the provider dies in its own process; the parent
      // only sees the runner's "Provider finish_reason" text. Attach what to
      // do about it so the lead reports something actionable.
      makeSubagentRefusalExtension(projectId, () => holder.session?.model),
      // Child Modal jobs are submitted through the localhost bridge under the
      // child run id; reattribute them to this parent session on completion.
      makeSubagentModalExtension(projectId, () => holder.session?.sessionId ?? ""),
    ],
  });
  await resourceLoader.reload();
  // The interview tool blocks mid-run on answers posted to the HTTP API; it
  // reads the live sessionId through the same holder as the ledger extension.
  const interviewTool = makeInterviewTool(projectId, () => holder.session?.sessionId ?? "");
  // Non-blocking lab-notebook tool: logs the agent's own narrative entries.
  const notebookTool = makeNotebookTool(projectId, () => holder.session?.sessionId ?? "");
  // Typed presentation layer for compact scientific results and artifact links.
  const scientificResultTool = makeScientificResultTool(projectId);
  const pdfAnnotationTools = makePdfAnnotationTools(projectId);
  // Durable remote-compute tools are always present. Missing credentials are
  // reported at submission time, so warm sessions become compatible
  // immediately after credentials are configured live.
  const modalTools = makeModalTools(projectId, () => holder.session?.sessionId ?? "");
  const { session } = await createAgentSession({
    cwd: paths.sandbox,
    model: fallbackModel,
    modelRuntime,
    sessionManager,
    resourceLoader,
    tools: [
      ...BUILTIN_TOOLS,
      "subagent",
      // pi-subagents registers the wait tool alongside `subagent` and enables it
      // by default. Since 0.47 a workflowScript launch is async by default and
      // returns a receipt, so without it in this allowlist Pi filters out the
      // lead's only way to block on the children it just started. 0.61 renamed
      // it `subagent_wait` → `bg_wait`; the old name is harmless here (unknown
      // names are ignored) and covers a deliberate pin rollback.
      "bg_wait",
      "subagent_wait",
      "interview",
      "notebook",
      "notebook_search",
      "scientific_result",
      ...PDF_ANNOTATION_TOOL_NAMES,
      ...WEB_ACCESS_TOOLS,
      ...MODAL_TOOL_NAMES,
      ...mcpTools.map((t) => t.name),
    ],
    customTools: [
      interviewTool,
      notebookTool,
      notebookSearchTool((params) => executeMemoryRecall(projectId, params)),
      scientificResultTool,
      ...pdfAnnotationTools,
      ...modalTools,
      ...mcpTools,
    ],
  });
  holder.session = session;
  if (observerFactory) {
    observers.set(keyFor(projectId, session.sessionId), observerFactory({ projectId, paths, session }));
  }
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
  if (s) release(projectId, k, s);
}

/** Stop every live session before its project directory is removed. */
export async function abortProjectSessions(projectId: string): Promise<void> {
  const prefix = `${projectId}:`;
  const sessions = [...live.entries()].filter(([key]) => key.startsWith(prefix));
  await Promise.all(
    sessions.map(async ([, session]) => {
      session.clearQueue();
      await session.abort();
    }),
  );
}

/** Release every live session after its project runs have finalized. */
export function disposeProjectSessions(projectId: string): void {
  const prefix = `${projectId}:`;
  const sessions = [...live.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, session] of sessions) {
    release(projectId, key, session);
  }
}
