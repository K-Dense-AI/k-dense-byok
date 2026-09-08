/** Bounded observation-only provenance reads for packages. No environment probes. */
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import { managedPath } from "../modal/approved.ts";
import { readEvidenceBytes, SHA256, type ReadBudget } from "./storage.ts";
import { environmentId, type EnvironmentSnapshot } from "../provenance/environment.ts";
import type { ProvenanceStep, ArtifactRef } from "../provenance/store.ts";
import type { EvidenceIssue } from "../../../web/src/lib/evidence-packages.ts";
export const MAX_PACKAGE_STEPS = 200;
function* completeLines(text: string) {
  let start = 0;
  while (start < text.length) { const end = text.indexOf("\n", start); if (end < 0) break; yield text.slice(start, end); start = end + 1; }
}
export const stepKey = (step: Pick<ProvenanceStep, "sessionId" | "id">) => JSON.stringify([step.sessionId, step.id]);
function validRef(value: unknown): value is ArtifactRef {
  const r = value as ArtifactRef | null;
  return !!r && typeof r.path === "string" && r.path.length <= 2000 && ["observed", "inferred", "declared"].includes(r.confidence) && ["created", "modified", "deleted", "read", "unchanged", "wrote"].includes(r.change) && (r.sha256 === undefined || SHA256.test(r.sha256));
}
export async function packageProvenance(projectId: string, prioritySessions: string[], issues: EvidenceIssue[]): Promise<ProvenanceStep[]> {
  const root = managedPath(projectId, ".kady/provenance");
  let names: string[];
  try { names = await fs.promises.readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ code: "provenance-unreadable", message: "Provenance directory could not be read safely" }); return []; }
  const budget: ReadBudget = { remaining: 32 * 1024 * 1024 };
  names = names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name));
  names.sort((a, b) => Number(prioritySessions.includes(b)) - Number(prioritySessions.includes(a)) || a.localeCompare(b));
  if (names.length > 100) issues.push({ code: "provenance-scan-limit", message: "Only 100 provenance sessions were considered; lineage is incomplete" });
  const steps: ProvenanceStep[] = []; const seen = new Set<string>(); let rows = 0;
  for (const sessionId of names.slice(0, 100)) {
    if (budget.remaining <= 0 || rows >= 10000) { issues.push({ code: "provenance-scan-limit", message: "Provenance byte/row budget reached; absence of upstream work is not verified" }); break; }
    try {
      const bytes = await readEvidenceBytes(projectId, path.join(root, sessionId, "steps.jsonl"), prioritySessions.includes(sessionId) ? 16 * 1024 * 1024 : 4 * 1024 * 1024, budget);
      const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      if (text && !text.endsWith("\n")) issues.push({ code: "provenance-incomplete-row", subject: sessionId, message: "An unterminated provenance row was not treated as a complete observation" });
      for (const line of completeLines(text)) {
        if (++rows > 10000 || issues.length >= 200) { issues.push({ code: "provenance-scan-limit", message: "Provenance row/error budget reached" }); break; }
        if (!line.trim()) continue;
        try {
          if (Buffer.byteLength(line) > 256 * 1024) throw new Error("oversized row");
          const s = JSON.parse(line) as ProvenanceStep;
          if (s.schemaVersion !== 1 || s.sessionId !== sessionId || typeof s.id !== "string" || s.id.length > 500 || !Number.isFinite(s.timestamp) || !["agent", "subagent", "user", "compute"].includes(s.role) || typeof s.toolName !== "string" || !Array.isArray(s.inputs) || !Array.isArray(s.outputs) || s.inputs.length + s.outputs.length > 200 || !s.inputs.every(validRef) || !s.outputs.every(validRef)) throw new Error("unsupported row");
          const key = stepKey(s);
          if (seen.has(key)) { issues.push({ code: "provenance-ambiguous", subject: key, message: "Duplicate provenance step id encountered; causal attribution may be ambiguous" }); continue; }
          seen.add(key); steps.push(s);
        } catch { issues.push({ code: "provenance-invalid-row", subject: sessionId, message: "A malformed/oversized/unsupported provenance row was omitted" }); }
      }
    } catch (e) { issues.push({ code: "provenance-unavailable", subject: sessionId, message: `Provenance source not included: ${(e as Error).message}` }); }
    if (issues.length >= 200) { issues.push({ code: "issue-limit", message: "Further provenance sources were not inspected after repeated errors" }); break; }
  }
  return steps.sort((a, b) => a.timestamp - b.timestamp);
}
export async function storedEnvironment(projectId: string, id: string, budget: ReadBudget): Promise<EnvironmentSnapshot> {
  if (!SHA256.test(id)) throw new Error("Invalid environment id");
  const file = managedPath(projectId, `.kady/environments/${id}.json`);
  const raw = JSON.parse((await readEvidenceBytes(projectId, file, 1024 * 1024, budget)).toString("utf8")) as EnvironmentSnapshot;
  const checkDepth = (v: unknown, depth: number): void => { if (depth > 16) throw new Error("Environment metadata is too deeply nested"); if (v && typeof v === "object") for (const child of Object.values(v)) checkDepth(child, depth + 1); };
  checkDepth(raw, 0);
  const { id: recorded, capturedAt: _time, ...body } = raw;
  if (recorded !== id || raw.schemaVersion !== 1 || environmentId(body) !== id || !Array.isArray(raw.lockfiles) || raw.lockfiles.length > 20) throw new Error("Environment snapshot failed identity/schema validation");
  return raw;
}
