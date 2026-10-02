"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { commandPreview } from "@/lib/command-blocks";
import { fleetSessions, getFleet, controlSpecialist, type FleetSnapshot, type FleetAction, type FleetNode } from "@/lib/subagent-fleet";
const active = (state: string) => ["running", "queued", "pending"].includes(state);
type Target = { runId: string; index?: number; label: string };
const flatten = (rows: FleetNode[]): FleetNode[] => rows.flatMap((row) => [row, ...flatten(row.children ?? [])]);

export function SubagentFleetPanel({ projectId }: { projectId: string }) {
  const [sessions, setSessions] = useState<Array<{ id: string; name: string }>>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessionRefresh, setSessionRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Target | null>(null);
  const [transcript, setTranscript] = useState("");
  const [transcriptRefresh, setTranscriptRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const [stopping, setStopping] = useState<Target | null>(null);
  const generation = useRef(0);
  useEffect(() => { setSessions([]); setSessionId(""); }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    const load = () => fleetSessions(projectId).then(({ sessions }) => {
      if (!cancelled) { setSessions(sessions); setSessionId((id) => sessions.some((s) => s.id === id) ? id : sessions[0]?.id || ""); }
    }).catch((e) => { if (!cancelled) setError(e.message); });
    void load();
    // A chat started after this panel mounted (or the first schedule's host)
    // would otherwise stay invisible until "Refresh chats".
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId, sessionRefresh]);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null); setSelected(null); setTranscript(""); setMessage(""); setStopping(null); setError(""); setNotice(""); setBusy(false);
    if (!sessionId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await getFleet(projectId, sessionId); if (!cancelled) { setSnapshot(data); setError(""); } }
      catch (e) { if (!cancelled) setError((e as Error).message); }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); if (generation.current === current) generation.current++; };
  }, [projectId, sessionId]);
  useEffect(() => {
    if (!selected || !sessionId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    setTranscript("Loading transcript…");
    async function refresh() {
      try {
        const data = await controlSpecialist(projectId, sessionId, "transcript", selected!.runId, undefined, selected!.index);
        if (!cancelled) setTranscript(data.text || "No transcript available yet.");
      } catch (e) { if (!cancelled) setTranscript(`Transcript unavailable: ${(e as Error).message}`); }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, sessionId, selected, transcriptRefresh]);
  const action = useCallback(async (verb: FleetAction, target: Target) => {
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const result = await controlSpecialist(projectId, sessionId, verb, target.runId, message, target.index);
      if (generation.current !== current) return;
      setNotice(result.text || "Request acknowledged."); setMessage(""); setStopping(null); setTranscriptRefresh((n) => n + 1);
      const next = await getFleet(projectId, sessionId);
      if (generation.current === current) setSnapshot(next);
    } catch (e) { if (generation.current === current) setError((e as Error).message); }
    finally { if (generation.current === current) setBusy(false); }
  }, [projectId, sessionId, message]);
  const runs = snapshot?.asyncSnapshot?.runs ?? [];
  const selectedNode = selected && flatten(runs).find((node) => selected.index === undefined
    ? node.id === selected.runId
    : node.control?.runId === selected.runId && node.control.index === selected.index);
  const isActive = Boolean(selectedNode && active(selectedNode.state));
  const inspect = (target: Target) => { setSelected(target); setMessage(""); setStopping(null); setNotice(""); };
  const childRows = (children: FleetNode[]) => children.map((child) => <div key={child.id} className="space-y-1 pl-3">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span>{child.label} · {child.state}{child.activity?.currentTool ? ` · ${child.activity.currentTool}` : ""}</span>
      {child.control && <Button size="sm" variant="ghost" disabled={busy} onClick={() => inspect({ ...child.control!, label: child.label })}>Inspect {child.label}</Button>}
    </div>
    {childRows(child.children ?? [])}
  </div>);
  return <section className="space-y-3 rounded-xl border p-4" aria-label="Specialist fleet">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-medium">Specialist fleet</h3><p className="text-xs text-muted-foreground">Watch delegated work, inspect results, and guide a specialist.</p></div>
      <div className="flex gap-2">
        <select aria-label="Fleet chat" value={sessionId} onChange={(e) => setSessionId(e.target.value)} className="max-w-64 rounded border bg-background px-2 py-1 text-xs">
          {!sessions.length && <option value="">No chats yet</option>}
          {sessions.map((s) => <option key={s.id} value={s.id}>{commandPreview(s.name)}</option>)}
        </select>
        <Button size="sm" variant="ghost" onClick={() => setSessionRefresh((n) => n + 1)}>Refresh chats</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="whitespace-pre-wrap text-xs">{notice}</p>}
    {snapshot?.fleet && <p className="text-xs text-muted-foreground">{snapshot.fleet.totalActive} active specialists</p>}
    {snapshot?.fleet?.entries.map((entry) => <div key={entry.key} className="text-xs"><span className="font-medium">{entry.agent}</span> · {entry.model || "Inherited model"} · {entry.tokens.total.toLocaleString()} tokens{entry.goal && <p className="text-muted-foreground">{entry.goal}</p>}</div>)}
    {!runs.length && <p className="text-xs text-muted-foreground">{snapshot ? "No specialist runs in this chat." : sessionId ? "Loading specialists…" : "Start a chat to view its specialists."}</p>}
    {runs.map((run) => <div key={run.id} className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{run.label}</span><span className="text-xs">{run.state}</span></div>
      {run.startedAt && <p className="text-xs text-muted-foreground">{Math.max(0, Math.round(((run.endedAt || Date.now()) - run.startedAt) / 1000))}s elapsed{run.activity?.currentTool ? ` · ${run.activity.currentTool}` : ""}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => inspect({ runId: run.id, label: run.label })}>Transcript & controls</Button>
        {active(run.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => setStopping({ runId: run.id, label: run.label })}>Stop run</Button>}
      </div>
      {childRows(run.children ?? [])}
    </div>)}
    {(snapshot?.asyncSnapshot?.omitted?.runs || snapshot?.asyncSnapshot?.omitted?.children || snapshot?.fleet?.omitted) ? <p className="text-xs text-muted-foreground">Some entries are omitted from this bounded view. Ask Kady for a specific run’s status.</p> : null}
    {snapshot?.compute?.map((job) => <p key={job.id} className="text-xs">Compute: {job.label} · {job.state}</p>)}
    {selected && <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between"><h4 className="text-sm font-medium">{selected.label}</h4><Button size="sm" variant="ghost" onClick={() => setTranscriptRefresh((n) => n + 1)}>Refresh transcript</Button></div>
      <pre aria-label="Specialist transcript" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{transcript}</pre>
      <label className="block text-xs" htmlFor="specialist-message">Instructions for this specialist</label>
      <textarea id="specialist-message" value={message} maxLength={16000} onChange={(e) => setMessage(e.target.value)} className="min-h-20 w-full rounded border bg-background p-2 text-sm" />
      <div className="flex flex-wrap gap-2">
        {isActive ? <><Button size="sm" disabled={busy || !message.trim()} onClick={() => void action("steer", selected)}>Send guidance</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setStopping(selected)}>Stop specialist</Button></>
          : <Button size="sm" variant="outline" disabled={busy || !selectedNode || !message.trim()} onClick={() => void action("resume", selected)}>Resume with instructions</Button>}
      </div>
    </div>}
    {stopping && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">Stop {stopping.label}{stopping.index === undefined ? " and its children" : ""}?<Button size="sm" variant="destructive" disabled={busy} onClick={() => void action("stop", stopping)}>Confirm stop</Button><Button size="sm" variant="ghost" onClick={() => setStopping(null)}>Keep running</Button></div>}
  </section>;
}
