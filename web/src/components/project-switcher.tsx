"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  LayoutGridIcon,
  PlusIcon,
  SettingsIcon,
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
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { DEFAULT_PROJECT_ID, type Project } from "@/lib/projects";
import { openSettings } from "@/lib/settings-nav";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";

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
    update,
    remove,
  } = useProjects();

  const { confirm, dialog } = useConfirm();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createName, setCreateName] = useState<string | null>(null);

  const { visibleProjects, archivedProjects } = useMemo(() => {
    const visible: Project[] = [];
    const archived: Project[] = [];
    for (const p of projects) {
      (p.archived ? archived : visible).push(p);
    }
    return { visibleProjects: visible, archivedProjects: archived };
  }, [projects]);

  const openCreate = useCallback((initialName = "") => {
    setCreateName(initialName);
    setPopoverOpen(false);
  }, []);

  // Editing lives in Settings → Project, aimed at the row's project.
  const openEdit = useCallback((project: Project) => {
    setPopoverOpen(false);
    openSettings({ tab: "project", projectId: project.id });
  }, []);

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
    if (!popoverOpen) setSearch("");
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

      <ProjectCreateDialog
        open={createName !== null}
        initialName={createName ?? ""}
        onOpenChange={(open) => {
          if (!open) setCreateName(null);
        }}
        onCreated={(project) => setActive(project.id)}
      />
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
      <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Project settings"
          aria-label={`Settings for ${project.name}`}
          onClick={(ev) => {
            ev.stopPropagation();
            onEdit();
          }}
        >
          <SettingsIcon className="size-3" />
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
