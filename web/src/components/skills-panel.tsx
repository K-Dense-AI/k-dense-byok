"use client";

import { useCallback, useEffect, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import {
  EMPTY_SKILL_SYNC_STATUS,
  getAllSkills,
  setSkillEnabled,
  syncSkills,
  updateSkillFromUpstream,
  type SkillInfo,
  type SkillProblem,
  type SkillSyncStatus,
} from "@/lib/capabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

interface Row extends SkillInfo {
  enabled: boolean;
}

export function SkillsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<SkillProblem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SkillSyncStatus>(
    EMPTY_SKILL_SYNC_STATUS,
  );
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const { enabled, disabled, problems: found, sync } = await getAllSkills();
      const merged: Row[] = [
        ...enabled.map((s) => ({ ...s, enabled: true })),
        ...disabled.map((s) => ({ ...s, enabled: false })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      setRows(merged);
      setSyncStatus(sync ?? EMPTY_SKILL_SYNC_STATUS);
      // Skills that failed to parse are absent from both lists above; without
      // this the only symptom is a skill missing from the catalogue.
      setProblems(found.filter((p) => !p.loaded));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load skills");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeProjectId]);

  const toggle = useCallback(
    async (name: string, next: boolean) => {
      // optimistic
      setRows((rs) => rs.map((r) => (r.name === name ? { ...r, enabled: next } : r)));
      try {
        await setSkillEnabled(name, next);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Toggle failed");
        void load(); // reconcile on failure
      }
    },
    [load],
  );

  const refresh = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      await syncSkills();
      await load(false);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Skill synchronization failed");
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const replaceWithUpstream = useCallback(
    async (name: string) => {
      if (
        !window.confirm(
          `Replace the local ${name} skill with the current upstream version? Local edits to this skill will be lost.`,
        )
      ) {
        return;
      }
      setUpdating(name);
      setError(null);
      try {
        await updateSkillFromUpstream(name);
        await load(false);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : `Failed to update ${name}`);
      } finally {
        setUpdating(null);
      }
    },
    [load],
  );

  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      r.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Skills</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Scientific skills the agent can activate. The upstream catalogue syncs
            daily without overwriting local edits. Disabling a skill hides it from the
            agent for new chat tabs. Per project (current:{" "}
            <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>).
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          disabled={syncing}
          onClick={() => void refresh()}
        >
          {syncing ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          Refresh now
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {(syncStatus.lastCheckedAt || syncStatus.updatesAvailable.length > 0) && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {syncStatus.lastCheckedAt && (
              <span className="text-muted-foreground">
                Last synced {new Date(syncStatus.lastCheckedAt).toLocaleString()}
              </span>
            )}
            {syncStatus.updatesAvailable.length > 0 && (
              <Badge variant="outline" className="text-[10px] text-amber-600">
                {syncStatus.updatesAvailable.length} local{" "}
                {syncStatus.updatesAvailable.length === 1 ? "edit needs" : "edits need"}{" "}
                review
              </Badge>
            )}
          </div>
          {syncStatus.lastResult &&
            (syncStatus.lastResult.added > 0 ||
              syncStatus.lastResult.updated > 0 ||
              syncStatus.lastResult.archived > 0) && (
              <p className="mt-1 text-muted-foreground">
                Last refresh: {syncStatus.lastResult.added} added,{" "}
                {syncStatus.lastResult.updated} updated,{" "}
                {syncStatus.lastResult.archived} archived.
              </p>
            )}
        </div>
      )}

      {problems.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="font-medium">
            {problems.length === 1
              ? "1 installed skill could not be loaded"
              : `${problems.length} installed skills could not be loaded`}
          </div>
          <p className="mt-1 text-muted-foreground">
            These are on disk but their SKILL.md failed to parse, so they are hidden from the
            list below and from the agent. Fix the frontmatter and reopen this tab.
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {problems.map((p) => (
              <li key={`${p.state}/${p.name}`}>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground"> — {p.message.split("\n")[0]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Input
        value={query}
        placeholder="Search skills…"
        className="h-8 text-xs"
        onChange={(e) => setQuery(e.target.value)}
      />

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {rows.length === 0
            ? "No skills installed for this project yet. They are seeded on first launch — run npm run prep in server/ if this project was created before seeding."
            : "No skills match."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((r) => {
            const updateAvailable = syncStatus.updatesAvailable.includes(r.name);
            const orphaned = syncStatus.orphaned.includes(r.name);
            const customized = syncStatus.customized.includes(r.name);
            return (
              <div
                key={r.name}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span>{r.name}</span>
                    {updateAvailable ? (
                      <Badge variant="outline" className="h-5 text-[10px] text-amber-600">
                        Update available
                      </Badge>
                    ) : orphaned ? (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        Removed upstream
                      </Badge>
                    ) : customized ? (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        Customized
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {r.description}
                  </div>
                </div>
                {updateAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    aria-label={`Use upstream version of ${r.name}`}
                    disabled={updating === r.name}
                    onClick={() => void replaceWithUpstream(r.name)}
                  >
                    {updating === r.name && (
                      <Loader2Icon className="size-3 animate-spin" />
                    )}
                    Use upstream
                  </Button>
                )}
                <Switch
                  aria-label={`Toggle ${r.name}`}
                  checked={r.enabled}
                  onCheckedChange={(v) => void toggle(r.name, v)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
