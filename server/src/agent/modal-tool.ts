/**
 * Native `modal_run` tool: run a command/script on a remote Modal Sandbox
 * (CPU or GPU) the user has chosen, then bring results back.
 *
 * This is the "agent-driven offload" model: the Pi agent loop stays local and
 * the local project sandbox stays the canonical filesystem. When the agent
 * needs heavy or GPU compute it calls `modal_run`, which:
 *   1. spins an isolated Modal Sandbox on the selected instance (BYOK creds —
 *      MODAL_TOKEN_ID / MODAL_TOKEN_SECRET, passed per-client),
 *   2. optionally builds a custom image (extra pip/apt packages),
 *   3. uploads `files_in` (sandbox-relative) into the remote /workspace,
 *   4. runs the command, capturing stdout/stderr/exit code,
 *   5. downloads `files_out` back into the local project sandbox,
 *   6. meters wall-time × the instance's hourly rate as a `compute` cost row,
 *   7. terminates the sandbox.
 *
 * Built as an in-process custom tool (mirrors interview.ts) — it is available
 * to the main agent session. Child `pi` subagent processes do not get it (they
 * load tools the project-settings way); extending it to subagents would mean
 * promoting this to a Pi package bridge (see web-access-bridge.ts).
 *
 * Note: `ollama/*` models run on the local daemon and are unaffected — Modal
 * offload is for compute steps, not for relocating the model loop. No secrets
 * are injected into the remote sandbox by default (the user's model key is not
 * forwarded); a future revision can add an explicit per-call secret allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ModalClient, type Sandbox } from "modal";
import { resolvePaths } from "../projects.ts";
import { isBudgetExceeded, recordModalRun } from "../cost/ledger.ts";
import {
  DEFAULT_INSTANCE_ID,
  MODAL_INSTANCE_IDS,
  resolveInstance,
} from "./modal-instances.ts";

const APP_NAME = "kady";
const WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
/** Cap each stream in the tool result so a chatty job can't blow the context. */
const MAX_OUTPUT_CHARS = 16000;

// Per-session default compute instance, stashed by the /run handler before a
// run (mirrors fusion-bridge's setFusionConfig). Module-level because the tool
// is constructed before the session exists and reads the live value by id.
// `null` means no Modal default selected ("local") — the tool then falls back
// to DEFAULT_INSTANCE_ID when the agent doesn't name an instance.
const sessionComputeTargets = new Map<string, string | null>();

/** Stash (or clear, with `null`/"local") the default compute instance for a session. */
export function setSessionComputeTarget(sessionId: string, instanceId: string | null): void {
  sessionComputeTargets.set(sessionId, instanceId && instanceId !== "local" ? instanceId : null);
}

export const ModalRunParams = Type.Object({
  command: Type.String({
    description: "Shell command to run remotely (executed via `sh -lc` in /workspace), e.g. \"python train.py --epochs 50\".",
  }),
  instance: Type.Optional(
    Type.String({
      description: `Compute instance id. One of: ${MODAL_INSTANCE_IDS.join(", ")}. Omit to use the session's selected default (else "${DEFAULT_INSTANCE_ID}").`,
    }),
  ),
  image: Type.Optional(
    Type.Object({
      base: Type.Optional(
        Type.String({ description: "Base registry image (default python:3.13-slim). e.g. \"pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime\"." }),
      ),
      pip: Type.Optional(Type.Array(Type.String(), { description: "pip packages to install into the image" })),
      apt: Type.Optional(Type.Array(Type.String(), { description: "apt packages to install into the image" })),
    }),
  ),
  files_in: Type.Optional(
    Type.Array(Type.String(), {
      description: "Sandbox-relative paths to upload into the remote /workspace before running.",
    }),
  ),
  files_out: Type.Optional(
    Type.Array(Type.String(), {
      description: "Sandbox-relative paths produced by the job to download back into the local project after it finishes.",
    }),
  ),
  timeout_sec: Type.Optional(
    Type.Number({ description: `Max seconds before the sandbox is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` }),
  ),
});
export type ModalRunParamsT = Static<typeof ModalRunParams>;

/** Resolve a sandbox-relative path against the project sandbox, refusing traversal. */
function safeUnder(sandboxRoot: string, rel: string): string {
  const target = path.resolve(sandboxRoot, rel);
  if (target !== sandboxRoot && !target.startsWith(sandboxRoot + path.sep)) {
    throw new Error(`Path escapes the project sandbox: ${rel}`);
  }
  return target;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `…(${s.length - MAX_OUTPUT_CHARS} earlier chars truncated)\n${s.slice(-MAX_OUTPUT_CHARS)}`;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Build the `modal_run` ToolDefinition for one project session. `getSessionId`
 * is late-bound (the tool is built before the session exists) — same holder
 * pattern as the interview tool and subagent ledger extension.
 */
export function makeModalTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof ModalRunParams> {
  return {
    name: "modal_run",
    label: "Modal compute",
    description: [
      "Run a command or script on a remote Modal Sandbox (on-demand CPU or GPU) and get the result back.",
      "Use for heavy or GPU work that shouldn't run on the local machine: model training/fine-tuning, GPU inference, large simulations, or compute the local sandbox can't handle.",
      "The remote sandbox is ephemeral and isolated. Upload inputs with `files_in` (sandbox-relative) and name expected outputs in `files_out` — they are copied back into the local project sandbox so your other tools (read/edit/bash) can use them. The local sandbox remains the source of truth.",
      "Pick an `instance` by GPU need (omit to use the session's selected compute target). Add `image.pip`/`image.apt` for dependencies, or set `image.base` for a CUDA/framework base image.",
      "Cost is billed by wall-clock time on the chosen instance and counts toward the project budget, so keep jobs scoped.",
    ].join("\n"),
    promptSnippet:
      "modal_run: run a command/script on a remote Modal sandbox (CPU/GPU) and copy results back",
    parameters: ModalRunParams,
    execute: async (_toolCallId, params, signal) => {
      const sessionId = getSessionId();

      // Hard budget cap — same gate the subagent tool applies.
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        return textResult(
          `Modal run blocked: the project has reached its spend limit ` +
            `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
            `Finish without remote compute or ask the user to raise the limit.`,
          { blocked: "budget" },
        );
      }

      const tokenId = process.env.MODAL_TOKEN_ID;
      const tokenSecret = process.env.MODAL_TOKEN_SECRET;
      if (!tokenId || !tokenSecret) {
        return textResult(
          "Modal is not configured. Add MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings → API keys (get them at https://modal.com/settings).",
          { error: "not_configured" },
        );
      }

      const instanceId = params.instance ?? sessionComputeTargets.get(sessionId) ?? DEFAULT_INSTANCE_ID;
      const spec = resolveInstance(instanceId);
      if (!spec) {
        return textResult(
          `Unknown compute instance "${instanceId}". Valid instances: ${MODAL_INSTANCE_IDS.join(", ")}.`,
          { error: "unknown_instance" },
        );
      }

      const sandboxRoot = resolvePaths(projectId).sandbox;
      const timeoutMs =
        Math.min(Math.max(Math.floor(params.timeout_sec ?? DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S) * 1000;

      const modal = new ModalClient({ tokenId, tokenSecret });
      const startedAt = Date.now();
      let sb: Sandbox | null = null;
      const onAbort = () => {
        sb?.terminate().catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });

        let image = modal.images.fromRegistry(params.image?.base ?? spec.defaultImage);
        const dockerCmds: string[] = [];
        if (params.image?.apt?.length) {
          dockerCmds.push(
            `RUN apt-get update && apt-get install -y ${params.image.apt.join(" ")} && rm -rf /var/lib/apt/lists/*`,
          );
        }
        if (params.image?.pip?.length) {
          dockerCmds.push(`RUN pip install --no-cache-dir ${params.image.pip.join(" ")}`);
        }
        if (dockerCmds.length) image = image.dockerfileCommands(dockerCmds);

        sb = await modal.sandboxes.create(app, image, {
          gpu: spec.gpu ?? undefined,
          cpu: spec.cpu,
          memoryMiB: spec.memoryMiB,
          timeoutMs,
        });
        await sb.filesystem.makeDirectory(WORKDIR, { createParents: true });

        // Stage inputs.
        const stagedIn: string[] = [];
        const missingIn: string[] = [];
        for (const rel of params.files_in ?? []) {
          const local = safeUnder(sandboxRoot, rel);
          if (!fs.existsSync(local)) {
            missingIn.push(rel);
            continue;
          }
          const remote = path.posix.join(WORKDIR, rel);
          const remoteDir = path.posix.dirname(remote);
          if (remoteDir && remoteDir !== WORKDIR) {
            await sb.filesystem.makeDirectory(remoteDir, { createParents: true });
          }
          await sb.filesystem.copyFromLocal(local, remote);
          stagedIn.push(rel);
        }

        // Run.
        const proc = await sb.exec(["sh", "-lc", params.command], {
          stdout: "pipe",
          stderr: "pipe",
          workdir: WORKDIR,
          timeoutMs,
        });
        const [stdout, stderr] = await Promise.all([
          proc.stdout.readText(),
          proc.stderr.readText(),
        ]);
        const exitCode = await proc.wait();

        // Collect outputs.
        const collectedOut: string[] = [];
        const missingOut: string[] = [];
        for (const rel of params.files_out ?? []) {
          const local = safeUnder(sandboxRoot, rel);
          const remote = path.posix.join(WORKDIR, rel);
          try {
            fs.mkdirSync(path.dirname(local), { recursive: true });
            await sb.filesystem.copyToLocal(remote, local);
            collectedOut.push(rel);
          } catch {
            missingOut.push(rel);
          }
        }

        const durationMs = Date.now() - startedAt;
        const costUsd = (durationMs / 3_600_000) * spec.pricePerHour;
        recordModalRun(projectId, sessionId, costUsd, `modal:${spec.id}`);

        const summary = {
          instance: spec.id,
          gpu: spec.gpu,
          exit_code: exitCode,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
        };
        const text =
          `${JSON.stringify(summary, null, 2)}\n\n` +
          `--- stdout ---\n${truncate(stdout) || "(empty)"}\n\n` +
          `--- stderr ---\n${truncate(stderr) || "(empty)"}`;
        return textResult(text, summary);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return textResult(
          `Modal run failed on instance "${spec.id}": ${msg}\n` +
            `If this is an authentication error, check MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in Settings.`,
          { error: "modal_failure", instance: spec.id },
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (sb) await sb.terminate().catch(() => {});
        modal.close();
      }
    },
  };
}
