/** Server-owned per-request admission and idempotent usage accounting. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicJson } from "../atomic-json.ts";
import { getProject, resolvePaths } from "../projects.ts";
import { annotateSubagentCosts, isBudgetExceeded, recordRun, type CostOrigin } from "../cost/ledger.ts";
import { billingForProvider, billingCountsTowardBudget } from "../cost/billing.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function meteredSessionFile(projectId: string, file: string): string {
  return path.join(resolvePaths(projectId).kadyDir, "metered-children", createHash("sha256").update(path.resolve(file)).digest("hex") + ".json");
}
export function childIsMetered(projectId: string, file?: string): boolean {
  return Boolean(file && fs.existsSync(meteredSessionFile(projectId, file)));
}
export function annotateMeteredChild(projectId: string, file: string | undefined, origin: CostOrigin): void {
  if (!file || !childIsMetered(projectId, file)) return;
  const owner = JSON.parse(fs.readFileSync(meteredSessionFile(projectId, file), "utf8"));
  if (typeof owner.sessionId === "string" && typeof owner.childSessionId === "string") {
    annotateSubagentCosts(projectId, owner.sessionId, owner.childSessionId, origin);
    atomicJson(meteredSessionFile(projectId, file), { ...owner, origin });
  }
}
/** Recover a response received by a runner while the backend was unavailable. */
export function recoverSubagentUsage(projectId: string): void {
  const dir = path.join(resolvePaths(projectId).kadyDir, "subagent-usage-pending");
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!/^[\w-]+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.projectId !== projectId) throw new Error("Mismatched accounting project");
      handleSubagentMeter("usage", raw);
      fs.rmSync(file, { force: true });
    } catch (error) {
      // Keep the receipt and fail admission visibly rather than silently losing spend.
      throw new Error(`Unable to recover specialist usage ${name}: ${(error as Error).message}`);
    }
  }
}
export function handleSubagentMeter(action: string, raw: Record<string, unknown>) {
  const { projectId, sessionId, provider, model, requestId, kind } = raw;
  if (![projectId, sessionId, requestId].every((s) => typeof s === "string" && ID.test(s)) ||
      typeof provider !== "string" || !provider || provider.length > 200 || typeof model !== "string" || !model || model.length > 500 ||
      !["subagent", "watchdog"].includes(String(kind)) || !["api_key", "oauth"].includes(String(raw.authType)) || !getProject(projectId as string)) {
    throw new Error("Invalid subagent accounting request");
  }
  const pid = projectId as string;
  const billing = billingForProvider(provider, provider === "ollama" || provider === "openai-compatible" ? "local" : raw.authType as "api_key" | "oauth");
  if (action === "admit") {
    recoverSubagentUsage(pid);
    const budget = isBudgetExceeded(pid);
    if (billingCountsTowardBudget(billing) && budget.exceeded) throw new Error(`Project spend limit reached; ${kind} model request blocked.`);
    if (typeof raw.sessionFile === "string") {
      const marker = meteredSessionFile(pid, raw.sessionFile);
      if (!fs.existsSync(marker)) atomicJson(marker, { sessionId, childSessionId: raw.childSessionId });
    }
    return { ok: true };
  }
  if (action !== "usage") throw new Error("Unknown accounting action");
  const u = raw.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return { ok: true, recorded: false };
  const num = (v: unknown) => {
    if (v === undefined) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("Invalid reported usage");
    return v;
  };
  const input = num(u.input), output = num(u.output), cacheRead = num(u.cacheRead), cacheWrite = num(u.cacheWrite);
  const cost = num((u.cost as { total?: unknown } | undefined)?.total);
  let origin: CostOrigin = {};
  if (typeof raw.sessionFile === "string" && childIsMetered(pid, raw.sessionFile)) {
    origin = JSON.parse(fs.readFileSync(meteredSessionFile(pid, raw.sessionFile), "utf8")).origin ?? {};
  }
  const entry = recordRun({ projectId: pid, sessionId: sessionId as string,
    entryId: `subagent-request-${requestId}`, model: `${provider}/${model}`, role: "subagent", billing,
    origin: { ...origin, kind: kind as "watchdog" | "subagent",
      ...(typeof raw.childSessionId === "string" ? { childSessionId: raw.childSessionId } : {}),
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}) },
    before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
    after: { costUsd: cost, input, output, cacheRead, total: input + output + cacheRead + cacheWrite } });
  return { ok: true, recorded: Boolean(entry) };
}
