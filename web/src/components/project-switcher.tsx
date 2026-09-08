"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  LayoutGridIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_PROJECT_ID,
  getProjectCompaction,
  getProjectGuardPolicy,
  putProjectCompaction,
  putProjectGuardPolicy,
  type CompactionSettings,
  type GuardPolicy,
  type Project,
} from "@/lib/projects";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";

interface ProjectFormState {
  open: boolean;
  mode: "create" | "edit";
  id?: string;
  name: string;
  description: string;
  tags: string;
  // Empty string = no limit (unlimited). Stored as a string so the input
  // behaves naturally while the user is typing "0." / "1." etc.
  spendLimit: string;
  /** Context-compaction knobs (edit mode only; null until loaded). */
  compaction: CompactionFormState | null;
  /** Raw-data guard policy (edit mode only; null until loaded). */
  guard: GuardFormState | null;
}

interface GuardFormState {
  /** One glob per line. */
  protectedPaths: string;
  destructiveConfirm: boolean;
  initial: GuardPolicy;
}

interface CompactionFormState {
  enabled: boolean;
  reserveTokens: string;
  keepRecentTokens: string;
  /** Snapshot as loaded, to skip the PUT when nothing changed. */
  initial: CompactionSettings;
}

const EMPTY_FORM: ProjectFormState = {
  open: false,
  mode: "create",
  id: undefined,
  name: "",
  description: "",
  tags: "",
  spendLimit: "",
  compaction: null,
  guard: null,
};

/** Display a project ID in Title Case when we haven't loaded the project
 *  metadata yet (e.g. during the first render before `useProjects` resolves).
 *  Prevents a brief "default" flash before "Default" appears. */
function formatProjectId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

interface ProjectSwitcherProps {
  onOpenProjectView?: () => void;
}

export function ProjectSwitcher({ onOpenProjectView }: ProjectSwitcherProps) {
  const {
    projects,
    activeProjectId,
    activeProject,
    setActive,
    create,
    update,
    remove,
  } = useProjects();

  const { confirm, dialog } = useConfirm();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { visibleProjects, archivedProjects } = useMemo(() => {
    const visible: Project[] = [];
    const archived: Project[] = [];
    for (const p of projects) {
      (p.archived ? archived : visible).push(p);
    }
    return { visibleProjects: visible, archivedProjects: archived };
  }, [projects]);

  const openCreate = useCallback((initialName = "") => {
    setForm({ ...EMPTY_FORM, open: true, mode: "create", name: initialName });
    setFormError(null);
    setPopoverOpen(false);
  }, []);

  const openEdit = useCallback((project: Project) => {
    setForm({
      open: true,
      mode: "edit",
      id: project.id,
      name: project.name,
      description: project.description,
      tags: project.tags.join(", "),
      spendLimit:
        project.spendLimitUsd === null || project.spendLimitUsd === undefined
          ? ""
          : String(project.spendLimitUsd),
      compaction: null,
      guard: null,
    });
    setFormError(null);
    setPopoverOpen(false);
    void getProjectGuardPolicy(project.id)
      .then((policy) => {
        setForm((f) =>
          f.open && f.mode === "edit" && f.id === project.id
            ? {
                ...f,
                guard: {
                  protectedPaths: policy.protectedPaths.join("\n"),
                  destructiveConfirm: policy.destructiveConfirm,
                  initial: policy,
                },
              }
            : f,
        );
      })
      .catch(() => {
        /* section stays hidden */
      });
    // Loaded separately: it lives in the sandbox's Pi settings, not project.json.
    void getProjectCompaction(project.id)
      .then((settings) => {
        setForm((f) =>
          f.open && f.mode === "edit" && f.id === project.id
            ? {
                ...f,
                compaction: {
                  enabled: settings.enabled,
                  reserveTokens: String(settings.reserveTokens),
                  keepRecentTokens: String(settings.keepRecentTokens),
                  initial: settings,
                },
              }
            : f,
        );
      })
      .catch(() => {
        /* the section simply stays hidden */
      });
  }, []);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Name is required");
      return;
    }
    // Parse spend limit: empty string = clear to unlimited. Any non-numeric
    // or negative value is a user error.
    const trimmedLimit = form.spendLimit.trim();
    let spendLimitUsd: number | null = null;
    if (trimmedLimit !== "") {
      const parsed = Number(trimmedLimit);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setFormError("Spend limit must be a non-negative number (or empty)");
        return;
      }
      spendLimitUsd = parsed;
    }
    setSubmitting(true);
    try {
      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (form.mode === "create") {
        const project = await create({
          name: form.name.trim(),
          description: form.description.trim(),
          tags,
          spendLimitUsd,
        });
        setActive(project.id);
      } else if (form.id) {
        await update(form.id, {
          name: form.name.trim(),
          description: form.description.trim(),
          tags,
          spendLimitUsd,
        });
        const compaction = form.compaction;
        if (compaction) {
          const reserveTokens = Number(compaction.reserveTokens);
          const keepRecentTokens = Number(compaction.keepRecentTokens);
          if (!Number.isInteger(reserveTokens) || !Number.isInteger(keepRecentTokens)) {
            throw new Error("Compaction token counts must be whole numbers");
          }
          const changed =
            compaction.enabled !== compaction.initial.enabled ||
            reserveTokens !== compaction.initial.reserveTokens ||
            keepRecentTokens !== compaction.initial.keepRecentTokens;
          if (changed) {
            await putProjectCompaction(form.id, {
              enabled: compaction.enabled,
              reserveTokens,
              keepRecentTokens,
            });
          }
        }
        const guard = form.guard;
        if (guard) {
          const protectedPaths = guard.protectedPaths
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const changed =
            guard.destructiveConfirm !== guard.initial.destructiveConfirm ||
            protectedPaths.join("\n") !== guard.initial.protectedPaths.join("\n");
          if (changed) {
            await putProjectGuardPolicy(form.id, {
              protectedPaths,
              destructiveConfirm: guard.destructiveConfirm,
            });
          }
        }
      }
      setForm(EMPTY_FORM);
    } catch (exc) {
      setFormError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }, [form, create, update, setActive]);

  const handleToggleArchive = useCallback(
    async (project: Project) => {
      try {
        await update(project.id, { archived: !project.archived });
      } catch {
        // swallow -- surfaces through list reload; no toast yet
      }
    },
    [update]
  );

  const handleDelete = useCallback(
    async (project: Project) => {
      if (project.id === DEFAULT_PROJECT_ID) return;
      const confirmed = await confirm({
        title: `Delete "${project.name}"?`,
        description:
          "Its sandbox files and chats will be permanently removed. This cannot be undone.",
        confirmLabel: "Delete project",
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await remove(project.id);
      } catch {
        // swallow
      }
    },
    [confirm, remove]
  );

  useEffect(() => {
    if (!popoverOpen) {
      setFormError(null);
      setSearch("");
    }
  }, [popoverOpen]);

  return (
    <>
      {dialog}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <InfoTooltip
          disabled={popoverOpen}
          content={
            <>
              <b>Project: {activeProject?.name ?? formatProjectId(activeProjectId)}</b>
              <br />
              Projects isolate sandbox files and chat history. Switch projects
              to work on a different experiment without crosstalk.
            </>
          }
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Switch project"
              className="h-7 gap-1.5 px-2 text-xs font-medium text-foreground/80 hover:text-foreground"
            >
              <FolderIcon className="size-3.5" />
              <span className="max-w-[140px] truncate">
                {activeProject?.name ?? formatProjectId(activeProjectId)}
              </span>
              <ChevronsUpDownIcon className="size-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
        </InfoTooltip>
        <PopoverContent align="start" className="w-[320px] p-0">
          <Command>
            <CommandInput
              placeholder="Search or name a new project…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {/* The create row below always matches (its value tracks the
                  query), so the empty state is just a never-shown fallback. */}
              <CommandEmpty>No projects found.</CommandEmpty>
              {visibleProjects.length > 0 && (
                <CommandGroup heading="Projects">
                  {visibleProjects.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      active={project.id === activeProjectId}
                      onSelect={() => {
                        setActive(project.id);
                        setPopoverOpen(false);
                      }}
                      onEdit={() => openEdit(project)}
                      onArchive={() => handleToggleArchive(project)}
                      onDelete={() => handleDelete(project)}
                    />
                  ))}
                </CommandGroup>
              )}
              {archivedProjects.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Archived">
                    {archivedProjects.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        active={project.id === activeProjectId}
                        archivedList
                        onSelect={() => {
                          setActive(project.id);
                          setPopoverOpen(false);
                        }}
                        onEdit={() => openEdit(project)}
                        onArchive={() => handleToggleArchive(project)}
                        onDelete={() => handleDelete(project)}
                      />
                    ))}
                  </CommandGroup>
                </>
              )}
              <CommandSeparator />
              <CommandGroup>
                {onOpenProjectView && (
                  <CommandItem
                    value="__view_all_projects__"
                    onSelect={() => {
                      setPopoverOpen(false);
                      onOpenProjectView();
                    }}
                    className="gap-2 text-foreground"
                  >
                    <LayoutGridIcon className="size-4" />
                    View all projects
                  </CommandItem>
                )}
                <CommandItem
                  // Value tracks the live query so cmdk never filters this row
                  // out — typing a brand-new name keeps "Create …" reachable
                  // instead of dead-ending at "No projects found".
                  value={`__create__ ${search}`}
                  onSelect={() => openCreate(search.trim())}
                  className="gap-2 text-foreground"
                >
                  <PlusIcon className="size-4" />
                  {search.trim() ? (
                    <span className="truncate">
                      Create “<span className="font-medium">{search.trim()}</span>”
                    </span>
                  ) : (
                    "New project…"
                  )}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog
        open={form.open}
        onOpenChange={(open) => (open ? null : setForm(EMPTY_FORM))}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.mode === "create" ? "New project" : "Edit project"}
            </DialogTitle>
            <DialogDescription>
              Each project has its own sandbox and chat history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Name
              </label>
              <Input
                autoFocus
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="RNA-seq pilot"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Description
              </label>
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Optional one-line summary."
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Tags <span className="opacity-50">(comma separated)</span>
              </label>
              <Input
                value={form.tags}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tags: e.target.value }))
                }
                placeholder="genomics, proteomics"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Spend limit <span className="opacity-50">(USD, optional)</span>
              </label>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.spendLimit}
                onChange={(e) =>
                  setForm((f) => ({ ...f, spendLimit: e.target.value }))
                }
                placeholder="Leave empty for no limit"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Cumulative cost across every session. New runs are blocked once
                the total reaches this cap; a warning shows at 80%.
              </p>
            </div>
            {form.mode === "edit" && form.guard && (
              <fieldset className="rounded-md border p-3" data-testid="guard-settings">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Raw-data guard
                </legend>
                <label className="text-[11px] text-muted-foreground">
                  Protected paths (one glob per line; the agent can read but never modify them)
                  <Textarea
                    rows={3}
                    value={form.guard.protectedPaths}
                    onChange={(e) =>
                      setForm((f) =>
                        f.guard ? { ...f, guard: { ...f.guard, protectedPaths: e.target.value } } : f,
                      )
                    }
                    placeholder={"user_data/**\nraw/*.csv"}
                    aria-label="Protected paths"
                    className="mt-1 font-mono text-xs"
                  />
                </label>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs">Ask before destructive shell commands elsewhere</span>
                  <Switch
                    checked={form.guard.destructiveConfirm}
                    onCheckedChange={(destructiveConfirm) =>
                      setForm((f) =>
                        f.guard ? { ...f, guard: { ...f.guard, destructiveConfirm } } : f,
                      )
                    }
                    aria-label="Confirm destructive commands"
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Applies to Kady and to background specialists, in live chats too. A
                  heuristic guard, not a security boundary: see the docs.
                </p>
              </fieldset>
            )}
            {form.mode === "edit" && form.compaction && (
              <fieldset className="rounded-md border p-3" data-testid="compaction-settings">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Context compaction
                </legend>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">Compact automatically near the context limit</span>
                  <Switch
                    checked={form.compaction.enabled}
                    onCheckedChange={(enabled) =>
                      setForm((f) =>
                        f.compaction ? { ...f, compaction: { ...f.compaction, enabled } } : f,
                      )
                    }
                    aria-label="Automatic compaction"
                  />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-muted-foreground">
                    Reserve for the reply (tokens)
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={4000}
                      max={64000}
                      step={1000}
                      value={form.compaction.reserveTokens}
                      onChange={(e) =>
                        setForm((f) =>
                          f.compaction
                            ? { ...f, compaction: { ...f.compaction, reserveTokens: e.target.value } }
                            : f,
                        )
                      }
                      aria-label="Reserve tokens"
                    />
                  </label>
                  <label className="text-[11px] text-muted-foreground">
                    Keep recent verbatim (tokens)
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={5000}
                      max={200000}
                      step={1000}
                      value={form.compaction.keepRecentTokens}
                      onChange={(e) =>
                        setForm((f) =>
                          f.compaction
                            ? { ...f, compaction: { ...f.compaction, keepRecentTokens: e.target.value } }
                            : f,
                        )
                      }
                      aria-label="Keep recent tokens"
                    />
                  </label>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Compaction summarizes older messages when the conversation nears the
                  model&apos;s window. Kady puts its own state block (plan, notebook,
                  results, environment) ahead of the summary. Applies to every chat in
                  this project.
                </p>
              </fieldset>
            )}
            {formError && (
              <p className="text-xs text-destructive">{formError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setForm(EMPTY_FORM)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? "Saving…"
                : form.mode === "create"
                  ? "Create project"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ProjectRowProps {
  project: Project;
  active: boolean;
  archivedList?: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function ProjectRow({
  project,
  active,
  archivedList,
  onSelect,
  onEdit,
  onArchive,
  onDelete,
}: ProjectRowProps) {
  return (
    <CommandItem
      // cmdk filters by `value`; we include the name, id, tags, and
      // description so the search input matches broadly.
      value={`${project.name} ${project.id} ${project.tags.join(" ")} ${project.description}`}
      onSelect={onSelect}
      className={cn("group flex items-center gap-2", archivedList && "opacity-70")}
    >
      <CheckIcon
        className={cn(
          "size-3.5 shrink-0 text-primary",
          active ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{project.name}</span>
        {project.description && (
          <span className="truncate text-[11px] text-muted-foreground">
            {project.description}
          </span>
        )}
      </div>
      <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Edit"
          onClick={(ev) => {
            ev.stopPropagation();
            onEdit();
          }}
        >
          <PencilIcon className="size-3" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={project.archived ? "Unarchive" : "Archive"}
          onClick={(ev) => {
            ev.stopPropagation();
            onArchive();
          }}
        >
          {project.archived ? (
            <ArchiveRestoreIcon className="size-3" />
          ) : (
            <ArchiveIcon className="size-3" />
          )}
        </button>
        {project.id !== DEFAULT_PROJECT_ID && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete project"
            onClick={(ev) => {
              ev.stopPropagation();
              onDelete();
            }}
          >
            <Trash2Icon className="size-3" />
          </button>
        )}
      </div>
    </CommandItem>
  );
}
