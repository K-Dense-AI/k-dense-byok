"use client";
import { useEffect, useRef, useState } from "react";
import { PackageIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/projects";
import { EVIDENCE_PACKAGE_NOTICE, type EvidenceRoot, type EvidencePackagePreview, type EvidenceStorage } from "@/lib/evidence-packages";
export interface EvidenceCandidate extends EvidenceRoot { title: string; type: string }
interface Props { projectId: string; candidates: EvidenceCandidate[]; initialRoot?: EvidenceRoot }
interface PackageList { packages: { id: string; title: string; createdAt: number; bytes: number; issues: number; available: boolean }[]; errors: string[]; storage?: EvidenceStorage }
const key = (r: EvidenceRoot) => JSON.stringify([r.sessionId, r.entryId]);
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1024 * 1024)).toFixed(2)} MiB`;
const field = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
export function EvidencePackageDialog(props: Props) { return <PackageDialog key={props.projectId + (props.initialRoot ? key(props.initialRoot) : "")} {...props} />; }
function PackageDialog({ projectId, candidates, initialRoot }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"select" | "review" | "storage">("select");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialRoot ? [key(initialRoot)] : []));
  const [title, setTitle] = useState("Reviewer evidence package");
  const [filter, setFilter] = useState("");
  const [includeArtifacts, setIncludeArtifacts] = useState(true);
  const [includeCurrent, setIncludeCurrent] = useState(false);
  const [includeArgs, setIncludeArgs] = useState(false);
  const [preview, setPreview] = useState<EvidencePackagePreview | null>(null);
  const [list, setList] = useState<PackageList | null>(null);
  const [sensitive, setSensitive] = useState(false); const [limits, setLimits] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null); const [prune, setPrune] = useState(false);
  const generation = useRef(0); const request = useRef<AbortController | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/notebook/evidence-packages`;
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  const all = new Map(candidates.map((c) => [key(c), c]));
  async function call<T>(suffix = "", body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T | undefined> {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++generation.current; const timer = setTimeout(() => controller.abort(), 120_000);
    setBusy(true); setError("");
    try {
      const res = await apiFetch(base + suffix, { method, signal: controller.signal, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }, projectId);
      const data = await res.json(); if (!res.ok) throw new Error(data.detail ?? "Evidence package operation failed");
      if (version === generation.current) return data as T;
    } catch (e) { if (version === generation.current) setError(controller.signal.aborted ? "Request timed out. A prepared package may still exist; check saved packages before retrying." : (e as Error).message); }
    finally { clearTimeout(timer); if (version === generation.current) setBusy(false); }
  }
  async function refreshStorage() { const value = await call<PackageList>(); if (value) { setList(value); setMode("storage"); } }
  async function download() {
    if (!preview || !sensitive || !limits) return;
    const controller = new AbortController(); request.current = controller; const version = ++generation.current;
    const timer = setTimeout(() => controller.abort(), 120_000); setBusy(true); setError("");
    try {
      const response = await apiFetch(`${base}/${preview.id}/download`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: preview.digest, acknowledgeSensitive: sensitive, acknowledgeLimitations: limits }) }, projectId);
      if (!response.ok) { const data = await response.json(); throw new Error(data.detail ?? "Package download failed"); }
      if (response.headers.get("X-Content-SHA256") !== preview.zipSha256) throw new Error("Download identity did not match the reviewed package");
      const blob = await response.blob();
      if (blob.size !== preview.zipBytes) throw new Error("Downloaded package size did not match its reviewed manifest");
      if (!globalThis.crypto?.subtle) throw new Error("Browser checksum verification is unavailable; open Kady on localhost or HTTPS");
      const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (actual !== preview.zipSha256) throw new Error("Downloaded bytes failed the reviewed ZIP checksum; nothing was saved");
      if (version !== generation.current) return;
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `evidence-${preview.id}.zip`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success("Evidence package downloaded. Integrity checks do not establish scientific reproducibility.");
    } catch (e) { if (version === generation.current) setError((e as Error).message); }
    finally { clearTimeout(timer); if (version === generation.current) setBusy(false); }
  }
  return <>
    <Button type="button" variant="outline" size="xs" onClick={() => setOpen(true)}><PackageIcon data-icon="inline-start" />Evidence package</Button>
    <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}><DialogContent className="min-w-0 max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-4xl">
      <DialogHeader><DialogTitle>Reviewer evidence package</DialogTitle><DialogDescription>{EVIDENCE_PACKAGE_NOTICE}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={busy} onClick={() => setMode("select")}>Select evidence</Button><Button size="xs" variant="outline" disabled={busy} onClick={refreshStorage}>Saved packages / storage</Button>{busy && <span role="status" className="text-xs">Working locally…</span>}</div>
      {error && <p role="alert" className="rounded border border-destructive/30 p-2 text-sm text-destructive">{error}</p>}
      {mode === "select" && <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        const roots = [...selected].map((k) => all.get(k)).filter((r): r is EvidenceCandidate => !!r).map(({ sessionId, entryId }) => ({ sessionId, entryId }));
        const p = await call<EvidencePackagePreview>("/prepare", { title, roots, includeArtifacts, includeCurrentUnverified: includeCurrent, includeCommandArguments: includeArgs });
        if (p) { if (p.projectId !== projectId) { setError("Package belongs to a different project"); return; } setPreview(p); setSensitive(false); setLimits(false); setMode("review"); }
      }}>
        <label className="block text-xs">Package title<input aria-label="Package title" className={field} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <p className="text-xs">Choose 1–8 roots. Supporting/challenging links and amendments are included automatically within bounded graph limits; this does not certify that the entire argument is complete. Use All chats in the notebook to select roots from other sessions.</p>
        <input aria-label="Filter package roots" className={field} placeholder="Filter roots by title…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-56 space-y-1 overflow-y-auto rounded border p-2">
          {[...all].filter(([, c]) => c.title.toLowerCase().includes(filter.toLowerCase())).slice(0, 200).map(([id, c]) => <label key={id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={selected.has(id)} disabled={!selected.has(id) && selected.size >= 8} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(id); else next.delete(id); return next; })} /><span>{c.title} <span className="text-muted-foreground">· {c.type} · chat {c.sessionId}</span></span></label>)}
          {all.size === 0 && <p className="text-xs">No saved notebook roots are available in this view.</p>}
        </div>
        <p className="text-[11px] text-muted-foreground">{selected.size} selected. Root picker shows up to 200 matches; narrow the filter for larger notebooks.</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={includeArtifacts} onChange={(e) => setIncludeArtifacts(e.target.checked)} />Include artifact bytes and retain local version snapshots (up to 128 MiB/file, 256 MiB/package).</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={includeCurrent} disabled={!includeArtifacts} onChange={(e) => setIncludeCurrent(e.target.checked)} />Allow current unverified/comparison copies when original identities cannot be recovered. They will not be labelled original evidence.</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={includeArgs} onChange={(e) => setIncludeArgs(e.target.checked)} />Include raw recorded provenance arguments (may contain sensitive command parameters).</label>
        <p className="rounded border border-amber-500/30 p-2 text-xs">Preparation retains local snapshots and a frozen ZIP; it does not publish or upload them. Notebook prose/snippets and artifact contents are not automatically redacted. Deleting an original file does not remove its retained snapshots. Manage saved packages and snapshot storage explicitly.</p>
        <Button type="submit" size="sm" disabled={busy || !selected.size || selected.size > 8}>Prepare review package</Button>
      </form>}
      {mode === "review" && preview && <div className="space-y-3">
        <h3 className="text-sm font-semibold">{preview.manifest.title}</h3>
        <p className="text-xs">{preview.manifest.records.length} source records · {preview.manifest.artifacts.filter((a) => a.archivePath).length} packaged artifact references · {bytes(preview.zipBytes)} ZIP · assembled {new Date(preview.createdAt).toLocaleString()}</p>
        <p className="rounded border border-amber-500/40 p-2 text-xs"><strong>Not reproduced.</strong> This frozen package will not refresh itself when the project changes. Matching hashes prove byte identity only. The Methods file is a source-linked scaffold, not a validated manuscript.</p>
        <details><summary className="cursor-pointer text-xs font-medium">Included sources and metadata</summary><ul className="space-y-1 text-xs">{preview.manifest.records.map((r) => <li key={r.key}>{r.selection}: {r.title} · {r.status} · {r.source.sessionId}/{r.source.entryId}</li>)}</ul><ul className="mt-2 text-[11px]">{preview.manifest.metadataFiles.map((f) => <li key={f}>{f}</li>)}</ul></details>
        <div className="overflow-x-auto rounded border"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="border-b bg-muted/30"><th className="p-2">Artifact / version basis</th><th className="p-2">Package status</th><th className="p-2">Identity / origin</th></tr></thead><tbody>{preview.manifest.artifacts.map((a) => <tr key={a.id} className="border-b align-top last:border-0"><td className="max-w-64 p-2 break-all">{a.path}<p className="text-muted-foreground">{a.basis}</p></td><td className="max-w-64 p-2">{a.status}<p>{a.reason}</p></td><td className="max-w-72 p-2 break-all"><p>Expected: {a.expectedSha256 ?? "not recorded"}</p><p>Packaged: {a.sha256 ?? "none"}</p>{a.origin && <p>{a.origin} · {bytes(a.size ?? 0)}</p>}</td></tr>)}</tbody></table></div>
        <p className="text-[10px] text-muted-foreground">The version table scrolls horizontally on narrow screens. Current-unverified copies are not silently substituted for historical evidence.</p>
        <details open className="rounded border p-2"><summary className="cursor-pointer text-xs font-semibold">Missing / unverified information ({preview.manifest.issues.length})</summary><ul className="mt-2 max-h-52 list-disc overflow-y-auto pl-4 text-xs">{preview.manifest.issues.map((i, n) => <li key={n}><strong>{i.code}</strong>{i.subject ? ` (${i.subject})` : ""}: {i.message}</li>)}</ul></details>
        <details><summary className="cursor-pointer text-xs">Checksum inventory</summary><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all p-2 text-[10px]">{preview.files.map((f) => `${f.sha256}  ${f.path}`).join("\n")}</pre></details>
        <p className="break-all text-[10px]">ZIP sha256: {preview.zipSha256}</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />I reviewed the selected contents and will check sensitive data and redistribution rights before sharing.</label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={limits} onChange={(e) => setLimits(e.target.checked)} />I understand the listed gaps, unverified versions and that packaging does not reproduce or validate the science.</label>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !sensitive || !limits} onClick={download}>Download reviewed ZIP</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode("select")}>Prepare a different snapshot</Button></div>
        <p className="text-[11px] text-muted-foreground">After extraction, optionally run <code>python3 -I verify.py</code> to check file hashes only. No analysis runs automatically. Reproduction remains a separate, explicitly approved workflow.</p>
      </div>}
      {mode === "storage" && list && <div className="space-y-3">
        {list.storage && <p className="text-xs">Snapshots {bytes(list.storage.snapshotsBytes)} / {bytes(list.storage.snapshotsLimitBytes)} · packages {bytes(list.storage.packagesBytes)} / {bytes(list.storage.packagesLimitBytes)} · {list.storage.packageCount}/{list.storage.packageLimit} packages</p>}
        {list.errors.map((e, i) => <p key={i} role="alert" className="text-xs text-destructive">{e}</p>)}
        {list.packages.map((p) => <div key={p.id} className="space-y-1 rounded border p-2 text-xs"><p className="font-medium">{p.title}</p><p>{p.id} · {bytes(p.bytes)} · {p.issues} notices</p><div className="flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={busy || !p.available} onClick={async () => { const full = await call<EvidencePackagePreview>(`/${p.id}`); if (full) { setPreview(full); setSensitive(false); setLimits(false); setMode("review"); } }}>Review saved package</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => setDeleteId(p.id)}>Remove package</Button></div>
          {deleteId === p.id && <div className="rounded border border-amber-500/30 p-2"><p>Remove this frozen ZIP and its payload? Shared historical snapshots remain until explicitly pruned. Original research files are untouched.</p><Button size="xs" disabled={busy} onClick={async () => { const result = await call(`/${p.id}`, undefined, "DELETE"); if (result) { setDeleteId(null); await refreshStorage(); } }}>Confirm removal</Button></div>}
        </div>)}
        {!list.packages.length && <p className="text-xs">No saved evidence packages.</p>}
        <div className="rounded border border-amber-500/40 p-2 text-xs"><label className="flex items-start gap-2"><input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />I understand pruning removes historical byte versions not referenced by retained packages. Notebook citations may then become unrecoverable; original project files are not deleted.</label><Button className="mt-2" variant="outline" size="xs" disabled={busy || !prune} onClick={async () => { const result = await call("/prune-snapshots", { confirmed: true }); if (result) { setPrune(false); await refreshStorage(); } }}>Prune unreferenced snapshots</Button></div>
      </div>}
    </DialogContent></Dialog>
  </>;
}
