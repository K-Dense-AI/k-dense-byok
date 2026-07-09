"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  MoreHorizontalIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
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
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_PROJECT_ID, type Project } from "@/lib/projects";
import { useProjects } from "@/lib/use-projects";
import { APP_VERSION, isVersioned } from "@/lib/version";

interface ProjectViewProps {
  onOpenProject: (projectId: string) => void;
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
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}

export function ProjectView({ onOpenProject }: ProjectViewProps) {
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
      visibleProjects: matching.filter((project) => !project.archived),
      archivedProjects: matching.filter((project) => project.archived),
    };
  }, [projects, search]);

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

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-12 lg:py-16">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
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

        <InputGroup className="max-w-md bg-background">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search projects"
            placeholder="Search projects…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>

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
          <div className="flex flex-col gap-10">
            <ProjectSection
              title="Projects"
              projects={visibleProjects}
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
                activeProjectId={activeProjectId}
                onOpen={handleOpen}
                onEdit={openEdit}
                onToggleArchive={handleToggleArchive}
                onDelete={handleDelete}
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
  activeProjectId: string;
  emptyMessage?: string;
  onOpen: (projectId: string) => void;
  onEdit: (project: Project) => void;
  onToggleArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
}

function ProjectSection({
  title,
  projects,
  activeProjectId,
  emptyMessage,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete,
}: ProjectSectionProps) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${title}-heading`}>
      <div className="flex items-center gap-3">
        <h2
          id={`${title}-heading`}
          className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {title}
        </h2>
        <span className="text-xs text-muted-foreground/60">
          {projects.length}
        </span>
      </div>

      {projects.length === 0 ? (
        <Card className="border-dashed bg-background/50">
          <CardContent className="text-sm text-muted-foreground">
            {emptyMessage ?? "No projects."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              active={project.id === activeProjectId}
              onOpen={() => onOpen(project.id)}
              onEdit={() => onEdit(project)}
              onToggleArchive={() => onToggleArchive(project)}
              onDelete={() => onDelete(project)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface ProjectCardProps {
  project: Project;
  active: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

function ProjectCard({
  project,
  active,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete,
}: ProjectCardProps) {
  return (
    <Card className="gap-4 bg-background transition-shadow hover:shadow-md">
      <CardHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <FolderIcon className="size-5" />
        </div>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{project.name}</span>
          {active && <Badge variant="secondary">Current</Badge>}
        </CardTitle>
        <CardDescription className="line-clamp-2 min-h-10">
          {project.description || "No description yet."}
        </CardDescription>
        <CardAction>
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

      <CardContent className="flex min-h-6 flex-wrap gap-1.5">
        {project.tags.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline">
            {tag}
          </Badge>
        ))}
        {project.tags.length > 3 && (
          <Badge variant="outline">+{project.tags.length - 3}</Badge>
        )}
      </CardContent>

      <CardFooter className="justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">
          {projectActivityLabel(project)}
        </span>
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open
        </Button>
      </CardFooter>
    </Card>
  );
}
