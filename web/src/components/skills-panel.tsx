"use client";

/**
 * Settings → Skills.
 *
 * Three kinds of skill live side by side and the row badges say which is which:
 * the K-Dense catalogue (synced daily, non-destructively), skills the user
 * installed from any source the `skills` CLI understands, and skills written
 * here. Only catalogue skills auto-update; the others are checked on request.
 *
 * Scope switches between this project's sandbox and the user-level dir shared by
 * every project.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import {
  checkSkillUpdate,
  createSkill,
  EMPTY_SKILL_SYNC_STATUS,
  getAllSkills,
  getSkillSource,
  installSkills,
  previewSkillSource,
  removeSkill,
  saveSkillSource,
  setSkillEnabled,
  syncSkills,
  updateSkillFromUpstream,
  type PreviewedSkill,
  type SkillInfo,
  type SkillOrigin,
  type SkillProblem,
  type SkillScope,
  type SkillSourcePreview,
  type SkillSyncStatus,
} from "@/lib/capabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  DownloadIcon,
} from "lucide-react";

interface Row extends SkillInfo {
  enabled: boolean;
}

const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  catalogue: "K-Dense",
  registry: "Installed",
  local: "Local",
};

type Pane = "none" | "install" | "create" | "edit";

export function SkillsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [scope, setScope] = useState<SkillScope>("project");
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<SkillProblem[]>([]);
  const [shadowed, setShadowed] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<SkillSyncStatus>(
    EMPTY_SKILL_SYNC_STATUS,
  );
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>("none");

  // Install pane
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<SkillSourcePreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Create pane
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  // Edit pane
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const load = useCallback(
    async (nextScope: SkillScope, showLoading = true) => {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const listing = await getAllSkills(nextScope);
        const merged: Row[] = [
          ...listing.enabled.map((s) => ({ ...s, enabled: true })),
          ...listing.disabled.map((s) => ({ ...s, enabled: false })),
        ].sort((a, b) => a.name.localeCompare(b.name));
        setRows(merged);
        setShadowed(listing.shadowed);
        setSyncStatus(listing.sync ?? EMPTY_SKILL_SYNC_STATUS);
        // Skills that failed to parse are absent from both lists above; without
        // this the only symptom is a skill missing from the catalogue.
        setProblems(listing.problems.filter((p) => !p.loaded));
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Failed to load skills");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(scope);
  }, [load, scope, activeProjectId]);

  const run = useCallback(
    async (key: string, work: () => Promise<string | void>) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const message = await work();
        if (message) setNotice(message);
        await load(scope, false);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Operation failed");
      } finally {
        setBusy(null);
      }
    },
    [load, scope],
  );

  const toggle = useCallback(
    async (name: string, next: boolean) => {
      setRows((rs) => rs.map((r) => (r.name === name ? { ...r, enabled: next } : r)));
      try {
        await setSkillEnabled(name, next, scope);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Toggle failed");
        void load(scope, false); // reconcile on failure
      }
    },
    [load, scope],
  );

  const refresh = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      await syncSkills();
      await load(scope, false);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Skill synchronization failed");
    } finally {
      setSyncing(false);
    }
  }, [load, scope]);

  const closePanes = useCallback(() => {
    setPane("none");
    setPreview(null);
    setPicked(new Set());
    setAcknowledged(false);
    setEditing(null);
    setEditContent("");
    // Clear the source too. A leftover value in a reopened form invites typing
    // into the middle of the previous one and fetching a mangled hybrid.
    setSource("");
    setRef("");
  }, []);

  const doPreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const result = await previewSkillSource({
        source: source.trim(),
        ref: ref.trim() || undefined,
        scope,
      });
      setPreview(result);
      // Preselect what isn't already here; re-installing an existing skill
      // should be a deliberate choice, not the default.
      setPicked(new Set(result.skills.filter((s) => !s.installed).map((s) => s.name)));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not read that source");
    } finally {
      setPreviewing(false);
    }
  }, [ref, scope, source]);

  const doInstall = useCallback(async () => {
    if (!preview) return;
    const names = [...picked];
    const replacing = preview.skills.some((s) => s.installed && picked.has(s.name));
    await run("install", async () => {
      const result = await installSkills({
        source: preview.source,
        ref: preview.ref,
        names,
        scope,
        stagingToken: preview.stagingToken,
        replace: replacing,
        acknowledged: true,
      });
      closePanes();
      const parts = [`Installed ${result.installed.length} skill${result.installed.length === 1 ? "" : "s"}`];
      if (result.conflicts.length > 0) {
        parts.push(`skipped ${result.conflicts.join(", ")} (already installed)`);
      }
      return `${parts.join("; ")}. New chat tabs pick them up.`;
    });
  }, [closePanes, picked, preview, run, scope]);

  const doCreate = useCallback(async () => {
    const name = newName.trim().toLowerCase();
    await run("create", async () => {
      await createSkill({ name, description: newDescription.trim() || undefined, scope });
      setNewName("");
      setNewDescription("");
      closePanes();
      // Drop straight into the editor: a template on its own does nothing.
      setEditing(name);
      setPane("edit");
      setEditLoading(true);
      try {
        setEditContent(await getSkillSource(name, scope));
      } finally {
        setEditLoading(false);
      }
      return `Created ${name}.`;
    });
  }, [closePanes, newDescription, newName, run, scope]);

  const openEditor = useCallback(
    async (name: string) => {
      setPane("edit");
      setEditing(name);
      setEditLoading(true);
      setError(null);
      try {
        setEditContent(await getSkillSource(name, scope));
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Could not read that skill");
      } finally {
        setEditLoading(false);
      }
    },
    [scope],
  );

  const saveEditor = useCallback(async () => {
    if (!editing) return;
    await run("save", async () => {
      await saveSkillSource(editing, editContent, scope);
      const name = editing;
      closePanes();
      return `Saved ${name}.`;
    });
  }, [closePanes, editContent, editing, run, scope]);

  const doRemove = useCallback(
    async (row: Row) => {
      const origin = row.origin ?? "catalogue";
      const consequence =
        origin === "catalogue"
          ? `"${row.name}" will be archived and kept out of future catalogue syncs.`
          : `"${row.name}" will be deleted.`;
      const ok = await confirm({
        title: origin === "catalogue" ? "Archive skill?" : "Delete skill?",
        description: consequence,
        confirmLabel: origin === "catalogue" ? "Archive" : "Delete",
        destructive: true,
      });
      if (!ok) return;
      await run(`remove:${row.name}`, async () => {
        const result = await removeSkill(row.name, scope);
        return result.disposition === "archived"
          ? `Archived ${result.name} (kept in .pi/skills-archived).`
          : `Deleted ${result.name}.`;
      });
    },
    [confirm, run, scope],
  );

  const doCheckUpdate = useCallback(
    async (name: string) => {
      await run(`check:${name}`, async () => {
        const result = await checkSkillUpdate(name, scope);
        return result.updateAvailable
          ? `${name} has an update available.`
          : `${name} is up to date.`;
      });
    },
    [run, scope],
  );

  const replaceWithUpstream = useCallback(
    async (row: Row) => {
      const origin = row.origin ?? "catalogue";
      const where = origin === "catalogue" ? "the current upstream version" : row.source;
      const ok = await confirm({
        title: `Replace "${row.name}"?`,
        description: `This replaces the local skill with ${where}. Local edits to this skill will be lost.`,
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!ok) return;
      await run(`update:${row.name}`, async () => {
        await updateSkillFromUpstream(row.name, scope);
        return `Updated ${row.name}.`;
      });
    },
    [confirm, run, scope],
  );

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.name.toLowerCase().includes(query.toLowerCase()) ||
          r.description.toLowerCase().includes(query.toLowerCase()),
      ),
    [query, rows],
  );

  const shadowedSet = useMemo(() => new Set(shadowed), [shadowed]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {confirmDialog}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Skills</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Skills the agent can activate. The K-Dense catalogue syncs daily without
            overwriting local edits; skills you install or write are left alone until
            you ask. Disabling one hides it from the agent for new chat tabs.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              closePanes();
              setPane(pane === "install" ? "none" : "install");
            }}
          >
            <PlusIcon className="size-3.5" />
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              closePanes();
              setPane(pane === "create" ? "none" : "create");
            }}
          >
            New skill
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={syncing || scope === "global"}
            title={
              scope === "global"
                ? "The catalogue is per project; switch to this project to sync it."
                : undefined
            }
            onClick={() => void refresh()}
          >
            {syncing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Scope */}
      <div className="flex items-center gap-1 rounded-lg border p-1 text-xs">
        {(
          [
            ["project", `This project (${activeProject?.name ?? activeProjectId})`],
            ["global", "All projects"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={cn(
              "flex-1 rounded-md px-2 py-1.5 transition-colors",
              scope === value
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50",
            )}
            aria-pressed={scope === value}
            onClick={() => {
              closePanes();
              setScope(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {scope === "global" && (
        <p className="text-[11px] text-muted-foreground">
          Stored in your Kady Pi agent directory: available to every project and to
          subagents. A project skill of the same name takes precedence.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">{notice}</div>
      )}

      {/* Install from a source */}
      {pane === "install" && (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="text-xs font-medium">Add skills from a source</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={source}
              placeholder="owner/repo, a git URL, or a local path"
              className="h-8 flex-1 text-xs"
              onChange={(e) => setSource(e.target.value)}
            />
            <Input
              value={ref}
              placeholder="branch / tag (optional)"
              className="h-8 text-xs sm:w-44"
              onChange={(e) => setRef(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!source.trim() || previewing}
              onClick={() => void doPreview()}
            >
              {previewing ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              Look up
            </Button>
          </div>

          {previewing && (
            <p className="text-[11px] text-muted-foreground">
              Downloading the source to see what it contains…
            </p>
          )}

          {preview && (
            <>
              <div className="text-[11px] text-muted-foreground">
                {preview.skills.length} skill{preview.skills.length === 1 ? "" : "s"} in{" "}
                <span className="font-medium">{preview.source}</span>
                {preview.ref ? ` (${preview.ref})` : ""}
              </div>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {preview.skills.map((s: PreviewedSkill) => (
                  <label
                    key={s.name}
                    className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={picked.has(s.name)}
                      aria-label={`Select ${s.name}`}
                      onChange={(e) => {
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.name);
                          else next.delete(s.name);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                        {s.name}
                        {s.installed && (
                          <Badge variant="outline" className="h-5 text-[10px]">
                            Already installed — will be replaced
                          </Badge>
                        )}
                        {s.conflictsWith === "project" && (
                          <Badge variant="outline" className="h-5 text-[10px]">
                            A project skill of this name takes precedence
                          </Badge>
                        )}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {s.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {preview.problems.length > 0 && (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                  {preview.problems.length} skill
                  {preview.problems.length === 1 ? "" : "s"} in this source could not be
                  parsed and cannot be installed.
                </div>
              )}

              <label className="flex items-start gap-2 text-[11px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  aria-label="Trust this source"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>
                  I trust <span className="font-medium">{preview.source}</span>. Skills are
                  instructions the agent follows, and they run with its full permissions.
                </span>
              </label>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={picked.size === 0 || !acknowledged || busy === "install"}
                  onClick={() => void doInstall()}
                >
                  {busy === "install" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
                  Install {picked.size > 0 ? `${picked.size} ` : ""}
                  {picked.size === 1 ? "skill" : "skills"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={closePanes}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Author a new skill */}
      {pane === "create" && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="text-xs font-medium">New skill</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newName}
              placeholder="skill-name (lowercase, hyphens)"
              className="h-8 text-xs sm:w-56"
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              value={newDescription}
              placeholder="What it does and when to use it"
              className="h-8 flex-1 text-xs"
              onChange={(e) => setNewDescription(e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            The description is what the model matches against when deciding whether to
            activate a skill, so make it specific.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={!newName.trim() || busy === "create"}
              onClick={() => void doCreate()}
            >
              {busy === "create" && <Loader2Icon className="size-3.5 animate-spin" />}
              Create and edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={closePanes}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Edit SKILL.md */}
      {pane === "edit" && editing && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="text-xs font-medium">Editing {editing}/SKILL.md</div>
          {editLoading ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : (
            <Textarea
              value={editContent}
              spellCheck={false}
              className="min-h-64 font-mono text-[11px]"
              aria-label={`SKILL.md for ${editing}`}
              onChange={(e) => setEditContent(e.target.value)}
            />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={busy === "save" || editLoading}
              onClick={() => void saveEditor()}
            >
              {busy === "save" && <Loader2Icon className="size-3.5 animate-spin" />}
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={closePanes}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {scope === "project" &&
        (syncStatus.lastCheckedAt || syncStatus.updatesAvailable.length > 0) && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {syncStatus.lastCheckedAt && (
                <span className="text-muted-foreground">
                  Last synced {new Date(syncStatus.lastCheckedAt).toLocaleString()}
                </span>
              )}
              {syncStatus.updatesAvailable.length > 0 && (
                <Badge variant="outline" className="text-[10px] text-amber-600">
                  {syncStatus.updatesAvailable.length}{" "}
                  {syncStatus.updatesAvailable.length === 1 ? "skill needs" : "skills need"}{" "}
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
            ? scope === "global"
              ? "No skills installed for all projects yet. Use Add or New skill above."
              : "No skills installed for this project yet. They are seeded on first launch — run npm run prep in server/ if this project was created before seeding."
            : "No skills match."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((r) => {
            const origin = r.origin ?? "catalogue";
            const updateAvailable = syncStatus.updatesAvailable.includes(r.name);
            const orphaned = syncStatus.orphaned.includes(r.name);
            const customized = syncStatus.customized.includes(r.name);
            const rowBusy = busy?.endsWith(`:${r.name}`) ?? false;
            return (
              <div
                key={r.name}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                    <span>{r.name}</span>
                    <Badge variant="secondary" className="h-5 text-[10px]">
                      {ORIGIN_LABEL[origin]}
                    </Badge>
                    {updateAvailable ? (
                      <Badge variant="outline" className="h-5 text-[10px] text-amber-600">
                        Update available
                      </Badge>
                    ) : orphaned ? (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        Removed upstream
                      </Badge>
                    ) : origin === "catalogue" && customized ? (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        Customized
                      </Badge>
                    ) : null}
                    {shadowedSet.has(r.name) && (
                      <Badge variant="outline" className="h-5 text-[10px]">
                        {scope === "global"
                          ? "Shadowed by a project skill"
                          : "Also installed for all projects"}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {r.description}
                  </div>
                  {r.source && origin === "registry" && (
                    <div className="truncate text-[10px] text-muted-foreground/80">
                      {r.source}
                      {r.ref ? `#${r.ref}` : ""}
                    </div>
                  )}
                </div>

                {updateAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    aria-label={`Use upstream version of ${r.name}`}
                    disabled={rowBusy}
                    onClick={() => void replaceWithUpstream(r)}
                  >
                    {busy === `update:${r.name}` && (
                      <Loader2Icon className="size-3 animate-spin" />
                    )}
                    Use upstream
                  </Button>
                )}
                {origin === "registry" && !updateAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    aria-label={`Check ${r.name} for updates`}
                    disabled={rowBusy}
                    onClick={() => void doCheckUpdate(r.name)}
                  >
                    {busy === `check:${r.name}` ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Edit ${r.name}`}
                  onClick={() => void openEditor(r.name)}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${r.name}`}
                  disabled={rowBusy}
                  onClick={() => void doRemove(r)}
                >
                  {busy === `remove:${r.name}` ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                </Button>
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
