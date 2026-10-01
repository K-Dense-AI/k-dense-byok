"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/projects";
import { SettingsCard, SettingsError } from "./primitives";

type Installation = { packaged: boolean; projects?: string; helpers?: { status: string; detail: string }; releaseUrl?: string };

export function InstallationCard() {
  const [info, setInfo] = useState<Installation | null>(null);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [source, setSource] = useState("");
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    let active = true;
    const refresh = () => { if (!stopped) void apiFetch("/installation").then(r => r.ok ? r.json() : null).then(data => { if (active && data) setInfo(data); }).catch(() => {}); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [stopped]);
  if (!info?.packaged) return null;
  const install = async () => {
    setError("");
    try {
      const response = await apiFetch("/installation/helpers", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      setInfo({ ...info, helpers: data });
    } catch (e) { setError(String(e)); }
  };
  const stop = async () => {
    if (!await confirm({ title: "Stop Kady?", description: "Local agent work and schedules will stop. Remote compute jobs may continue; reopen Kady to recover them. Your projects and credentials will be kept.", confirmLabel: "Stop Kady", destructive: true })) return;
    try {
      const response = await apiFetch("/installation/stop", { method: "POST" });
      if (!response.ok) throw new Error("Could not stop Kady. Try the application shortcut again.");
      setStopped(true);
    } catch (e) { setError(String(e)); }
  };
  const importExisting = async () => {
    if (!await confirm({ title: "Use an existing installation?", description: "Close the other Kady installation first. Kady will use its projects in place, preserving their files, sessions and budgets. This will stop current local work; reopen Kady to switch. Existing credentials in this installation are kept.", confirmLabel: "Use existing projects", destructive: false })) return;
    setError("");
    try {
      const response = await apiFetch("/installation/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: source.trim() }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.detail);
      setStopped(true);
    } catch (e) { setError(String(e)); }
  };
  return <SettingsCard className="min-w-0" title="Installed application" description="Kady keeps running when you close the browser. Open the Kady application to return here.">
    {dialog}<SettingsError>{error}</SettingsError>
    {stopped ? <p className="text-xs">Kady is stopping. Open the Kady application to start it again.</p> : <div className="space-y-3 text-xs">
      <p className="break-all text-muted-foreground">Projects: {info.projects}</p>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="min-w-0 break-words">{info.helpers?.detail}</p>
        <Button size="sm" variant="outline" disabled={info.helpers?.status === "installing" || info.helpers?.status === "ready"} onClick={() => void install()}>{info.helpers?.status === "installing" ? "Installing…" : info.helpers?.status === "error" ? "Retry setup" : info.helpers?.status === "ready" ? "Installed" : "Install scientific previews"}</Button>
      </div>
      <p className="text-muted-foreground">Python and preview tools download during setup. The Office editor downloads verified components when first opened. LaTeX compilation uses an optional TeX installation.</p>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 basis-64" aria-label="Existing Kady installation folder" placeholder="Full path to an existing Kady installation" value={source} onChange={event => setSource(event.target.value)} />
        <Button size="sm" variant="outline" disabled={!source.trim()} onClick={() => void importExisting()}>Use existing projects</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void apiFetch("/installation/logs").then(r => r.text()).then(setLogs).catch(e => setError(String(e)))}>View logs</Button>
        <Button size="sm" variant="outline" asChild><a href={info.releaseUrl} target="_blank" rel="noreferrer">Download updates</a></Button>
        <Button size="sm" variant="outline" onClick={() => void stop()}>Stop Kady</Button>
      </div>
      {logs !== null && <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-[10px]">{logs}</pre>}
    </div>}
  </SettingsCard>;
}
