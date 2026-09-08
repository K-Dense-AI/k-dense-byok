"use client";
import { useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { notebookEntryKey, notebookTargetKey, type NotebookEntry } from "@/lib/notebook";
import type { ThreadInfo } from "@/lib/notebook-threads";

/** Evidence counts describe authored links, not independent experiments or truth. */
export function NotebookEvidenceSummary({ entry, thread, entries, onJump, onOpenFile }: {
  entry: NotebookEntry;
  thread?: ThreadInfo;
  entries?: ReadonlyMap<string, NotebookEntry>;
  onJump?: (key: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  const active = thread?.activeEvidence ?? [];
  const unique = (relation: string) => new Set(active.filter((x) => x.relation === relation).map((x) => x.id)).size;
  const relationsBySource = new Map<string, Set<string>>();
  for (const link of active) {
    const relations = relationsBySource.get(link.id) ?? new Set<string>();
    relations.add(link.relation);
    relationsBySource.set(link.id, relations);
  }
  const sourceIds = [...relationsBySource.keys()];
  const health = entry.artifactHealth ?? [];
  const hasChecks = health.length > 0 || Boolean(entry.artifacts?.length);
  const isClaim = entry.type === "hypothesis";
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
      {entry.provisional && <span>Provisional entry — awaiting saved record.</span>}
      {thread?.reviewRequired && (
        <p className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span><strong>Needs review.</strong> Cited artifacts in this entry or its linked evidence changed or are missing. This does not refute the claim.</span>
        </p>
      )}
      {isClaim && (
        <p>{active.some((x) => x.relation !== "context")
          ? `${unique("supports")} supporting · ${unique("challenges")} challenging · ${unique("inconclusive")} inconclusive`
          : "Awaiting linked evidence"}</p>
      )}
      {Boolean(thread?.pendingEvidence) && <p>{thread!.pendingEvidence} provisional evidence link(s) awaiting saved records; not counted yet.</p>}
      {sourceIds.length > 0 && (
        <details className="rounded border px-2 py-1">
          <summary className="cursor-pointer">Inspect {sourceIds.length} active evidence entr{sourceIds.length === 1 ? "y" : "ies"}</summary>
          <p className="my-1 text-[10px]">Authored interpretations, not independent replications or probabilities. Superseded entries are excluded.</p>
          <ul className="flex flex-col gap-1">
            {sourceIds.slice(0, visibleCount).map((id) => {
              const source = entries?.get(id);
              const relations = [...relationsBySource.get(id)!].join(", ");
              const warnings = source?.artifactHealth?.filter((h) => h.status !== "unchanged") ?? [];
              return <li key={id}>
                <button type="button" className="text-left underline decoration-dotted underline-offset-2" onClick={() => onJump?.(id)}>{relations}: {source?.title ?? id}</button>
                {warnings.length > 0 && <span className="ml-1">— artifact checks: {warnings.map((x) => x.status).join(", ")}</span>}
              </li>;
            })}
          </ul>
          {sourceIds.length > visibleCount && <button type="button" className="mt-2 underline" onClick={() => setVisibleCount((n) => n + 50)}>Show more evidence ({visibleCount} of {sourceIds.length} shown)</button>}
        </details>
      )}
      {(entry.evidence ?? []).map((link, index) => {
        const target = notebookTargetKey(entry, link.entryId, link.sessionId);
        const found = entries?.get(target);
        return <div key={`${target}:${link.relation}:${index}`}>
          <button type="button" className="text-left underline decoration-dotted underline-offset-2" disabled={!found || target === notebookEntryKey(entry)} onClick={() => onJump?.(target)}>
            ↳ {link.relation}: {found?.title ?? link.entryId}{!found ? " (not in this view)" : ""}
          </button>
          {link.rationale && <p className="pl-3">{link.rationale}</p>}
        </div>;
      })}
      {Boolean(thread?.unresolvedLinks) && <p>Some references are unavailable in this view or invalid; they are not counted as evidence.</p>}
      {entry.outcome && <p>Outcome: <strong>{entry.outcome.replaceAll("-", " ")}</strong>{entry.outcome === "technical-failure" ? " — not negative scientific evidence" : entry.outcome === "null" ? " — not automatically evidence against a hypothesis" : ""}</p>}
      {entry.scope && <p><strong>Applies to:</strong> {entry.scope}</p>}
      {entry.revisitWhen && <p><strong>Revisit when:</strong> {entry.revisitWhen} <span>(recorded condition, not an automatic action)</span></p>}
      {Boolean(entry.limitations?.length) && <div><strong>Limitations</strong><ul className="list-disc pl-4">{entry.limitations!.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {hasChecks && (
        <details className="rounded border px-2 py-1">
          <summary className="cursor-pointer">Artifact checks{health.length ? ` · ${health.filter((h) => h.status === "unchanged").length}/${health.length} unchanged` : " · not yet verified"}</summary>
          <p className="my-1 text-[10px]">Direct cited files only. Unchanged bytes do not verify scientific validity or upstream data. Checks are point-in-time, not retained historical copies.</p>
          {health.length === 0 && <p>No server verification available yet.</p>}
          <ul className="flex flex-col gap-1">
            {health.map((h) => <li key={h.path}>
              <button type="button" className="text-left underline decoration-dotted underline-offset-2" onClick={() => onOpenFile(h.path)}>{h.path}</button>
              {" — "}<strong>{h.status}</strong>
              <p>{h.reason}</p>
              <time className="text-[10px]" dateTime={new Date(h.checkedAt).toISOString()}>Checked {new Date(h.checkedAt).toLocaleString()}</time>
            </li>)}
          </ul>
          {Boolean(entry.artifactHealthTruncated) && <p>{entry.artifactHealthTruncated} additional artifacts were not checked (limit).</p>}
        </details>
      )}
      {isClaim && Boolean(thread?.unverifiedArtifacts) && <p>{thread!.unverifiedArtifacts} artifact check(s) in this claim or its evidence are unverified.</p>}
    </div>
  );
}
