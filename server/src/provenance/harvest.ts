/**
 * Reconstruct provenance for work a SUBAGENT did, from its session JSONL.
 *
 * A child `pi` process records every tool call it makes as an assistant
 * `toolCall` block, paired with a `toolResult` row carrying `isError`. The parent
 * learns each child's session file on completion — the same hook
 * notebook-harvest and usageFromSessionFile already use — so the calls can be
 * replayed into steps after the fact.
 *
 * WHAT AFTER-THE-FACT COSTS US. The lead agent's recorder sees the sandbox
 * before and after each call, so it can both attribute a file to a step and hash
 * what that step produced. Neither is available here:
 *
 *   - `write`/`edit` name their path, so the edge itself stands on the execution
 *     record (the tool ran, on that path, and did not error). But the bytes are
 *     hashed now, not then, so every harvested ref is marked
 *     `identityAt: "harvest"` and staleness refuses to call it "current".
 *     `change` is `"wrote"` rather than created/modified, which would be a guess.
 *   - `bash` is opaque and there is no snapshot to diff, so it gets no edges and
 *     is marked `degraded: "no-scan-baseline"` — the gap is recorded instead of
 *     being reported as "this step wrote nothing".
 *
 * To keep script-written outputs from vanishing entirely, `inferOutputs` offers
 * mtime-window attribution as an explicitly `inferred` edge. See its comment for
 * the filter and the false-positive it can still make.
 *
 * Pure + defensive: unreadable file, malformed row, or unknown shape is skipped.
 */
import { relativizeSandboxPaths } from "../agent/events.ts";
import { isUserVisible, isWithin } from "../sandbox-fs.ts";
import path from "node:path";
import { commandFromArgs } from "./environment.ts";
import { mentionedPaths } from "./mentions.ts";
import {
  identify,
  PROVENANCE_SCHEMA_VERSION,
  type ArtifactRef,
  type ProvenanceStep,
} from "./store.ts";

/** Mirrors the recorder's classification; kept separate because the child's
 *  tool set can differ from the lead's (no interview, no in-process notebook). */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  "notebook",
  "scientific_result",
  "list_pdf_annotations",
  "modal_status",
  "modal_instances",
]);

const DECLARED_WRITE_TOOLS = new Set(["write", "edit", "multiedit", "str_replace"]);

const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

function declaredPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

interface ParsedCall {
  callId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
}

/** Epoch ms from a row's ISO `timestamp`, or NaN. */
function rowTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return Number.NaN;
  return Date.parse(value);
}

export interface HarvestOptions {
  /** The PARENT session — harvested steps live in its log, like notebook entries. */
  parentSessionId: string;
  sandboxRoot: string;
  /** The child's model, from the completion payload. Often differs from the lead's. */
  model?: string;
  /** Stamped on harvested steps so run dividers still group them. */
  runId?: string;
}

export interface HarvestResult {
  steps: ProvenanceStep[];
  /** Span of the child's tool activity, for mtime-window attribution. */
  window: { start: number; end: number } | null;
}

/** Resolve a child-declared path to an in-sandbox, user-visible file. */
function resolveInSandbox(rel: string, sandboxRoot: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const abs = path.resolve(sandboxRoot, rel);
  if (!isWithin(sandboxRoot, abs)) return null;
  if (!isUserVisible(abs, sandboxRoot)) return null;
  return abs;
}

/** Identify a file as it stands NOW. Missing files still yield a ref: the write
 *  happened even if the artifact was later removed. */
function harvestRef(
  rel: string,
  sandboxRoot: string,
  change: ArtifactRef["change"],
  confidence: ArtifactRef["confidence"],
): ArtifactRef | null {
  const abs = resolveInSandbox(rel, sandboxRoot);
  if (!abs) return null;
  const identity = identify(abs);
  if (!identity) {
    return {
      path: rel,
      size: 0,
      mtimeMs: 0,
      change,
      confidence,
      identityAt: "harvest",
      hashSkipped: "unreadable",
    };
  }
  return {
    path: rel,
    ...(identity.sha256 ? { sha256: identity.sha256 } : {}),
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    change,
    confidence,
    identityAt: "harvest",
    ...(identity.hashSkipped ? { hashSkipped: identity.hashSkipped } : {}),
  };
}

export function provenanceStepsFromSessionFile(
  sessionFileContent: string,
  agentName: string,
  opts: HarvestOptions,
): HarvestResult {
  const calls: ParsedCall[] = [];
  const errored = new Set<string>();
  const endedAt = new Map<string, number>();

  for (const line of sessionFileContent.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      timestamp?: unknown;
      message?: {
        role?: string;
        content?: unknown;
        toolCallId?: unknown;
        isError?: unknown;
        timestamp?: unknown;
      };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.message;
    if (!msg) continue;

    if (msg.role === "toolResult") {
      const id = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
      if (!id) continue;
      if (msg.isError === true) errored.add(id);
      const end = rowTime(msg.timestamp ?? row.timestamp);
      if (!Number.isNaN(end)) endedAt.set(id, end);
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const started = rowTime(row.timestamp);
    for (const block of msg.content as unknown[]) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "toolCall"
      ) {
        continue;
      }
      const b = block as { id?: unknown; name?: unknown; arguments?: unknown };
      const callId = typeof b.id === "string" ? b.id : "";
      const toolName = typeof b.name === "string" ? b.name : "";
      if (!callId || !toolName) continue;
      calls.push({
        callId,
        toolName,
        args: b.arguments,
        startedAt: Number.isNaN(started) ? 0 : started,
      });
    }
  }

  const steps: ProvenanceStep[] = [];
  let windowStart = Number.POSITIVE_INFINITY;
  let windowEnd = 0;

  for (const call of calls) {
    const isError = errored.has(call.callId);
    const finished = endedAt.get(call.callId) ?? call.startedAt;
    // Relativize BEFORE reading the declared path, exactly as the recorder does.
    // Children routinely emit the absolute host path for a sandbox file, and
    // resolveInSandbox rejects absolute paths by design (post-relativization an
    // absolute path means it really is outside the sandbox) — so extracting from
    // the raw args silently dropped every child write edge.
    const args =
      call.args === undefined
        ? undefined
        : relativizeSandboxPaths(call.args, opts.sandboxRoot);
    if (call.startedAt > 0) windowStart = Math.min(windowStart, call.startedAt);
    if (finished > 0) windowEnd = Math.max(windowEnd, finished);

    const inputs: ArtifactRef[] = [];
    const outputs: ArtifactRef[] = [];
    let degraded: ProvenanceStep["degraded"];

    if (call.toolName === "read") {
      const declared = declaredPath(args);
      const ref = declared ? harvestRef(declared, opts.sandboxRoot, "read", "observed") : null;
      if (ref) inputs.push(ref);
    } else if (DECLARED_WRITE_TOOLS.has(call.toolName)) {
      // A failed write wrote nothing; recording it as an output would invent one.
      if (!isError) {
        const declared = declaredPath(args);
        const ref = declared
          ? harvestRef(declared, opts.sandboxRoot, "wrote", "observed")
          : null;
        if (ref) outputs.push(ref);
      }
    } else if (!READ_ONLY_TOOLS.has(call.toolName)) {
      degraded = "no-scan-baseline";
      // No before-snapshot, but the command line is still a witness: a file it
      // names that exists now and predates the call is a probable input. The
      // mtime guard is what stops the call's own outputs from being read as
      // inputs; `inferred` because the file may have been rewritten since.
      const command = commandFromArgs(args);
      if (command) {
        const existedBefore = (rel: string): boolean => {
          const abs = resolveInSandbox(rel, opts.sandboxRoot);
          if (!abs) return false;
          const identity = identify(abs);
          return identity !== null && (call.startedAt === 0 || identity.mtimeMs < call.startedAt);
        };
        for (const rel of mentionedPaths(command, existedBefore)) {
          const ref = harvestRef(rel, opts.sandboxRoot, "read", "inferred");
          if (ref) inputs.push(ref);
        }
      }
    }

    steps.push({
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      id: `${agentName}:${call.callId}`,
      sessionId: opts.parentSessionId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(call.startedAt > 0 ? { startedAt: call.startedAt } : {}),
      timestamp: finished,
      toolName: call.toolName,
      ...(args !== undefined ? { args } : {}),
      ...(isError ? { isError: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      role: "subagent",
      agentName,
      inputs,
      outputs,
      ...(degraded ? { degraded } : {}),
    });
  }

  return {
    steps,
    window:
      windowStart === Number.POSITIVE_INFINITY || windowEnd === 0
        ? null
        : { start: windowStart, end: windowEnd },
  };
}

/**
 * Attribute unclaimed, in-window sandbox files to a harvested child step.
 *
 * Without this a subagent that runs a script leaves no trace of its outputs at
 * all — and "no recorded provenance" on a figure the agent really did produce
 * reads as a verified absence, which is worse than an honest guess. So: any
 * user-visible file whose mtime falls inside the child's activity window and
 * which NO recorded step already claims is attached to the child's last opaque
 * call, as `inferred`.
 *
 * `claimedPaths` is what keeps this from double-attributing. For a synchronous
 * subagent the lead executes no tools while it runs, so an unclaimed in-window
 * file is almost certainly the child's. For an async child the lead runs
 * concurrently, but its own scan-diffs will already have claimed anything it
 * touched, so those paths are excluded here.
 *
 * The residual false positive: an async child's window overlapping a file
 * written by a DIFFERENT async child. Both would be candidates and the file is
 * attributed to whichever is harvested first. `inferred` is doing real work in
 * this function — do not promote these edges.
 */
export function inferOutputs(
  steps: ProvenanceStep[],
  candidates: Array<{ path: string; mtimeMs: number }>,
  window: { start: number; end: number } | null,
  claimedPaths: ReadonlySet<string>,
  sandboxRoot: string,
): ProvenanceStep[] {
  if (!window || steps.length === 0) return steps;
  // Only opaque calls can have produced an unattributed file; a `read` or a
  // successful `write` already accounts for its own effects.
  const opaque = steps.filter((step) => step.degraded === "no-scan-baseline");
  if (opaque.length === 0) return steps;

  const alreadyOnChild = new Set(
    steps.flatMap((step) => step.outputs.map((ref) => ref.path)),
  );
  const attach = new Map<string, ArtifactRef[]>();
  for (const candidate of candidates) {
    if (candidate.mtimeMs < window.start || candidate.mtimeMs > window.end) continue;
    if (claimedPaths.has(candidate.path) || alreadyOnChild.has(candidate.path)) continue;
    // The last opaque call at or before the file's mtime is the best available
    // guess; fall back to the first opaque call when the file predates them all.
    const owner =
      [...opaque].reverse().find((step) => step.timestamp <= candidate.mtimeMs) ?? opaque[0];
    const ref = harvestRef(candidate.path, sandboxRoot, "wrote", "inferred");
    if (!ref) continue;
    const list = attach.get(owner.id) ?? [];
    list.push(ref);
    attach.set(owner.id, list);
  }
  if (attach.size === 0) return steps;
  return steps.map((step) =>
    attach.has(step.id)
      ? { ...step, outputs: [...step.outputs, ...attach.get(step.id)!] }
      : step,
  );
}
