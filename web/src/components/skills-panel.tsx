"use client";

import { useCallback, useEffect, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import {
  getAllSkills,
  setSkillEnabled,
  type SkillInfo,
  type SkillProblem,
} from "@/lib/capabilities";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

interface Row extends SkillInfo {
  enabled: boolean;
}

export function SkillsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<SkillProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { enabled, disabled, problems: found } = await getAllSkills();
      const merged: Row[] = [
        ...enabled.map((s) => ({ ...s, enabled: true })),
        ...disabled.map((s) => ({ ...s, enabled: false })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      setRows(merged);
      // Skills that failed to parse are absent from both lists above; without
      // this the only symptom is a skill missing from the catalogue.
      setProblems(found.filter((p) => !p.loaded));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load skills");
    } finally {
      setLoading(false);
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

  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(query.toLowerCase()) ||
      r.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Scientific skills the agent can activate. Enabled skills are discovered
          automatically; disabling one hides it from the agent for new chat tabs.
          Per project (current:{" "}
          <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
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
          {filtered.map((r) => (
            <div key={r.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{r.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{r.description}</div>
              </div>
              <Switch
                aria-label={`Toggle ${r.name}`}
                checked={r.enabled}
                onCheckedChange={(v) => void toggle(r.name, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
