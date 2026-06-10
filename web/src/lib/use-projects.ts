"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  DEFAULT_PROJECT_ID,
  Project,
  ProjectCreateInput,
  ProjectPatchInput,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  getActiveProjectId,
  initProjectSandbox as apiInitSandbox,
  listProjects as apiListProjects,
  onProjectChange,
  patchProject as apiPatchProject,
  setActiveProjectId,
} from "@/lib/projects";

interface ProjectsContextValue {
  projects: Project[];
  activeProjectId: string;
  activeProject: Project | null;
  loading: boolean;
  error: string | null;
  setActive: (id: string) => void;
  refresh: () => Promise<void>;
  create: (input: ProjectCreateInput) => Promise<Project>;
  update: (id: string, input: ProjectPatchInput) => Promise<Project>;
  remove: (id: string) => Promise<void>;
  initSandbox: (
    id: string,
    opts?: { sync_venv?: boolean; download_skills?: boolean }
  ) => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string>(
    DEFAULT_PROJECT_ID
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = getActiveProjectId();
    setActiveProjectIdState(current);
    // Re-persist to sync the cookie (used by <img>/<a> backend URLs that
    // can't carry custom headers). No-op if already matching.
    setActiveProjectId(current);
    const unsub = onProjectChange((id) => setActiveProjectIdState(id));
    return unsub;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiListProjects();
      setProjects(list);
      // If the active project was deleted elsewhere (or we're fresh on a
      // machine that doesn't have it yet), fall back to the default.
      const current = getActiveProjectId();
      if (list.length > 0 && !list.some((p) => p.id === current)) {
        setActiveProjectId(DEFAULT_PROJECT_ID);
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActive = useCallback((id: string) => {
    setActiveProjectId(id);
  }, []);

  const create = useCallback(
    async (input: ProjectCreateInput) => {
      const project = await apiCreateProject(input);
      // Seed the new project's sandbox (scientific skills + Python venv) so
      // they're ready immediately. Best-effort: a failed seed shouldn't block
      // project creation — the user can re-trigger it from the sandbox UI.
      try {
        await apiInitSandbox(project.id, { download_skills: true, sync_venv: true });
      } catch {
        /* non-fatal: skills can be seeded later */
      }
      await refresh();
      return project;
    },
    [refresh]
  );

  const update = useCallback(
    async (id: string, input: ProjectPatchInput) => {
      const project = await apiPatchProject(id, input);
      await refresh();
      return project;
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await apiDeleteProject(id);
      if (getActiveProjectId() === id) {
        setActiveProjectId(DEFAULT_PROJECT_ID);
      }
      await refresh();
    },
    [refresh]
  );

  const initSandbox = useCallback(
    async (
      id: string,
      opts?: { sync_venv?: boolean; download_skills?: boolean }
    ) => {
      await apiInitSandbox(id, opts);
    },
    []
  );

  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? null;

  const value = useMemo<ProjectsContextValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      loading,
      error,
      setActive,
      refresh,
      create,
      update,
      remove,
      initSandbox,
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      loading,
      error,
      setActive,
      refresh,
      create,
      update,
      remove,
      initSandbox,
    ]
  );

  return createElement(ProjectsContext.Provider, { value }, children);
}

export function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error("useProjects must be used within a ProjectProvider");
  }
  return ctx;
}
