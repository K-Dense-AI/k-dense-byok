/**
 * Thread derivation over notebook entries: who links to whom (relatesTo +
 * stance), supersede chains, and the resulting hypothesis status. Pure.
 */
import type { NotebookEntry, NotebookStance } from "./notebook";

export type HypothesisStatus = "open" | "supported" | "refuted";

export interface ThreadInfo {
  /** Set only for hypothesis entries. */
  status?: HypothesisStatus;
  /** Id of the entry that supersedes this one. */
  supersededBy?: string;
  /** Entries that point at this one via relatesTo. */
  incoming?: { id: string; stance: NotebookStance }[];
}

/**
 * A hypothesis's status is decided by the LATEST (by timestamp) entry that
 * targets it with a non-neutral stance; no such entry → "open". Dangling
 * relatesTo/supersedes ids (target not in the set) are ignored. Supersedes
 * resolves one hop: A.supersededBy = B.id, not transitively.
 */
export function deriveThreads(entries: NotebookEntry[]): Map<string, ThreadInfo> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const map = new Map<string, ThreadInfo>();
  const info = (id: string): ThreadInfo => {
    let t = map.get(id);
    if (!t) {
      t = {};
      map.set(id, t);
    }
    return t;
  };
  for (const e of entries) {
    if (e.relatesTo && byId.has(e.relatesTo)) {
      const t = info(e.relatesTo);
      (t.incoming ??= []).push({ id: e.id, stance: e.stance ?? "neutral" });
    }
    if (e.supersedes && byId.has(e.supersedes)) {
      info(e.supersedes).supersededBy = e.id;
    }
  }
  for (const e of entries) {
    if (e.type !== "hypothesis") continue;
    const t = info(e.id);
    let latest: NotebookEntry | undefined;
    for (const inc of t.incoming ?? []) {
      if (inc.stance === "neutral") continue;
      const src = byId.get(inc.id);
      if (!src) continue;
      if (!latest || src.timestamp >= latest.timestamp) latest = src;
    }
    t.status = !latest ? "open" : latest.stance === "supports" ? "supported" : "refuted";
  }
  return map;
}
