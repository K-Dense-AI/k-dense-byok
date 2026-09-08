/** A missing managed job record is not proof that no remote work happened.
 * Retain its hold if a durable admission intent names it. Unknown/corrupt
 * intent records conservatively protect all otherwise-orphaned holds. */
import fs from "node:fs";
import path from "node:path";
import { managedPath, approvedBatchDir, ROBUSTNESS_ID_RE, readManagedJson } from "./approved.ts";
export function protectedApprovalReservations(projectId: string): Set<string> | null {
  const ids = new Set<string>();
  try {
    const root = managedPath(projectId, ".kady/modal/approved-batches");
    if (!fs.existsSync(root)) return ids;
    const batches = fs.readdirSync(root).filter((name) => ROBUSTNESS_ID_RE.test(name));
    if (batches.length > 1000) return null;
    for (const batchId of batches) {
      const dir = approvedBatchDir(projectId, batchId);
      const intent = path.join(dir, "intent.json");
      const committed = path.join(dir, "committed.json");
      const file = fs.existsSync(intent) ? intent : fs.existsSync(committed) ? committed : null;
      if (!file) continue;
      const data = readManagedJson<{ jobs: Record<string, string> }>(file);
      if (!data.jobs || typeof data.jobs !== "object" || Array.isArray(data.jobs)) return null;
      const entries = Object.entries(data.jobs);
      if (entries.length < 1 || entries.length > 16 || entries.some(([id, digest]) => !/^mj_[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest))) return null;
      for (const [id] of entries) ids.add(id);
    }
    return ids;
  } catch { return null; }
}
