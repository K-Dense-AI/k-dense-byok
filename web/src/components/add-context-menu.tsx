"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  PaperclipIcon,
  DatabaseIcon,
  WandSparklesIcon,
  PlusIcon,
  UploadIcon,
  FolderUpIcon,
  BookOpenIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { DatabasePickerBody, type Database } from "@/components/database-selector";
import { SkillsPickerBody } from "@/components/skills-selector";
import { ResearchPickerBody } from "@/components/research-picker";
import { DelegatePickerBody } from "@/components/delegate-picker";
import type { Skill } from "@/lib/use-skills";
import type { DelegationChoice, ResearchRef } from "@/lib/composer-context";

type TabId = "files" | "research" | "delegate" | "skills" | "data";

interface TabDescriptor {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: React.ReactNode;
}

const TABS: TabDescriptor[] = [
  {
    id: "files",
    label: "Files",
    icon: PaperclipIcon,
    hint: (
      <>
        <b>Files</b>
        <br />
        Upload data, figures, manuscripts, or code. Everything lands in the
        sandbox and can be referenced with <kbd>@</kbd>.
      </>
    ),
  },
  {
    id: "research",
    label: "Research",
    icon: BookOpenIcon,
    hint: (
      <>
        <b>Research context</b>
        <br />
        Point Kady at notebook entries, frozen plans, notes, or an earlier
        chat. It reads them with its own tools before answering. Applies to
        the next message only.
      </>
    ),
  },
  {
    id: "delegate",
    label: "Delegate",
    icon: UsersIcon,
    hint: (
      <>
        <b>Delegate</b>
        <br />
        Hand this message to specific specialists, let Kady choose, or ask
        for a verification gate before a result is accepted. Applies to the
        next message only.
      </>
    ),
  },
  {
    id: "skills",
    label: "Skills",
    icon: WandSparklesIcon,
    hint: (
      <>
        <b>Skills</b>
        <br />
        Opt-in playbooks for specific tasks (e.g. <i>scanpy</i>,{" "}
        <i>literature-review</i>, <i>modal</i>). Kady follows pinned skills on
        every message until you remove them.
      </>
    ),
  },
  {
    id: "data",
    label: "Data",
    icon: DatabaseIcon,
    hint: (
      <>
        <b>Data sources</b>
        <br />
        Point Kady at public scientific APIs (PubMed, UniProt, Ensembl,
        etc.). Their names and URLs are added to your message so Kady can
        query and cite them.
      </>
    ),
  },
];

export interface AddContextMenuProps {
  selectedDbs: Database[];
  onDbsChange: (dbs: Database[]) => void;
  allSkills: Skill[];
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
  onUploadFiles: (files: FileList | File[]) => void;
  projectId: string;
  currentSessionId: string | null;
  researchRefs: ResearchRef[];
  onResearchChange: (refs: ResearchRef[]) => void;
  delegation: DelegationChoice;
  onDelegationChange: (next: DelegationChoice) => void;
}

/**
 * Unified "+" menu for all chat context:
 *   Files | Research | Delegate | Skills | Data
 *
 * One trigger, one popover, tabbed content. Shows per-tab counts so users can
 * tell at a glance what's active without opening each picker individually.
 */
export function AddContextMenu({
  selectedDbs,
  onDbsChange,
  allSkills,
  selectedSkills,
  onSkillsChange,
  onUploadFiles,
  projectId,
  currentSessionId,
  researchRefs,
  onResearchChange,
  delegation,
  onDelegationChange,
}: AddContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<TabId>("files");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const counts: Record<TabId, number> = {
    files: 0,
    research: researchRefs.length,
    delegate:
      delegation.specialists.length + (delegation.auto ? 1 : 0) + (delegation.verify ? 1 : 0),
    skills: selectedSkills.length,
    data: selectedDbs.length,
  };

  const totalActive = counts.research + counts.delegate + counts.skills + counts.data;

  const handleFilePick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUploadFiles(e.target.files);
      setOpen(false);
    }
    e.target.value = "";
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "group relative flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
                  open || totalActive > 0
                    ? "border-border bg-muted/60 text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
                )}
                aria-label="Add context"
              >
                <PlusIcon className="size-4" />
                {totalActive > 0 && !open && (
                  <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground tabular-nums">
                    {totalActive}
                  </span>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs whitespace-normal text-xs leading-relaxed">
            <b className="font-semibold">Add context</b>
            <br />
            Attach files, reference earlier research, delegate to
            specialists, or enable skills and data sources for the next
            message.
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[540px] max-w-[calc(100vw-2rem)] p-0 overflow-hidden rounded-xl shadow-xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Tab strip */}
          <div
            className="flex items-stretch border-b bg-muted/30"
            role="tablist"
            aria-label="Add context sections"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = active === tab.id;
              const count = counts[tab.id];
              return (
                <InfoTooltip key={tab.id} content={tab.hint} side="bottom">
                  <button
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActive(tab.id)}
                    className={cn(
                      "group relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors",
                      isActive
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{tab.label}</span>
                    {count > 0 && (
                      <span
                        className={cn(
                          "inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {count}
                      </span>
                    )}
                    {isActive && (
                      <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                    )}
                  </button>
                </InfoTooltip>
              );
            })}
          </div>

          {/* Panel body */}
          <div className="flex flex-col">
            {active === "files" && (
              <FilesPanel
                fileInputRef={fileInputRef}
                folderInputRef={folderInputRef}
                onFilePick={handleFilePick}
              />
            )}
            {active === "research" && (
              <ResearchPickerBody
                projectId={projectId}
                currentSessionId={currentSessionId}
                selected={researchRefs}
                onChange={onResearchChange}
                autoFocus
              />
            )}
            {active === "delegate" && (
              <DelegatePickerBody
                value={delegation}
                onChange={onDelegationChange}
                autoFocus
              />
            )}
            {active === "data" && (
              <DatabasePickerBody
                selected={selectedDbs}
                onChange={onDbsChange}
                autoFocus
              />
            )}
            {active === "skills" && (
              <SkillsPickerBody
                skills={allSkills}
                selected={selectedSkills}
                onChange={onSkillsChange}
                autoFocus
              />
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

function FilesPanel({
  fileInputRef,
  folderInputRef,
  onFilePick,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onFilePick: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/20 px-4 py-8 text-center transition-colors hover:border-primary/60 hover:bg-muted/40"
      >
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
          <UploadIcon className="size-5" />
        </div>
        <div>
          <div className="text-sm font-medium text-foreground">
            Upload files
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Or drag & drop onto the input. Type{" "}
            <kbd className="rounded border bg-background px-1 py-0.5 text-[10px] font-mono">
              @
            </kbd>{" "}
            to mention tracked files.
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={() => folderInputRef.current?.click()}
        className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <FolderUpIcon className="size-3.5" />
        Upload a folder
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFilePick}
        aria-label="Upload files"
      />
      {/* @ts-expect-error -- webkitdirectory is non-standard but supported in all major browsers */}
      <input ref={folderInputRef} type="file" webkitdirectory="" className="hidden" onChange={onFilePick} aria-label="Upload a folder" />
    </div>
  );
}
