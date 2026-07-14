"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SettingsDialog } from "@/components/settings-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_PROJECT_ID, type Project } from "@/lib/projects";
import type { ProjectActivitySummary } from "@/lib/project-activity";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";
import { APP_VERSION, isVersioned } from "@/lib/version";

interface ProjectViewProps {
  onOpenProject: (projectId: string) => void;
  projectActivities?: Readonly<Record<string, ProjectActivitySummary>>;
}

interface ProjectFormState {
  open: boolean;
  mode: "create" | "edit";
  id?: string;
  name: string;
  description: string;
  tags: string;
  spendLimit: string;
}

type ProjectSort = "recent" | "name" | "status";

const EMPTY_FORM: ProjectFormState = {
  open: false,
  mode: "create",
  name: "",
  description: "",
  tags: "",
  spendLimit: "",
};

function projectActivityLabel(project: Project): string {
  const value = project.updatedAt || project.createdAt;
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "No recent activity";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const then = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round(
    (today.getTime() - then.getTime()) / 86_400_000,
  );
  if (dayDifference === 0) return "Updated today";
  if (dayDifference === 1) return "Updated yesterday";
  if (dayDifference > 1 && dayDifference < 7) {
    return `Updated ${dayDifference} days ago`;
  }
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}

function projectActivityPriority(
  activity: ProjectActivitySummary | undefined,
): number {
  if (!activity) return 0;
  if (activity.needsInput > 0) return 5;
  if (activity.errors > 0) return 4;
  if (activity.blocked > 0) return 3;
  if (activity.running > 0) return 2;
  if (activity.done > 0) return 1;
  return 0;
}

function projectTimestamp(project: Project): number {
  const timestamp = Date.parse(project.updatedAt || project.createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function sortProjects(
  projects: Project[],
  sort: ProjectSort,
  activities: Readonly<Record<string, ProjectActivitySummary>>,
): Project[] {
  return [...projects].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "status") {
      const priority =
        projectActivityPriority(activities[b.id]) -
        projectActivityPriority(activities[a.id]);
      if (priority !== 0) return priority;
    }
    return projectTimestamp(b) - projectTimestamp(a);
  });
}

function projectBudgetLabel(limit: number): string {
  return `${new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: limit % 1 === 0 ? 0 : 2,
  }).format(limit)} budget`;
}

export function ProjectView({
  onOpenProject,
  projectActivities = {},
}: ProjectViewProps) {
  const {
    projects,
    activeProjectId,
    loading,
    error,
    setActive,
    refresh,
    create,
    update,
    remove,
  } = useProjects();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setMounted(true), []);

  const { visibleProjects, archivedProjects } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = query
      ? projects.filter((project) =>
          [
            project.name,
            project.description,
            project.id,
            ...project.tags,
          ].some((value) => value.toLowerCase().includes(query)),
        )
      : projects;
    return {
      visibleProjects: sortProjects(
        matching.filter((project) => !project.archived),
        sort,
        projectActivities,
      ),
      archivedProjects: sortProjects(
        matching.filter((project) => project.archived),
        sort,
        projectActivities,
      ),
    };
  }, [projectActivities, projects, search, sort]);
  const showArchived = archivedOpen || search.trim().length > 0;

  const openCreate = useCallback(() => {
    setForm({ ...EMPTY_FORM, open: true });
    setFormError(null);
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
    });
    setFormError(null);
  }, []);

  const closeForm = useCallback(() => {
    if (submitting) return;
    setForm(EMPTY_FORM);
    setFormError(null);
  }, [submitting]);

  const handleOpen = useCallback(
    (projectId: string) => {
      setActive(projectId);
      onOpenProject(projectId);
    },
    [onOpenProject, setActive],
  );

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    const name = form.name.trim();
    if (!name) {
      setFormError("Name is required");
      return;
    }

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

    const tags = form.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      if (form.mode === "create") {
        const project = await create({
          name,
          description: form.description.trim(),
          tags,
          spendLimitUsd,
        });
        setForm(EMPTY_FORM);
        handleOpen(project.id);
      } else if (form.id) {
        await update(form.id, {
          name,
          description: form.description.trim(),
          tags,
          spendLimitUsd,
        });
        setForm(EMPTY_FORM);
      }
    } catch (exc) {
      setFormError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }, [create, form, handleOpen, update]);

  const handleToggleArchive = useCallback(
    async (project: Project) => {
      try {
        await update(project.id, { archived: !project.archived });
      } catch (exc) {
        toast.error(
          exc instanceof Error ? exc.message : "Could not update project",
        );
      }
    },
    [update],
  );

  const handleDelete = useCallback(
    async (project: Project) => {
      if (project.id === DEFAULT_PROJECT_ID) return;
      const confirmed = window.confirm(
        `Delete project "${project.name}"? Its sandbox and chats will be permanently removed. This cannot be undone.`,
      );
      if (!confirmed) return;
      try {
        await remove(project.id);
      } catch (exc) {
        toast.error(
          exc instanceof Error ? exc.message : "Could not delete project",
        );
      }
    },
    [remove],
  );

  return (
    <div className="flex min-h-dvh flex-col bg-muted/20">
      <header className="flex items-center justify-between border-b bg-background/90 px-6 py-3 backdrop-blur">
        <a
          href="https://www.k-dense.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/kdense-logo.png"
            alt="K-Dense BYOK"
            className="h-7 w-auto object-contain dark:invert"
          />
          <span className="text-sm font-semibold tracking-tight text-foreground/80">
            BYOK
          </span>
          {isVersioned && (
            <span className="text-[11px] text-muted-foreground/60">
              v{APP_VERSION}
            </span>
          )}
        </a>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </Button>
          {mounted && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                resolvedTheme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:py-10">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <p className="text-sm font-medium text-muted-foreground">
              Kady research workspace
            </p>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Choose a project
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground md:text-base">
              Each project keeps its files, chats, notebook, and research
              settings separate.
            </p>
          </div>
          <Button onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New project
          </Button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <InputGroup className="max-w-sm bg-background">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search projects"
              placeholder="Search projects…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear project search"
                  onClick={() => setSearch("")}
                >
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Select
            value={sort}
            onValueChange={(value) => setSort(value as ProjectSort)}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Sort projects">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectItem value="recent">Recent activity</SelectItem>
                <SelectItem value="name">Project name</SelectItem>
                <SelectItem value="status">Needs attention</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Projects could not be loaded</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading projects…
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            <ProjectSection
              title="Projects"
              projects={visibleProjects}
              projectActivities={projectActivities}
              activeProjectId={activeProjectId}
              onOpen={handleOpen}
              onEdit={openEdit}
              onToggleArchive={handleToggleArchive}
              onDelete={handleDelete}
              emptyMessage={
                search.trim()
                  ? "No active projects match your search."
                  : "Create your first project to start researching."
              }
            />

            {archivedProjects.length > 0 && (
              <ProjectSection
                title="Archived"
                projects={archivedProjects}
                projectActivities={projectActivities}
                activeProjectId={activeProjectId}
                onOpen={handleOpen}
                onEdit={openEdit}
                onToggleArchive={handleToggleArchive}
                onDelete={handleDelete}
                collapsible
                open={showArchived}
                onOpenChange={setArchivedOpen}
              />
            )}
          </div>
        )}
      </main>

      <footer className="border-t px-6 py-4 text-center text-xs text-muted-foreground">
        All project data stays on this machine.
      </footer>

      <Dialog open={form.open} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.mode === "create" ? "New project" : "Edit project"}
            </DialogTitle>
            <DialogDescription>
              Each project has its own sandbox and chat history.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Name
              <Input
                autoFocus
                aria-invalid={Boolean(formError && !form.name.trim())}
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="RNA-seq pilot"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Description
              <Textarea
                rows={3}
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="Optional one-line summary."
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Tags <span className="opacity-60">(comma separated)</span>
              <Input
                value={form.tags}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    tags: event.target.value,
                  }))
                }
                placeholder="genomics, proteomics"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Spend limit <span className="opacity-60">(USD, optional)</span>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.spendLimit}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    spendLimit: event.target.value,
                  }))
                }
                placeholder="Leave empty for no limit"
              />
            </label>
            {formError && (
              <p role="alert" className="text-xs text-destructive">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeForm} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting && <Spinner data-icon="inline-start" />}
              {submitting
                ? "Saving…"
                : form.mode === "create"
                  ? "Create project"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

interface ProjectSectionProps {
  title: string;
  projects: Project[];
  projectActivities: Readonly<Record<string, ProjectActivitySummary>>;
  activeProjectId: string;
  emptyMessage?: string;
  onOpen: (projectId: string) => void;
  onEdit: (project: Project) => void;
  onToggleArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
  collapsible?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ProjectSection({
  title,
  projects,
  projectActivities,
  activeProjectId,
  emptyMessage,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete,
  collapsible = false,
  open = true,
  onOpenChange,
}: ProjectSectionProps) {
  const content =
    projects.length === 0 ? (
      <Card className="border-dashed bg-background/50">
        <CardContent className="text-sm text-muted-foreground">
          {emptyMessage ?? "No projects."}
        </CardContent>
      </Card>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            activity={projectActivities[project.id]}
            active={project.id === activeProjectId}
            onOpen={() => onOpen(project.id)}
            onEdit={() => onEdit(project)}
            onToggleArchive={() => onToggleArchive(project)}
            onDelete={() => onDelete(project)}
          />
        ))}
      </div>
    );

  if (collapsible) {
    return (
      <section aria-labelledby={`${title}-heading`}>
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <h2 id={`${title}-heading`}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group -ml-3 text-muted-foreground"
                aria-label={`${open ? "Hide" : "Show"} archived projects (${projects.length})`}
              >
                <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {title}
                </span>
                <Badge variant="secondary">{projects.length}</Badge>
              </Button>
            </CollapsibleTrigger>
          </h2>
          <CollapsibleContent className="pt-3">{content}</CollapsibleContent>
        </Collapsible>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${title}-heading`}>
      <div className="flex items-center gap-3">
        <h2
          id={`${title}-heading`}
          className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {title}
        </h2>
        <span className="text-xs text-muted-foreground/60">{projects.length}</span>
      </div>
      {content}
    </section>
  );
}

interface ProjectCardProps {
  project: Project;
  activity?: ProjectActivitySummary;
  active: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

function ProjectCard({
  project,
  activity,
  active,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete,
}: ProjectCardProps) {
  const hasAttention = Boolean(
    activity &&
      (activity.needsInput > 0 || activity.errors > 0 || activity.blocked > 0),
  );
  const isRunning = Boolean(activity && activity.running > 0);
  const isDone = Boolean(
    activity &&
      !hasAttention &&
      !isRunning &&
      activity.done > 0,
  );
  const visibleTagLimit = project.spendLimitUsd == null ? 3 : 2;

  return (
    <Card
      className={cn(
        "group/card relative gap-3 overflow-hidden bg-background py-4 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md",
        activity?.errors ? "border-red-500/50" : "",
        !activity?.errors && activity?.needsInput ? "border-amber-500/50" : "",
        !activity?.errors && !activity?.needsInput && activity?.blocked
          ? "border-orange-500/50"
          : "",
        !hasAttention && isRunning ? "border-blue-500/50" : "",
        isDone ? "border-emerald-500/50" : "",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`Open project ${project.name}`}
        onClick={onOpen}
      />
      <CardHeader className="pointer-events-none gap-1.5 px-4">
        <div className="mb-1 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover/card:text-foreground">
          <FolderIcon className="size-4" />
        </div>
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate">{project.name}</span>
          {active && <Badge variant="secondary">Current</Badge>}
        </CardTitle>
        <CardDescription className="line-clamp-2 min-h-8 text-xs leading-relaxed">
          {project.description || "No description yet."}
        </CardDescription>
        {activity && (
          <ProjectActivityBadges activity={activity} />
        )}
        <CardAction className="pointer-events-auto relative z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Project actions for ${project.name}`}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilIcon />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onToggleArchive}>
                  {project.archived ? (
                    <ArchiveRestoreIcon />
                  ) : (
                    <ArchiveIcon />
                  )}
                  {project.archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                {project.id !== DEFAULT_PROJECT_ID && (
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      {(project.tags.length > 0 || project.spendLimitUsd != null) && (
        <CardContent className="pointer-events-none flex min-h-5 flex-wrap gap-1 px-4">
          {project.spendLimitUsd != null && (
            <Badge variant="secondary">
              {projectBudgetLabel(project.spendLimitUsd)}
            </Badge>
          )}
          {project.tags.slice(0, visibleTagLimit).map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          {project.tags.length > visibleTagLimit && (
            <Badge variant="outline">
              +{project.tags.length - visibleTagLimit}
            </Badge>
          )}
        </CardContent>
      )}

      <CardFooter className="pointer-events-none mt-auto justify-between gap-3 px-4">
        <span className="truncate text-xs text-muted-foreground">
          {projectActivityLabel(project)}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover/card:text-foreground">
          Open
          <ArrowUpRightIcon className="size-3.5 transition-transform group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5" />
        </span>
      </CardFooter>
    </Card>
  );
}

function ProjectActivityBadges({
  activity,
}: {
  activity: ProjectActivitySummary;
}) {
  const activeOrAttention =
    activity.running > 0 ||
    activity.needsInput > 0 ||
    activity.errors > 0 ||
    activity.blocked > 0;
  const items = [
    activity.needsInput > 0
      ? {
          key: "input",
          label:
            activity.needsInput === 1
              ? "Needs your input"
              : `${activity.needsInput} need your input`,
          className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          dot: "bg-amber-500 animate-pulse",
        }
      : null,
    activity.errors > 0
      ? {
          key: "error",
          label: activity.errors === 1 ? "Error" : `${activity.errors} errors`,
          className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
          dot: "bg-red-500",
        }
      : null,
    activity.blocked > 0
      ? {
          key: "blocked",
          label: activity.blocked === 1 ? "Blocked" : `${activity.blocked} blocked`,
          className: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
          dot: "bg-orange-500",
        }
      : null,
    activity.running > 0
      ? {
          key: "running",
          label: activity.running === 1 ? "Running" : `${activity.running} running`,
          className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
          dot: "bg-blue-500 animate-pulse",
        }
      : null,
    !activeOrAttention && activity.done > 0
      ? {
          key: "done",
          label: "Done",
          className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          dot: "bg-emerald-500",
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Project activity">
      {items.map((item) => (
        <Badge
          key={item.key}
          variant="outline"
          className={cn("gap-1.5", item.className)}
        >
          <span className={cn("size-1.5 rounded-full", item.dot)} aria-hidden />
          {item.label}
        </Badge>
      ))}
    </div>
  );
}
