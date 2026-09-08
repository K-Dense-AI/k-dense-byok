/**
 * Data-guard policy for one project, stored in `sandbox/.kady/policy.json` so
 * the lead extension (this process) and the child package (background
 * specialists, other process) read the same file.
 */
import fs from "node:fs";
import path from "node:path";

export interface GuardPolicy {
  version: 1;
  /** Sandbox-relative globs that must never be mutated by the agent. */
  protectedPaths: string[];
  /** Ask the user before destructive shell commands outside protected paths. */
  destructiveConfirm: boolean;
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  version: 1,
  protectedPaths: ["user_data/**"],
  destructiveConfirm: true,
};

export const MAX_PROTECTED_PATHS = 50;
const GLOB_RE = /^[A-Za-z0-9_./*?@+\-\[\]{}, ]{1,200}$/;

export function guardPolicyPath(sandbox: string): string {
  return path.join(sandbox, ".kady", "policy.json");
}

/** Missing or malformed → defaults; a partially valid file keeps its valid keys. */
export function readGuardPolicy(sandbox: string): GuardPolicy {
  try {
    const raw = JSON.parse(fs.readFileSync(guardPolicyPath(sandbox), "utf-8")) as Record<string, unknown>;
    const protectedPaths = Array.isArray(raw.protectedPaths)
      ? raw.protectedPaths.filter((p): p is string => typeof p === "string" && GLOB_RE.test(p)).slice(0, MAX_PROTECTED_PATHS)
      : DEFAULT_GUARD_POLICY.protectedPaths;
    return {
      version: 1,
      protectedPaths,
      destructiveConfirm:
        typeof raw.destructiveConfirm === "boolean" ? raw.destructiveConfirm : DEFAULT_GUARD_POLICY.destructiveConfirm,
    };
  } catch {
    return { ...DEFAULT_GUARD_POLICY, protectedPaths: [...DEFAULT_GUARD_POLICY.protectedPaths] };
  }
}

export function validateGuardPolicyPatch(patch: unknown): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "body must be an object";
  const body = patch as Record<string, unknown>;
  if ("protectedPaths" in body) {
    if (!Array.isArray(body.protectedPaths)) return "protectedPaths must be an array of globs";
    if (body.protectedPaths.length > MAX_PROTECTED_PATHS) return `at most ${MAX_PROTECTED_PATHS} protected paths`;
    for (const p of body.protectedPaths) {
      if (typeof p !== "string" || !p.trim() || !GLOB_RE.test(p)) return `invalid protected path: ${String(p)}`;
      if (p.startsWith("/") || p.includes("..")) return `protected paths are sandbox-relative: ${p}`;
    }
  }
  if ("destructiveConfirm" in body && typeof body.destructiveConfirm !== "boolean") {
    return "destructiveConfirm must be a boolean";
  }
  return null;
}

export function writeGuardPolicy(
  sandbox: string,
  patch: Partial<Pick<GuardPolicy, "protectedPaths" | "destructiveConfirm">>,
): GuardPolicy {
  const current = readGuardPolicy(sandbox);
  const next: GuardPolicy = {
    version: 1,
    protectedPaths: patch.protectedPaths
      ? [...new Set(patch.protectedPaths.map((p) => p.trim()).filter(Boolean))]
      : current.protectedPaths,
    destructiveConfirm: patch.destructiveConfirm ?? current.destructiveConfirm,
  };
  const file = guardPolicyPath(sandbox);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
  return next;
}
