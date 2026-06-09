"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  PaperclipIcon,
  DatabaseIcon,
  WandSparklesIcon,
  PlusIcon,
  UploadIcon,
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
import type { Skill } from "@/lib/use-skills";

type TabId = "files" | "data" | "skills";

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
    id: "data",
    label: "Data",
    icon: DatabaseIcon,
    hint: (
      <>
        <b>Data sources</b>
        <br />
        Pin curated scientific APIs (PubMed, UniProt, Ensembl, etc.). The
        orchestrator will cite them and the expert can query them directly.
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
        Opt-in playbooks for specific tasks (e.g. <i>modal</i>,{" "}
        <i>graphify</i>, <i>best-of-n</i>). The agent loads and follows them
        for the next message.
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
}

/**
 * Unified "+" menu for all chat context:
 *   Files | Data | Skills
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
}: AddContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<TabId>("files");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const counts: Record<TabId, number> = {
    files: 0,
    data: selectedDbs.length,
    skills: selectedSkills.length,
  };

  const totalActive = counts.data + counts.skills;

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
            Attach files, pin scientific databases, or enable skills for the
            next message.
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[480px] max-w-[calc(100vw-2rem)] p-0 overflow-hidden rounded-xl shadow-xl"
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
                    <span>{tab.label}</span>
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
                onFilePick={handleFilePick}
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
  onFilePick,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFilePick: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
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
            Upload files or folders
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
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFilePick}
      />
    </div>
  );
}
