"use client";

import { FileTreePanel } from "@/components/sandbox-panel";
import { FilePreviewPanel, SettingsDialog, WorkflowsPanel } from "@/components/lazy-surfaces";
import type { Model } from "@/components/model-selector";
import { ChatTab, type ChatTabHandle, type ChatTabMeta } from "@/components/chat-tab";
import { ChatTabsBar, type ChatTabDescriptor } from "@/components/chat-tabs-bar";
import { ProjectSwitcher } from "@/components/project-switcher";
import { ProjectView } from "@/components/project-view";
import { SessionCostPill } from "@/components/session-cost-pill";
import { ResourceMonitor } from "@/components/resource-monitor";
import { useSessionCost } from "@/lib/use-session-cost";
import { useProjectCost } from "@/lib/use-project-cost";
import { useProjectActivities } from "@/lib/use-project-activities";
import { useModalJobs } from "@/lib/use-modal-jobs";
import { useProjects } from "@/lib/use-projects";
import { APP_VERSION, isVersioned, useUpdateCheck } from "@/lib/version";
import { useSkills } from "@/lib/use-skills";
import { flattenFiles, useSandbox } from "@/lib/use-sandbox";
import { ProjectScopeProvider } from "@/lib/projects";
import {
  hasProjectActivity,
  sameProjectActivity,
  summarizeProjectActivity,
  type ProjectActivitySummary,
} from "@/lib/project-activity";
import { onChatPrefill } from "@/lib/chat-prefill";
import {
  OPEN_MODAL_JOB_EVENT,
  type ModalComputeScope,
} from "@/lib/modal-jobs";
import { isJunkFilePath } from "@/lib/utils";
import {
  PanelLeftIcon,
  PanelRightIcon,
  SettingsIcon,
  ServerCogIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  deletePersistedChatState,
  loadWorkspaceSnapshot,
  pruneDeletedProjectState,
  revokeSnapshotObjectUrls,
  saveProjectWorkspaceState,
  saveWorkspaceShellState,
  type ChatWorkspaceState,
  type ProjectWorkspaceState,
  type SandboxWorkspaceState,
  type WorkspaceScreen,
} from "@/lib/workspace-persistence";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const MAX_CHAT_TABS = 10;

interface ChatTabEntry {
  id: string;
  title: string;
  /** Stored session reopened into this tab (History menu), if any. */
  sessionId?: string;
}

/** Stable id for the first tab so SSR and hydration match. */
const INITIAL_TAB_ID = "tab-initial";

function makeTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTabTitle(index: number): string {
  return `Chat ${index + 1}`;
}

// Thin vertical drag handle between two panels
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border hover:bg-blue-400 active:bg-blue-500 transition-colors"
      onMouseDown={onMouseDown}
    >
      <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 group-hover:bg-blue-400 transition-colors" />
    </div>
  );
}

export default function HomePage() {
  const [screen, setScreen] = useState<WorkspaceScreen>("projects");
  const [openedProjectIds, setOpenedProjectIds] = useState<string[]>([]);
  const [restoredProjects, setRestoredProjects] = useState<
    Record<string, ProjectWorkspaceState>
  >({});
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [projectDirectoryHydrated, setProjectDirectoryHydrated] = useState(false);
  const [projectActivities, setProjectActivities] = useState<
    Record<string, ProjectActivitySummary>
  >({});
  const {
    activeProjectId,
    projects,
    loading: projectsLoading,
    error: projectsError,
  } = useProjects();
  const serverProjectActivities = useProjectActivities(
    workspaceHydrated && screen === "projects",
  );
  const displayedProjectActivities = useMemo(
    () => ({ ...serverProjectActivities, ...projectActivities }),
    [projectActivities, serverProjectActivities],
  );

  useEffect(() => {
    if (!projectsLoading) setProjectDirectoryHydrated(true);
  }, [projectsLoading]);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceSnapshot().then((snapshot) => {
      if (cancelled) {
        // Nothing will consume (or revoke) the restored attachment blob URLs.
        revokeSnapshotObjectUrls(snapshot);
        return;
      }
      setRestoredProjects(snapshot.projects);
      // Always start in the project overview. A project's saved workspace is
      // restored lazily only after the user chooses that project.
      setWorkspaceHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rememberProject = useCallback((projectId: string) => {
    setOpenedProjectIds((prev) => (
      prev.includes(projectId) ? prev : [...prev, projectId]
    ));
  }, []);

  const openProject = useCallback((projectId: string) => {
    rememberProject(projectId);
    setScreen("workspace");
  }, [rememberProject]);

  const handleProjectActivityChange = useCallback(
    (projectId: string, activity: ProjectActivitySummary) => {
      setProjectActivities((prev) => {
        const existing = prev[projectId];
        if (!hasProjectActivity(activity)) {
          if (!existing) return prev;
          const next = { ...prev };
          delete next[projectId];
          return next;
        }
        if (sameProjectActivity(existing, activity)) return prev;
        return { ...prev, [projectId]: activity };
      });
    },
    [],
  );

  // ProjectSwitcher changes the global selection from inside the currently
  // visible workspace. Mount the destination workspace without unmounting the
  // source, so any live SSE stream in the source keeps running.
  useEffect(() => {
    if (workspaceHydrated && screen === "workspace") rememberProject(activeProjectId);
  }, [activeProjectId, rememberProject, screen, workspaceHydrated]);

  // A deleted project must release its mounted workspace and persisted shell
  // state. The DELETE endpoint explicitly aborts its server-owned runs first;
  // this unmount only disconnects browser-side event observers.
  useEffect(() => {
    if (projectsLoading || !workspaceHydrated) return;
    // A failed or empty list is not "every project was deleted". On a fetch
    // error `projects` keeps its initial [] with loading=false, and the server
    // always has at least the default project, so pruning against an empty
    // set would wipe every project's persisted workspace on a backend blip.
    if (projectsError || projects.length === 0) return;
    const existing = new Set(projects.map((project) => project.id));
    setOpenedProjectIds((prev) => {
      const next = prev.filter((id) => existing.has(id));
      return next.length === prev.length ? prev : next;
    });
    setProjectActivities((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => existing.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setRestoredProjects((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => existing.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    void pruneDeletedProjectState(existing);
  }, [projects, projectsError, projectsLoading, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceShellState(screen, openedProjectIds);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [openedProjectIds, screen, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const flush = () => {
      void saveWorkspaceShellState(screen, openedProjectIds);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [openedProjectIds, screen, workspaceHydrated]);

  return (
    <>
      <div
        className={screen === "projects" ? "contents" : "hidden"}
        aria-hidden={screen !== "projects"}
      >
        <ProjectView
          onOpenProject={openProject}
          projectActivities={displayedProjectActivities}
        />
      </div>
      {projectDirectoryHydrated && openedProjectIds.map((projectId) => {
        const isActive = screen === "workspace" && projectId === activeProjectId;
        return (
          <ProjectScopeProvider key={projectId} value={projectId}>
            <div className={isActive ? "contents" : "hidden"} aria-hidden={!isActive}>
              <WorkspacePage
                projectId={projectId}
                isActive={isActive}
                hydrated={workspaceHydrated}
                initialState={restoredProjects[projectId]}
                onProjectActivityChange={handleProjectActivityChange}
                onOpenProjectView={() => setScreen("projects")}
              />
            </div>
          </ProjectScopeProvider>
        );
      })}
    </>
  );
}

function WorkspacePage({
  projectId,
  isActive,
  hydrated,
  initialState,
  onProjectActivityChange,
  onOpenProjectView,
}: {
  projectId: string;
  isActive: boolean;
  hydrated: boolean;
  initialState?: ProjectWorkspaceState;
  onProjectActivityChange: (
    projectId: string,
    activity: ProjectActivitySummary,
  ) => void;
  onOpenProjectView: () => void;
}) {
  const [sandboxWorkspace, setSandboxWorkspace] = useState<SandboxWorkspaceState>(
    () => initialState?.sandbox ?? { openPaths: [], activePath: null },
  );
  const handleSandboxWorkspaceChange = useCallback((next: SandboxWorkspaceState) => {
    setSandboxWorkspace((current) =>
      current.activePath === next.activePath &&
      current.openPaths.length === next.openPaths.length &&
      current.openPaths.every((path, index) => path === next.openPaths[index])
        ? current
        : next,
    );
  }, []);
  const sandbox = useSandbox(
    isActive,
    undefined,
    initialState?.sandbox,
    handleSandboxWorkspaceChange,
  );
  const { updateAvailable } = useUpdateCheck();
  const { skills: allSkills, loading: skillsLoading } = useSkills();
  const { projects: projectDirectory } = useProjects();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(
    () => initialState?.sandboxOpen ?? true,
  );
  const [chatOpen, setChatOpen] = useState(
    () => initialState?.chatOpen ?? true,
  );
  const toggleSandbox = useCallback(() => setSandboxOpen((value) => !value), []);
  const toggleChat = useCallback(() => setChatOpen((value) => !value), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showNotebook, setShowNotebook] = useState(
    () => initialState?.showNotebook ?? false,
  );
  const [showCompute, setShowCompute] = useState(
    () => initialState?.showCompute ?? false,
  );
  const [computeScope, setComputeScope] = useState<ModalComputeScope>(
    () => initialState?.computeScope ?? "project",
  );

  // Chat tab management. We allocate the initial id once via useRef so it
  // stays stable across React's strict-mode double-invocation of
  // useState's lazy initializer (which would otherwise mint two different
  // ids — one for the tabs array and one for activeTabId).
  const initialTabId = INITIAL_TAB_ID;
  const [tabs, setTabs] = useState<ChatTabEntry[]>(() =>
    initialState?.tabs.length
      ? initialState.tabs.map(({ id, title, sessionId }) => ({ id, title, sessionId }))
      : [{ id: initialTabId, title: defaultTabTitle(0) }],
  );
  const [activeTabId, setActiveTabId] = useState<string>(
    () => initialState?.activeTabId ?? initialTabId,
  );
  const [view, setView] = useState<"chat" | "workflows">(
    () => initialState?.view ?? "chat",
  );
  const [tabWorkspaceStates, setTabWorkspaceStates] = useState<
    Record<string, ChatWorkspaceState>
  >(() =>
    Object.fromEntries(
      (initialState?.tabs ?? []).flatMap((tab) =>
        tab.chat ? [[tab.id, tab.chat] as const] : [],
      ),
    ),
  );
  // Mirror of tabs in a ref so synchronous handlers can read length without
  // putting impure logic inside a setState updater (which strict mode runs
  // twice for purity testing).
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Per-tab agent meta, populated by each <ChatTab> via onMetaChange. We
  // read from this to drive the cost pill and tab
  // strip badges (streaming spinner, message count) for the active tab.
  const [tabsMeta, setTabsMeta] = useState<Record<string, ChatTabMeta>>({});
  const tabHandles = useRef<Map<string, ChatTabHandle | null>>(new Map());
  // Stable per-tab ref callbacks so React doesn't repeatedly clear+set the
  // tab handle map on every render (inline `ref={(h) => ...}` would).
  const tabRefCallbacks = useRef<
    Map<string, (handle: ChatTabHandle | null) => void>
  >(new Map());
  const getTabRefCallback = useCallback(
    (id: string) => {
      let cb = tabRefCallbacks.current.get(id);
      if (!cb) {
        cb = (handle: ChatTabHandle | null) => {
          if (handle) tabHandles.current.set(id, handle);
          else tabHandles.current.delete(id);
        };
        tabRefCallbacks.current.set(id, cb);
      }
      return cb;
    },
    [],
  );

  // Bumped whenever any chat tab finishes a turn, so the cost pill (which
  // tracks the active tab's session) refetches.
  const [costRefreshKey, setCostRefreshKey] = useState(0);

  const handleMetaChange = useCallback(
    (tabId: string, meta: ChatTabMeta) => {
      if (meta.sessionId) {
        setTabs((current) => {
          if (!current.some((tab) => tab.id === tabId && tab.sessionId !== meta.sessionId)) {
            return current;
          }
          return current.map((tab) =>
            tab.id === tabId && tab.sessionId !== meta.sessionId
              ? { ...tab, sessionId: meta.sessionId ?? undefined }
              : tab,
          );
        });
      }
      setTabsMeta((prev) => {
        const existing = prev[tabId];
        // Token deltas stay local to ChatTab. Only workspace-visible state
        // crosses this boundary; notebook-only updates must still propagate.
        if (
          existing &&
          existing.sessionId === meta.sessionId &&
          existing.status === meta.status &&
          existing.runState === meta.runState &&
          existing.isStreaming === meta.isStreaming &&
          existing.userMessageCount === meta.userMessageCount &&
          existing.needsInput === meta.needsInput &&
          existing.notebookEntries === meta.notebookEntries &&
          existing.subagentCompletions === meta.subagentCompletions
        ) {
          return prev;
        }
        return { ...prev, [tabId]: meta };
      });
    },
    [],
  );

  const handleTabWorkspaceStateChange = useCallback(
    (tabId: string, state: ChatWorkspaceState) => {
      setTabWorkspaceStates((current) =>
        current[tabId] === state ? current : { ...current, [tabId]: state },
      );
    },
    [],
  );

  const handleTurnComplete = useCallback(() => {
    setCostRefreshKey((k) => k + 1);
  }, []);

  // Pull out the two sandbox functions we re-trigger on turn completion.
  // Destructuring keeps the deps stable below — useSandbox returns a new
  // object literal each render, so depending on `sandbox` directly would
  // make `handleSandboxRefresh` change identity every render.
  const {
    fetchTree: sandboxFetchTree,
    refreshOpenTabs: sandboxRefreshOpenTabs,
    selectFile: sandboxSelectFile,
  } = sandbox;
  const handleSandboxRefresh = useCallback(() => {
    sandboxFetchTree();
    sandboxRefreshOpenTabs();
  }, [sandboxFetchTree, sandboxRefreshOpenTabs]);

  useEffect(() => setMounted(true), []);

  // Drive sandbox polling cadence off the active tab's streaming state
  // (the live-poll mode used to be hard-wired to the single chat).
  const activeMeta = tabsMeta[activeTabId];
  const notebookEntries = activeMeta?.notebookEntries ?? [];
  const notebookStreaming = activeMeta?.isStreaming ?? false;
  const subagentCompletions = activeMeta?.subagentCompletions ?? 0;
  const anyStreaming = useMemo(
    () => Object.values(tabsMeta).some((m) => m.isStreaming),
    [tabsMeta],
  );
  // While any tab is streaming, poll the active sandbox more aggressively so
  // the file tree + open previews update as the agent writes files. Hidden
  // projects keep their SSE streams mounted but catch up when reopened.
  useEffect(() => {
    if (!isActive || !anyStreaming) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) await Promise.all([sandboxFetchTree(), sandboxRefreshOpenTabs()]);
      if (!cancelled) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [anyStreaming, isActive, sandboxFetchTree, sandboxRefreshOpenTabs]);

  const [treeWidth, setTreeWidth] = useState(
    () => initialState?.treeWidth ?? 320,
  );
  const [chatWidth, setChatWidth] = useState(
    () => initialState?.chatWidth ?? 640,
  );
  const [isResizing, setIsResizing] = useState(false);
  const dragging = useRef<"tree" | "chat" | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const startDrag = useCallback((panel: "tree" | "chat") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = panel;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panel === "tree" ? treeWidth : chatWidth;
    setIsResizing(true);
  }, [treeWidth, chatWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - dragStartX.current;
      if (dragging.current === "tree") {
        setTreeWidth(Math.max(150, Math.min(480, dragStartWidth.current + delta)));
      } else {
        setChatWidth(Math.max(280, Math.min(720, dragStartWidth.current - delta)));
      }
    };
    const onUp = () => {
      dragging.current = null;
      setIsResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const projectWorkspaceState = useMemo<ProjectWorkspaceState>(
    () => ({
      tabs: tabs.map((tab) => ({
        ...tab,
        ...(tabWorkspaceStates[tab.id]
          ? { chat: tabWorkspaceStates[tab.id] }
          : {}),
      })),
      activeTabId,
      view,
      showNotebook,
      showCompute,
      computeScope,
      sandboxOpen,
      chatOpen,
      treeWidth,
      chatWidth,
      sandbox: sandboxWorkspace,
    }),
    [
      activeTabId,
      chatOpen,
      chatWidth,
      computeScope,
      sandboxOpen,
      sandboxWorkspace,
      showCompute,
      showNotebook,
      tabWorkspaceStates,
      tabs,
      treeWidth,
      view,
    ],
  );
  const projectWorkspaceStateRef = useRef(projectWorkspaceState);
  projectWorkspaceStateRef.current = projectWorkspaceState;

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveProjectWorkspaceState(projectId, projectWorkspaceState);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [hydrated, projectId, projectWorkspaceState]);

  useEffect(() => {
    if (!hydrated) return;
    const flush = () => {
      void saveProjectWorkspaceState(projectId, projectWorkspaceStateRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [hydrated, projectId]);

  // Ask Kady handoff: the active tab's composer (mounted even behind the
  // Workflows view) appends the text; this listener makes it visible.
  useEffect(() => {
    if (!isActive) return;
    return onChatPrefill(() => setView("chat"));
  }, [isActive]);

  // Flat list of all sandbox file paths for @ mentions (shared across tabs).
  // Cache artifacts are excluded — mentioning __pycache__/*.pyc is never useful.
  const allFiles = useMemo(
    () => flattenFiles(sandbox.tree).filter((p) => !isJunkFilePath(p)),
    [sandbox.tree],
  );

  // ------------------------------------------------------------------
  // Tab management callbacks
  // ------------------------------------------------------------------

  const newTab = useCallback(() => {
    // Mint the id OUTSIDE any setState updater. Strict mode invokes
    // updaters twice for purity testing, which would otherwise produce
    // two different ids on a single click — the array would commit one
    // id while setActiveTabId got the other, leaving every tab with
    // isActive=false and display:none.
    if (tabsRef.current.length >= MAX_CHAT_TABS) return;
    const id = makeTabId();
    setTabs((prev) =>
      prev.length >= MAX_CHAT_TABS
        ? prev
        : [...prev, { id, title: defaultTabTitle(prev.length) }],
    );
    setActiveTabId(id);
    setView("chat");
  }, []);

  const closeTab = useCallback((id: string) => {
    // Abort an in-flight stream so the agent doesn't keep running into a
    // detached component. Safe to call on a non-streaming tab too.
    tabHandles.current.get(id)?.stop();
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((curr) => {
        if (curr !== id) return curr;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback?.id ?? next[0].id;
      });
      return next;
    });
    tabHandles.current.delete(id);
    tabRefCallbacks.current.delete(id);
    setTabsMeta((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    setTabWorkspaceStates((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    void deletePersistedChatState(projectId, id);
  }, [projectId]);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title } : t)),
    );
  }, []);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setView("chat");
  }, []);

  // A tab whose stored session no longer exists on disk: keep the tab, drop the
  // binding, so it stops being treated as that session (dedupe, History focus)
  // and stops re-requesting it on every reload.
  const forgetTabSession = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id || !t.sessionId) return t;
        const { sessionId: _dropped, ...rest } = t;
        void _dropped;
        return rest;
      }),
    );
  }, []);

  // Reopen a stored session (History menu). If some tab already holds that
  // session, just focus it — two tabs must never share one session.
  const openSession = useCallback(
    (sessionId: string, title: string) => {
      // Check the tab descriptors as well as reported meta: a restored or
      // just-opened tab carries its sessionId before its ChatTab has mounted
      // and reported meta, and matching on meta alone let the same session be
      // opened into a second tab.
      const openTabId =
        tabsRef.current.find((t) => t.sessionId === sessionId)?.id ??
        Object.entries(tabsMeta).find(([, meta]) => meta.sessionId === sessionId)?.[0];
      if (openTabId) {
        setActiveTabId(openTabId);
        setView("chat");
        return;
      }
      if (tabsRef.current.length >= MAX_CHAT_TABS) return;
      const id = makeTabId();
      setTabs((prev) =>
        prev.length >= MAX_CHAT_TABS ? prev : [...prev, { id, title, sessionId }],
      );
      setActiveTabId(id);
      setView("chat");
    },
    [tabsMeta],
  );

  // ------------------------------------------------------------------
  // Workflow launch — routes to the active chat tab via its imperative
  // handle and switches the view back to "chat".
  // ------------------------------------------------------------------

  const handleWorkflowLaunch = useCallback(
    async (prompt: string, model: Model, uploadedFiles: string[]) => {
      const handle = tabHandles.current.get(activeTabId);
      if (!handle) return;
      setView("chat");
      await handle.launchWorkflow(prompt, model, uploadedFiles);
    },
    [activeTabId],
  );

  const handleFileSelect = useCallback((path: string) => {
    sandboxSelectFile(path);
    setShowNotebook(false);
    setShowCompute(false);
  }, [sandboxSelectFile]);
  const handleOrganizeFiles = useCallback(() => {
    const handle = tabHandles.current.get(activeTabId);
    if (!handle) return;
    setView("chat");
    void handle.sendQuick("Organize all the files in the sandbox directory");
  }, [activeTabId]);

  // ------------------------------------------------------------------
  // Chat ↔ notebook deep links (join key: tool-call id === entry id).
  // ------------------------------------------------------------------
  const [notebookFocus, setNotebookFocus] = useState<{ id: string; token: number } | null>(null);
  const handleViewInNotebook = useCallback((entryId: string) => {
    setShowCompute(false);
    setShowNotebook(true);
    setNotebookFocus({ id: entryId, token: Date.now() });
  }, []);
  const [computeFocus, setComputeFocus] = useState<{ id: string; token: number } | null>(null);
  const handleViewCompute = useCallback((jobId?: string) => {
    setShowNotebook(false);
    setShowCompute(true);
    if (jobId) setComputeFocus({ id: jobId, token: Date.now() });
  }, []);
  useEffect(() => {
    if (!isActive) return;
    const onOpenJob = (event: Event) => {
      const jobId = (
        event as CustomEvent<{ jobId?: string }>
      ).detail?.jobId;
      handleViewCompute(jobId);
    };
    window.addEventListener(OPEN_MODAL_JOB_EVENT, onOpenJob);
    return () => window.removeEventListener(OPEN_MODAL_JOB_EVENT, onOpenJob);
  }, [handleViewCompute, isActive]);
  const handleNotebookJumpToChat = useCallback(
    (entryId: string) => {
      // Un-hide the chat column without toggling it closed, then scroll once
      // display:none has lifted (scrollIntoView no-ops on hidden elements).
      setChatOpen(true);
      setView("chat");
      setTimeout(() => {
        const ok = tabHandles.current.get(activeTabId)?.scrollToToolCall(entryId) ?? false;
        if (!ok) toast.error("Couldn't find this entry in the chat transcript.");
      }, 50);
    },
    [activeTabId],
  );

  // ------------------------------------------------------------------
  // Header pieces — cost pill — read from the active tab.
  // ------------------------------------------------------------------

  const activeSessionId = activeMeta?.sessionId ?? null;
  const {
    activeCount: activeModalJobCount,
    loading: modalJobsLoading,
  } = useModalJobs({ projectId, enabled: isActive, limit: 200 });

  // Async subagents are ledgered when the child finishes, which can be long
  // after the parent turn ended. Without this the pill under-reported spend
  // until the next turn.
  const totalSubagentCompletions = useMemo(
    () =>
      Object.values(tabsMeta).reduce(
        (sum, meta) => sum + (meta.subagentCompletions ?? 0),
        0,
      ),
    [tabsMeta],
  );
  useEffect(() => {
    if (totalSubagentCompletions === 0) return;
    setCostRefreshKey((k) => k + 1);
  }, [totalSubagentCompletions]);

  const { summary: costSummary, loading: costLoading } = useSessionCost(
    activeSessionId,
    costRefreshKey,
  );
  const { summary: projectCost, loading: projectCostLoading } =
    useProjectCost(costRefreshKey);
  const directorySpendLimit = projectDirectory.find(
    (project) => project.id === projectId,
  )?.spendLimitUsd;
  // Match the server's admission rule: it compares *committed* money (ledgered
  // + compute reservations + in-flight runs) against the cap, and treats a
  // non-positive limit as unlimited.
  const committedUsd = projectCost.budget.committedUsd ?? projectCost.budget.totalUsd;
  const budgetBlocked =
    directorySpendLimit === undefined
      ? projectCost.budget.state === "exceeded"
      : directorySpendLimit !== null &&
        directorySpendLimit > 0 &&
        committedUsd >= directorySpendLimit;
  const projectActivity = useMemo(
    () =>
      summarizeProjectActivity(
        Object.values(tabsMeta).map((meta) => ({
          isStreaming: meta.isStreaming,
          runState: meta.runState,
          needsInput: meta.needsInput,
        })),
        budgetBlocked,
      ),
    [budgetBlocked, tabsMeta],
  );

  useEffect(() => {
    onProjectActivityChange(projectId, projectActivity);
  }, [onProjectActivityChange, projectActivity, projectId]);

  const tabDescriptors: ChatTabDescriptor[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        title: t.title,
        isStreaming: tabsMeta[t.id]?.isStreaming ?? false,
        userMessageCount: tabsMeta[t.id]?.userMessageCount ?? 0,
      })),
    [tabs, tabsMeta],
  );

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenProjectView}
            aria-label="Back to projects"
            className="flex items-center gap-2"
          >
            {/* Plain <img> to avoid Next/Image's aspect-ratio warning when we
                set height via CSS and let width autosize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/kdense-logo.png"
              alt="K-Dense BYOK"
              className="h-7 w-auto object-contain dark:invert"
            />
            <span className="text-sm font-semibold tracking-tight text-foreground/80">BYOK</span>
          </button>
          {isVersioned && (
            <InfoTooltip
              content={
                <>
                  <b>K-Dense BYOK v{APP_VERSION}</b>
                  <br />
                  Bring-your-own-key research assistant. All API calls use keys from your{" "}
                  <kbd>.env</kbd> file and run on your machine.
                </>
              }
            >
              <span className="text-[11px] text-muted-foreground/60 cursor-help">
                v{APP_VERSION}
              </span>
            </InfoTooltip>
          )}
          {updateAvailable && (
            <InfoTooltip content="A newer version is available on GitHub. Click to open the release page.">
              <a
                href="https://github.com/K-Dense-AI/k-dense-byok"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-blue-500 hover:text-blue-400 transition-colors"
              >
                Update available
              </a>
            </InfoTooltip>
          )}
          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
          <ProjectSwitcher onOpenProjectView={onOpenProjectView} />
        </div>
        <p className="absolute left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/60 tracking-wide select-none">
          Brought to you by K-Dense, Inc.
        </p>
        <div className="flex items-center gap-2">
          {isActive && <ResourceMonitor />}
          <SessionCostPill
            summary={costSummary}
            projectSummary={projectCost}
            limitUsd={projectCost.limitUsd}
            loading={costLoading || projectCostLoading}
          />
          {activeModalJobCount > 0 ? (
            <InfoTooltip
              content={`${activeModalJobCount} Modal compute job${
                activeModalJobCount === 1 ? " is" : "s are"
              } still running. Open Compute to inspect live logs.`}
            >
              <button
                type="button"
                onClick={() => handleViewCompute()}
                aria-label={`Open Compute, ${activeModalJobCount} active jobs`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2 py-1.5 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-500/15 dark:text-violet-300"
              >
                <ServerCogIcon className="size-3.5" />
                <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
                {activeModalJobCount}
              </button>
            </InfoTooltip>
          ) : modalJobsLoading ? (
            <span className="sr-only" aria-live="polite">Checking compute jobs</span>
          ) : null}
          {/* Panel visibility — collapse either side panel to give the center
              pane (file preview / LaTeX editor) more room. */}
          <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
            <InfoTooltip
              content={
                <>
                  <b>{sandboxOpen ? "Hide" : "Show"} file browser</b>
                  <br />
                  Collapse the left file tree to widen the editor and preview.
                </>
              }
            >
              <button
                onClick={toggleSandbox}
                aria-label={sandboxOpen ? "Hide file browser" : "Show file browser"}
                aria-pressed={sandboxOpen}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  sandboxOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PanelLeftIcon className="size-4" />
              </button>
            </InfoTooltip>
            <InfoTooltip
              content={
                <>
                  <b>{chatOpen ? "Hide" : "Show"} chat</b>
                  <br />
                  Collapse the right chat panel to widen the editor and preview.
                </>
              }
            >
              <button
                onClick={toggleChat}
                aria-label={chatOpen ? "Hide chat" : "Show chat"}
                aria-pressed={chatOpen}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  chatOpen
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <PanelRightIcon className="size-4" />
              </button>
            </InfoTooltip>
          </div>
          <InfoTooltip
            content={
              <>
                <b>Settings</b>
                <br />
                Model providers, API keys, skills, specialists, connectors, and appearance.
              </>
            }
          >
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="size-4" />
            </button>
          </InfoTooltip>
          {mounted && (
            <InfoTooltip
              content={
                resolvedTheme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
            >
              <button
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                aria-label={
                  resolvedTheme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                }
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {resolvedTheme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              </button>
            </InfoTooltip>
          )}
        </div>
      </header>

      {/* Main content area — three columns: file tree | preview | chat */}
      <div className={cn("flex flex-1 overflow-hidden", isResizing && "select-none")}>

        {/* Left: file tree */}
        {isActive && sandboxOpen && (
          <div className="shrink-0 overflow-hidden" style={{ width: treeWidth }}>
            <FileTreePanel
              tree={sandbox.tree}
              selectedPath={sandbox.activeTabPath}
              uploading={sandbox.uploading}
              onSelect={handleFileSelect}
              onDownload={sandbox.downloadFile}
              onDelete={sandbox.deleteFile}
              onDownloadDir={sandbox.downloadDir}
              onDeleteDir={sandbox.deleteDir}
              onDownloadAll={sandbox.downloadAll}
              onRefresh={sandbox.fetchTree}
              onClose={toggleSandbox}
              onUpload={sandbox.uploadFiles}
              onOrganize={handleOrganizeFiles}
              onMove={sandbox.moveItem}
              onRename={sandbox.renameItem}
              onCreateDir={sandbox.createDir}
            />
          </div>
        )}

        {/* Drag handle: tree ↔ preview */}
        {isActive && sandboxOpen && <ResizeHandle onMouseDown={startDrag("tree")} />}

        {/* Middle: file preview with tabs — always shown; it is the pane the
            side panels make room for (e.g. the LaTeX editor + PDF). */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {isActive && (
            <FilePreviewPanel
              projectId={projectId}
              activeModelRef={tabWorkspaceStates[activeTabId]?.selectedModel.id}
              tabs={sandbox.tabs}
              activeTabPath={sandbox.activeTabPath}
              onTabSelect={handleFileSelect}
              onTabClose={sandbox.closeTab}
              onDownload={sandbox.downloadFile}
              onSaveText={sandbox.saveFile}
              onSaveImageBlob={sandbox.saveImageBlob}
              onRetry={sandbox.retryFile}
              onCompileLatex={sandbox.compileLatex}
              showNotebook={showNotebook}
              onSelectNotebook={() => {
                setShowCompute(false);
                setShowNotebook(true);
              }}
              showCompute={showCompute}
              onSelectCompute={() => {
                setShowNotebook(false);
                setShowCompute(true);
              }}
              computeSessionId={activeSessionId}
              computeScope={computeScope}
              onComputeScopeChange={setComputeScope}
              computeFocus={computeFocus}
              onOpenComputeOutput={handleFileSelect}
              notebookSessionId={activeSessionId}
              notebookEntries={notebookEntries}
              notebookStreaming={notebookStreaming}
              notebookSubagentCompletions={subagentCompletions}
              onOpenNotebookFile={handleFileSelect}
              notebookFocus={notebookFocus}
              onNotebookJumpToChat={handleNotebookJumpToChat}
              onOpenNotebookEntry={handleViewInNotebook}
            />
          )}
        </div>

        {/* Drag handle: preview ↔ chat */}
        {isActive && chatOpen && <ResizeHandle onMouseDown={startDrag("chat")} />}

        {/* Right: chat / workflows. Kept mounted (hidden via CSS when
            collapsed) so background chat streams keep running. */}
        <div
          className={cn(
            "flex flex-col border-l overflow-hidden shrink-0",
            !chatOpen && "hidden",
          )}
          style={{ width: chatWidth }}
        >

          <ChatTabsBar
            projectId={projectId}
            tabs={tabDescriptors}
            activeTabId={activeTabId}
            view={view}
            maxTabs={MAX_CHAT_TABS}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={newTab}
            onRename={renameTab}
            onSelectWorkflows={() => setView("workflows")}
            onOpenSession={openSession}
            activeSessionId={activeSessionId}
            canExport={(activeMeta?.userMessageCount ?? 0) > 0}
          />

          {/* Chat tabs — all kept mounted so background streams continue.
              Each ChatTab hides itself with `display: none` when inactive. */}
          {tabs.map((t) => (
            <ChatTab
              key={t.id}
              ref={getTabRefCallback(t.id)}
              projectId={projectId}
              tabId={t.id}
              initialSessionId={t.sessionId ?? null}
              initialWorkspaceState={tabWorkspaceStates[t.id]}
              isActive={isActive && view === "chat" && t.id === activeTabId}
              isActiveTab={isActive && t.id === activeTabId}
              allFiles={allFiles}
              sandboxReady={sandbox.tree !== null}
              uploadFiles={sandbox.uploadFiles}
              onSandboxRefresh={handleSandboxRefresh}
              onTurnComplete={handleTurnComplete}
              allSkills={allSkills}
              skillsReady={!skillsLoading}
              budgetState={projectCost.budget.state}
              budgetTotalUsd={projectCost.budget.totalUsd}
              budgetLimitUsd={projectCost.budget.limitUsd}
              onMetaChange={handleMetaChange}
              onWorkspaceStateChange={handleTabWorkspaceStateChange}
              onSessionUnavailable={forgetTabSession}
              onViewInNotebook={handleViewInNotebook}
              onViewCompute={handleViewCompute}
              onOpenFile={handleFileSelect}
            />
          ))}

          {/* Workflows view */}
          {isActive && view === "workflows" && (
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              <WorkflowsPanel
                onLaunch={handleWorkflowLaunch}
                onUploadFiles={sandbox.uploadFiles}
                budgetBlocked={projectCost.budget.state === "exceeded"}
              />
            </div>
          )}
        </div>

      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
