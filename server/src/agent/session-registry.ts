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
import type { Api, Model } from "@earendil-works/pi-ai";
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
import { makeScientificCompactionExtension } from "./compaction-bridge.ts";
import { makeDataGuardExtension } from "./data-guard.ts";
import { readSchedulerState } from "./scheduler-state.ts";
import { seedGuardPackage } from "./guard-bridge.ts";
import { seedPromptTemplates } from "./prompts.ts";
import { seedWatchdogGuidance } from "./watchdog-settings.ts";
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

// Kady-owned resident sessions (the per-project scheduler host). Pinned for
// good and not counted against MAX_LIVE_PER_PROJECT, so they never cost a
// user a tab slot and are never evicted.
const systemSessions = new Set<string>();
export function markSystemSession(projectId: string, sessionId: string): void {
  const key = keyFor(projectId, sessionId);
  systemSessions.add(key);
  pinned.add(key);
}
export function isSystemSession(projectId: string, sessionId: string): boolean {
  return systemSessions.has(keyFor(projectId, sessionId));
}

export function unpinSession(projectId: string, sessionId: string): void {
  pinned.delete(keyFor(projectId, sessionId));
}

/** Dispose the least-recently-used idle sessions for a project over the cap. */
function evictOverCap(projectId: string): void {
  const prefix = `${projectId}:`;
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix) && !systemSessions.has(k));
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
  // Pi's dispose() does not tell extensions the session is going away;
  // pi-subagents releases its supervisor-channel watchers and pollers on
  // `session_shutdown`, so emit it the way Pi's own quit path does.
  void session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {
    /* best effort: a failing shutdown handler must not block disposal */
  });
  session.dispose();
  live.delete(key);
  pinned.delete(key);
  systemSessions.delete(key);
  clearSessionCompute(projectId, key.slice(projectId.length + 1));
}

export interface OpenSessionOptions {
  /**
   * Which model a cold-opened or brand-new session starts on. `"session"`
   * (default) restores the session's own last model; `"project"` uses the
   * model most recently used by any *chat* session of the project, which is
   * what the resident automation session wants: its own history is only
   * notices, and the default model is the most expensive one in the picker.
   */
  modelPolicy?: "session" | "project";
}

/** Last `{provider, modelId}` a session JSONL recorded (model change or assistant reply). */
export function lastModelInSessionFile(file: string): { provider: string; modelId: string } | undefined {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
    const message = entry.message as Record<string, unknown> | undefined;
    if (
      entry.type === "message" &&
      message?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { provider: message.provider, modelId: message.model };
    }
  }
  return undefined;
}

/**
 * The model most recently used by a chat session of this project (system
 * sessions excluded), when the runtime still knows it and has credentials.
 */
async function latestProjectModel(
  paths: ProjectPaths,
  runtime: ModelRuntime,
  exclude: ReadonlySet<string>,
): Promise<Model<Api> | undefined> {
  let infos: SessionInfo[];
  try {
    infos = await SessionManager.list(paths.sandbox, paths.sessionsDir);
  } catch {
    return undefined;
  }
  const schedulerSessionId = readSchedulerState(paths).sessionId;
  const candidates = infos
    .filter((info) => !exclude.has(info.id) && info.id !== schedulerSessionId && info.messageCount > 0)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const info of candidates) {
    const last = lastModelInSessionFile(info.path);
    if (!last) continue;
    const model = runtime.getModel(last.provider, last.modelId);
    if (model && runtime.hasConfiguredAuth(model.provider)) return model;
  }
  return undefined;
}

/**
 * The model a persisted session last ran with, when Pi's registry still knows
 * it and its provider has credentials. Mirrors the restore Pi's SDK performs
 * when no explicit `model` is passed.
 */
function restoredSessionModel(sessionManager: SessionManager, runtime: ModelRuntime): Model<Api> | undefined {
  const context = sessionManager.buildSessionContext();
  if (context.messages.length === 0 || !context.model) return undefined;
  const model = runtime.getModel(context.model.provider, context.model.modelId);
  if (!model || !runtime.hasConfiguredAuth(model.provider)) return undefined;
  return model;
}

async function build(
  projectId: string,
  paths: ProjectPaths,
  sessionManager: SessionManager,
  options: OpenSessionOptions = {},
): Promise<AgentSession> {
  const fallbackModel = defaultModel(modelRegistry);
  const ownId = sessionManager.getSessionId();
  const initialModel =
    (options.modelPolicy === "project" ? undefined : restoredSessionModel(sessionManager, modelRuntime)) ??
    (await latestProjectModel(paths, modelRuntime, new Set(ownId ? [ownId] : []))) ??
    fallbackModel;
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
  // Raw-data guard for background specialists (the lead runs data-guard.ts).
  seedGuardPackage(paths);
  // Scientific prompt templates (`/qc <file>` …) live in sandbox/.pi/prompts.
  seedPromptTemplates(paths);
  // Standing instructions for the (opt-in) pi-subagents watchdog reviewer.
  seedWatchdogGuidance(paths);
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
      // Science-aware context compaction: a deterministic state preamble (plan,
      // notebook, results, environment) plus a summary generated under
      // science-focused instructions; falls back to Pi's default on error.
      makeScientificCompactionExtension(projectId, () => holder.session?.sessionId ?? ""),
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
      // Raw-data guard: blocks mutations of protected paths and asks the user
      // before destructive shell commands. Registered after the subagent
      // bridge so budget gates run first.
      makeDataGuardExtension(projectId, () => holder.session?.sessionId ?? "", paths.sandbox),
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
    // A cold-opened session starts on the model it last ran with (or the
    // project's latest chat model), not the global default: user runs set the
    // model per request anyway, but extension-initiated system runs
    // (supervisor replies, scheduled-run notices) use whatever the session
    // holds, and the default is the most expensive model in the picker.
    model: initialModel,
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
      // pi-subagents' parent side of the supervisor channel: reply to a
      // background specialist that called `contact_supervisor` (the request
      // arrives as a custom message and starts a system run; see AGENTS.md).
      "subagent_supervisor",
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
  // Pi emits `session_start` only from bindExtensions(); without it the
  // extensions never see a live session: pi-subagents never starts its
  // supervisor channel (so the `subagent_supervisor` tool in the allowlist
  // above is never registered), never resets per-session state, and skips
  // `resources_discover`. Headless mode mirrors `pi -p`.
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      console.warn(`[session-registry] extension error in ${session.sessionId}:`, error);
    },
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
  options: OpenSessionOptions = {},
): Promise<AgentSession> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const sm = SessionManager.create(paths.sandbox, paths.sessionsDir);
  const session = await build(projectId, paths, sm, options);
  live.set(keyFor(projectId, session.sessionId), session);
  evictOverCap(projectId);
  return session;
}

/** Return a live session, cold-opening its JSONL file from disk if needed. */
export async function getSession(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
  options: OpenSessionOptions = {},
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
  const session = await build(projectId, paths, sm, options);
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
