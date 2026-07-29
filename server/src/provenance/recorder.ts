/**
 * Observational provenance recorder.
 *
 * Subscribes to the same Pi event stream the SSE mapper reads (see the
 * `session.subscribe` call in api/sessions.ts) and turns each tool call into a
 * durable step row binding that call to the sandbox files it actually read and
 * wrote. Nothing here trusts the model's account of its own work.
 *
 * Attribution per tool class:
 *
 *   write/edit      the tool names its path and we hash the bytes afterward
 *                   -> `observed`
 *   bash, subagent  only a before/after scan can see what a script wrote
 *                   -> `observed`, downgraded to `inferred` when the drain fell
 *                      behind (see LAG below)
 *   read            the tool names its path -> `observed` input edge
 *   everything else recorded as a step with no file edges
 *
 * LAG: the drain is async so a stat walk never blocks the event handler — a
 * blocked handler stalls SSE for every tab in the project. The queue is FIFO and
 * serialized, so scans stay ordered, but if two tool calls finish before the
 * first one's scan runs, that scan sees both sets of changes. We detect exactly
 * that condition (work still queued behind us) and mark the edges `inferred`
 * rather than reporting a file against the wrong step as fact.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { relativizeSandboxPaths } from "../agent/events.ts";
import { isUserVisible, isWithin } from "../sandbox-fs.ts";
import {
  diffSnapshots,
  scanSandbox,
  type Snapshot,
} from "./scanner.ts";
import {
  appendStep,
  identify,
  PROVENANCE_SCHEMA_VERSION,
  type ArtifactChange,
  type ArtifactRef,
  type DegradeReason,
  type EdgeConfidence,
  type FileIdentity,
  type ProvenanceStep,
} from "./store.ts";

/** Tools that cannot change the sandbox. Everything absent from this set is
 *  treated as potentially mutating and gets a scan — an unknown MCP tool is far
 *  likelier to write a file than to be worth skipping. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
  "interview",
  "notebook",
  "scientific_result",
  "list_pdf_annotations",
  "modal_status",
  "modal_instances",
]);

/** Tools whose args name the single file they write. */
const DECLARED_WRITE_TOOLS = new Set(["write", "edit", "multiedit", "str_replace"]);

/** Args keys that carry a target path across Pi built-ins and MCP tools. */
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

const MAX_HASH_CACHE = 2_000;

function declaredPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export interface ProvenanceRecorderOptions {
  projectId: string;
  sessionId: string;
  sandboxRoot: string;
  runId?: string;
  /** Read at step time so a mid-run model switch is attributed correctly. */
  getModel: () => string | undefined;
  /** Non-fatal recorder failures. Provenance must never break a run. */
  onError?: (err: unknown) => void;
}

export class ProvenanceRecorder {
  private readonly opts: ProvenanceRecorderOptions;
  private readonly starts = new Map<string, { startedAt: number; args: unknown }>();
  private readonly hashCache = new Map<string, FileIdentity>();
  private queue: Array<() => Promise<void>> = [];
  private drainPromise: Promise<void> | null = null;
  private snapshot: Snapshot = new Map();
  private snapshotDegraded?: DegradeReason;
  private readonly baselineReady: Promise<void>;

  constructor(opts: ProvenanceRecorderOptions) {
    this.opts = opts;
    // Kick the baseline walk off immediately, before session.prompt(). It races
    // the first model round-trip, which it virtually always wins; the drain
    // awaits it regardless, so ordering is correct either way. A bash call that
    // completes before this resolves can have its writes folded into the
    // baseline and go unreported — documented in docs/provenance.md.
    this.baselineReady = this.refreshSnapshot();
  }

  private async refreshSnapshot(): Promise<void> {
    const result = await scanSandbox(this.opts.sandboxRoot);
    this.snapshot = result.snapshot;
    this.snapshotDegraded = result.degraded;
  }

  /** Sync, cheap, and never throws: safe to call straight from Pi's event handler. */
  observe(ev: AgentSessionEvent): void {
    try {
      if (ev.type === "tool_execution_start") {
        this.starts.set(ev.toolCallId, {
          startedAt: Date.now(),
          args: relativizeSandboxPaths(ev.args, this.opts.sandboxRoot),
        });
        return;
      }
      if (ev.type !== "tool_execution_end") return;
      const start = this.starts.get(ev.toolCallId);
      this.starts.delete(ev.toolCallId);
      const toolName = ev.toolName;
      const isError = ev.isError === true;
      const endedAt = Date.now();
      this.schedule(() =>
        this.record({
          toolCallId: ev.toolCallId,
          toolName,
          isError,
          args: start?.args,
          startedAt: start?.startedAt,
          timestamp: endedAt,
        }),
      );
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private schedule(job: () => Promise<void>): void {
    this.queue.push(job);
    if (!this.drainPromise) this.drainPromise = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await job();
        } catch (err) {
          this.opts.onError?.(err);
        }
      }
    } finally {
      this.drainPromise = null;
    }
  }

  /** Await the baseline walk and every queued step. Call once the run is
   *  finished so the JSONL is complete before the terminal frames go out. */
  async flush(): Promise<void> {
    await this.baselineReady;
    while (this.drainPromise) {
      await this.drainPromise;
      // A job scheduled while we awaited starts a fresh drain; keep going.
    }
  }

  /** Resolve a tool-declared relative path to an in-sandbox, user-visible file. */
  private resolveDeclared(rel: string): { abs: string; rel: string } | null {
    if (path.isAbsolute(rel)) return null; // relativization left it outside the sandbox
    const abs = path.resolve(this.opts.sandboxRoot, rel);
    if (!isWithin(this.opts.sandboxRoot, abs)) return null;
    if (!isUserVisible(abs, this.opts.sandboxRoot)) return null;
    return { abs, rel };
  }

  /** identify() with a size+mtime-keyed cache, so re-reading one large input
   *  across many steps does not re-hash it every time.
   *
   *  Validity is checked against a fresh stat, not against `this.snapshot`: the
   *  snapshot only advances on scans and declared writes, so a file changed by
   *  anything else (the sandbox file API, an external editor) would otherwise
   *  keep returning its stale hash. One extra stat is nothing next to a hash. */
  private identifyCached(abs: string, rel: string): FileIdentity | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const cached = this.hashCache.get(rel);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const identity = identify(abs);
    if (identity) {
      if (this.hashCache.size >= MAX_HASH_CACHE) {
        const oldest = this.hashCache.keys().next().value;
        if (oldest !== undefined) this.hashCache.delete(oldest);
      }
      this.hashCache.set(rel, identity);
    }
    return identity;
  }

  /** Build an edge for a file that still exists. Deletions cannot go through
   *  here — there is nothing left to stat — so callers construct those from the
   *  pre-scan snapshot, which still holds the file's last known size/mtime. */
  private refFor(
    rel: string,
    change: Exclude<ArtifactChange, "deleted">,
    confidence: EdgeConfidence,
  ): ArtifactRef | null {
    const resolved = this.resolveDeclared(rel);
    if (!resolved) return null;
    const identity = this.identifyCached(resolved.abs, rel);
    if (!identity) return null;
    return {
      path: rel,
      ...(identity.sha256 ? { sha256: identity.sha256 } : {}),
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      change,
      confidence,
      ...(identity.hashSkipped ? { hashSkipped: identity.hashSkipped } : {}),
    };
  }

  private async record(step: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
    args: unknown;
    startedAt?: number;
    timestamp: number;
  }): Promise<void> {
    await this.baselineReady;

    const inputs: ArtifactRef[] = [];
    const outputs: ArtifactRef[] = [];
    let degraded = this.snapshotDegraded;

    if (step.toolName === "read") {
      const declared = declaredPath(step.args);
      const ref = declared ? this.refFor(declared, "read", "observed") : null;
      if (ref) inputs.push(ref);
    } else if (DECLARED_WRITE_TOOLS.has(step.toolName) && !step.isError) {
      const declared = declaredPath(step.args);
      if (declared) {
        const existedBefore = this.snapshot.has(declared);
        const ref = this.refFor(declared, existedBefore ? "modified" : "created", "observed");
        if (ref) {
          outputs.push(ref);
          // Fold the write into the baseline so the next scan does not
          // re-attribute it to whichever tool happens to run afterward.
          this.snapshot.set(ref.path, { size: ref.size, mtimeMs: ref.mtimeMs });
        }
      }
    } else if (!READ_ONLY_TOOLS.has(step.toolName)) {
      // Opaque tool: the sandbox itself is the only witness.
      const before = this.snapshot;
      const scan = await scanSandbox(this.opts.sandboxRoot);
      // Measured AFTER the scan, not before: the drain is the only consumer, so
      // the queue can only have grown while we walked. Anything sitting in it
      // is a step that finished before we looked, meaning this diff may contain
      // its writes as well as ours.
      const lagged = this.queue.length > 0;
      if (scan.degraded) {
        degraded = scan.degraded;
        // An incomplete walk would report every unvisited file as deleted.
        this.snapshotDegraded = scan.degraded;
      } else {
        this.snapshotDegraded = undefined;
        const diff = diffSnapshots(before, scan.snapshot);
        this.snapshot = scan.snapshot;
        const confidence: EdgeConfidence = lagged ? "inferred" : "observed";
        for (const rel of diff.created) {
          const ref = this.refFor(rel, "created", confidence);
          if (ref) outputs.push(ref);
        }
        for (const rel of diff.modified) {
          const ref = this.refFor(rel, "modified", confidence);
          if (ref) outputs.push(ref);
        }
        for (const rel of diff.deleted) {
          // Build the deleted ref against `before`, which still has its stats.
          const previous = before.get(rel);
          const resolved = this.resolveDeclared(rel);
          if (!resolved) continue;
          outputs.push({
            path: rel,
            size: previous?.size ?? 0,
            mtimeMs: previous?.mtimeMs ?? 0,
            change: "deleted",
            confidence,
          });
        }
      }
    }

    const row: ProvenanceStep = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      id: step.toolCallId,
      sessionId: this.opts.sessionId,
      ...(this.opts.runId ? { runId: this.opts.runId } : {}),
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      timestamp: step.timestamp,
      toolName: step.toolName,
      ...(step.args !== undefined ? { args: step.args } : {}),
      ...(step.isError ? { isError: true } : {}),
      ...(this.opts.getModel() ? { model: this.opts.getModel() } : {}),
      role: "agent",
      inputs,
      outputs,
      ...(degraded ? { degraded } : {}),
    };
    appendStep(row, this.opts.projectId);
  }
}
