/** Authored execution reports are distinct from server-observed provenance. */
export interface NotebookExecution {
  status: "planned" | "attempted" | "completed" | "unverified";
  /** Concrete command/output evidence and record locations, never approval. */
  evidence?: string;
}

export function normalizeNotebookExecution(value: unknown): NotebookExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!["planned", "attempted", "completed", "unverified"].includes(String(raw.status))) return undefined;
  const evidence = typeof raw.evidence === "string" ? raw.evidence.trim().slice(0, 4000) : "";
  // Neither titles, artifact existence nor approval establish execution.
  const status = raw.status === "completed" && !evidence ? "unverified" : raw.status as NotebookExecution["status"];
  return { status, ...(evidence ? { evidence } : {}) };
}

export function notebookExecutionText(value: unknown): string {
  const execution = normalizeNotebookExecution(value);
  return `Execution (authored, not independently verified): ${execution?.status ?? "unverified"}`
    + (execution?.evidence ? `\nReported execution evidence: ${execution.evidence}` : "\nExecution evidence not recorded in this field.");
}
