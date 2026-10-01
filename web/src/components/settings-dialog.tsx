"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import {
  BotIcon,
  BrainCircuitIcon,
  CloudIcon,
  FolderCogIcon,
  KeyIcon,
  LayersIcon,
  PaletteIcon,
  PlugIcon,
  SlashIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notifyCapabilitiesChanged } from "@/lib/capability-events";
import { useProjectScopeId } from "@/lib/projects";
import {
  normalizeSettingsTab,
  readLastSettingsTab,
  writeLastSettingsTab,
  type OpenSettingsRequest,
  type SettingsTab,
} from "@/lib/settings-nav";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";
import { AppearancePanel } from "./settings/appearance-panel";
import { FusionPanel } from "./settings/fusion-panel";
import { useResizableDialog } from "./settings/use-resizable-dialog";

const panelLoading = () => (
  <div className="p-4 text-xs text-muted-foreground" role="status">
    Loading settings…
  </div>
);
const ProvidersPanel = dynamic(() => import("./settings/providers-panel").then((m) => m.ProvidersPanel), { loading: panelLoading });
const DefaultsPanel = dynamic(() => import("./settings/defaults-panel").then((m) => m.DefaultsPanel), { loading: panelLoading });
const ServicesPanel = dynamic(() => import("./settings/services-panel").then((m) => m.ServicesPanel), { loading: panelLoading });
const ProjectSettingsPanel = dynamic(
  () => import("./settings/project-settings-panel").then((m) => m.ProjectSettingsPanel),
  { loading: panelLoading },
);
const SkillsPanel = dynamic(() => import("./skills-panel").then((m) => m.SkillsPanel), { loading: panelLoading });
const PromptsPanel = dynamic(() => import("./prompts-panel").then((m) => m.PromptsPanel), { loading: panelLoading });
const SubagentsPanel = dynamic(() => import("./subagents-panel").then((m) => m.SubagentsPanel), { loading: panelLoading });
const ConnectorsPanel = dynamic(() => import("./connectors-panel").then((m) => m.ConnectorsPanel), { loading: panelLoading });

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const MODEL_TABS: TabDef[] = [
  { id: "providers", label: "Providers", icon: CloudIcon },
  { id: "defaults", label: "Defaults", icon: SlidersHorizontalIcon },
  { id: "fusion", label: "Fusion", icon: BrainCircuitIcon },
];
const PROJECT_TABS: TabDef[] = [
  { id: "project", label: "General", icon: FolderCogIcon },
  { id: "skills", label: "Skills", icon: LayersIcon },
  { id: "prompts", label: "Prompt templates", icon: SlashIcon },
  { id: "specialists", label: "Specialists", icon: BotIcon },
  { id: "connectors", label: "Connectors", icon: PlugIcon },
];
const WORKSPACE_TABS: TabDef[] = [
  { id: "services", label: "Services", icon: KeyIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
];

/** Tabs whose panels follow the globally active project (their API calls do). */
const ACTIVE_PROJECT_TABS = new Set<SettingsTab>(["skills", "prompts", "specialists", "connectors"]);

const DEFAULT_TAB: SettingsTab = "providers";

function TabGroup({ label, detail, tabs }: { label: string; detail?: string; tabs: TabDef[] }) {
  return (
    <>
      <div
        role="presentation"
        className="w-full truncate px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-0"
        title={detail ? `${label} · ${detail}` : label}
      >
        {label}
        {detail ? <span className="normal-case tracking-normal"> · {detail}</span> : null}
      </div>
      {tabs.map(({ id, label: tabLabel, icon: Icon }) => (
        <TabsTrigger key={id} value={id} className="w-full justify-start gap-2 px-3 text-xs">
          <Icon className="size-3.5" />
          {tabLabel}
        </TabsTrigger>
      ))}
    </>
  );
}

/**
 * Scroll `section` (an element id inside the panel) into view. Panels are
 * lazy and load their data first, so poll briefly instead of assuming the
 * element exists on the first frame.
 */
function useScrollToSection(container: React.RefObject<HTMLElement | null>, section: string | undefined, nonce: number) {
  useEffect(() => {
    if (!section || !/^[\w-]+$/.test(section)) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const target = container.current?.querySelector<HTMLElement>(`#${section}`);
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        window.clearInterval(timer);
      } else if (attempts > 40) {
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [container, section, nonce]);
}

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where to land. The host (page.tsx / project-view.tsx) listens for
   * `openSettings()` events — including links inside this dialog — and
   * passes each as a new object, so a repeated deep link re-applies.
   */
  request?: OpenSettingsRequest | null;
}

export function SettingsDialog({ open, onOpenChange, request }: SettingsDialogProps) {
  // Skills / prompt templates edited here feed the composer's pickers, which
  // fetch once per project — announce a change when the dialog closes.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) notifyCapabilitiesChanged();
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const { size, handleProps } = useResizableDialog(open);
  const { projects, activeProjectId } = useProjects();
  const scopeProjectId = useProjectScopeId();

  const [tab, setTab] = useState<SettingsTab>(() => readLastSettingsTab() ?? DEFAULT_TAB);
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const [section, setSection] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback((next: OpenSettingsRequest) => {
    const nextTab = normalizeSettingsTab(next.tab);
    if (nextTab) setTab(nextTab);
    setTargetProjectId(next.projectId ?? null);
    setSection(next.section);
    setNonce((value) => value + 1);
  }, []);

  // A request from the opener (page.tsx / project-view.tsx).
  useEffect(() => {
    if (open && request) apply(request);
  }, [apply, open, request]);

  // Plain reopen: keep the last tab but drop a previous deep link's target.
  useEffect(() => {
    if (!open) {
      setTargetProjectId(null);
      setSection(undefined);
    }
  }, [open]);

  useEffect(() => {
    writeLastSettingsTab(tab);
  }, [tab]);

  useScrollToSection(contentRef, section, nonce);

  const projectId = targetProjectId ?? scopeProjectId;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const showsOtherProject = ACTIVE_PROJECT_TABS.has(tab) && projectId !== activeProjectId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]")}
        style={size ? { width: size.width, height: size.height } : undefined}
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b px-6 pb-4 pt-6">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-xs">
            Models, this project, and the services Kady connects to.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = normalizeSettingsTab(value);
            if (next) {
              setTab(next);
              setSection(undefined);
            }
          }}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-48 shrink-0 items-start justify-start overflow-y-auto rounded-none border-r px-2 py-3"
          >
            <TabGroup label="Models" tabs={MODEL_TABS} />
            <TabGroup label="Project" detail={projectName(projectId)} tabs={PROJECT_TABS} />
            <TabGroup label="Workspace" tabs={WORKSPACE_TABS} />
          </TabsList>

          <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {showsOtherProject ? (
              <div className="mx-5 mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px]" role="note">
                Showing the current project, <b>{projectName(activeProjectId)}</b>. Open{" "}
                <b>{projectName(projectId)}</b> to edit its skills, prompt templates, specialists and connectors.
              </div>
            ) : null}
            <TabsContent value="providers" className="min-w-0 p-5">
              <ProvidersPanel section={section} />
            </TabsContent>
            <TabsContent value="defaults" className="min-w-0 p-5">
              <DefaultsPanel />
            </TabsContent>
            <TabsContent value="fusion" className="min-w-0 p-5">
              <FusionPanel />
            </TabsContent>
            <TabsContent value="project" className="min-w-0 p-5">
              <ProjectSettingsPanel projectId={projectId} />
            </TabsContent>
            <TabsContent value="skills" className="min-w-0 p-5">
              <SkillsPanel />
            </TabsContent>
            <TabsContent value="prompts" className="min-w-0 p-5">
              <PromptsPanel />
            </TabsContent>
            <TabsContent value="specialists" className="min-w-0 p-5">
              <SubagentsPanel />
            </TabsContent>
            <TabsContent value="connectors" className="min-w-0 p-5">
              <ConnectorsPanel />
            </TabsContent>
            <TabsContent value="services" className="min-w-0 p-5">
              <ServicesPanel />
            </TabsContent>
            <TabsContent value="appearance" className="min-w-0 p-5">
              <AppearancePanel />
            </TabsContent>
          </div>
        </Tabs>
        <div
          {...handleProps}
          role="separator"
          aria-label="Resize settings"
          aria-orientation="horizontal"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          className="absolute bottom-0 right-0 size-5 cursor-nwse-resize touch-none select-none rounded-br-lg text-muted-foreground/60 outline-none hover:text-foreground focus-visible:text-foreground"
          data-testid="settings-resize-handle"
        >
          <svg viewBox="0 0 16 16" className="size-full p-1" aria-hidden="true">
            <path d="M14 2 2 14M14 8l-6 6M14 13l-1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      </DialogContent>
    </Dialog>
  );
}
