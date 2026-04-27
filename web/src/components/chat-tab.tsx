"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageToolbar,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputProvider,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { buildDatabaseContext, type Database } from "@/components/database-selector";
import { buildComputeContext, type ModalInstance } from "@/components/compute-selector";
import {
  PairedModelSelector,
  DEFAULT_MODEL,
  DEFAULT_EXPERT_MODEL,
  type Model,
} from "@/components/model-selector";
import { buildSkillsContext, type Skill } from "@/components/skills-selector";
import { buildBrowserContext } from "@/components/browser-selector";
import { AddContextMenu } from "@/components/add-context-menu";
import { ContextChipsBar } from "@/components/context-chips";
import { CitationBadge } from "@/components/citation-badge";
import { useBrowserUseSettings, useChromeProfiles } from "@/lib/use-settings";
import { hasDirectoryEntries, traverseDroppedEntries } from "@/lib/directory-upload";
import { fileCategory } from "@/lib/use-sandbox";
import { useAgent, type ActivityItem, type ChatMessage } from "@/lib/use-agent";
import type { TurnMeta } from "@/lib/provenance";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import {
  ActivityIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CpuIcon,
  DatabaseIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileTextIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  SparklesIcon,
  TableIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const MAX_QUEUE = 5;

interface QueuedMessage {
  id: string;
  rawText: string;
  text: string;
  model: { id: string; label: string };
  expertModel: { id: string; label: string };
  databases: Database[];
  compute: ModalInstance | null;
  skills: Skill[];
  files: string[];
  timestamp: number;
}

function formatBudgetCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Inline banner above the chat input when the project is approaching (warn)
 * or over (exceeded) its spend limit.
 */
function BudgetBanner({
  state,
  totalUsd,
  limitUsd,
}: {
  state: "warn" | "exceeded";
  totalUsd: number;
  limitUsd: number | null;
}) {
  const blocked = state === "exceeded";
  return (
    <div
      role="alert"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        blocked
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <span className="flex-1">
        {blocked ? (
          <>
            <b>Project spend limit reached</b> (
            {formatBudgetCost(totalUsd)}
            {limitUsd !== null ? ` / ${formatBudgetCost(limitUsd)}` : ""})
            . New delegations are blocked. Raise the limit in the project
            settings to continue.
          </>
        ) : (
          <>
            <b>Approaching spend limit</b> (
            {formatBudgetCost(totalUsd)}
            {limitUsd !== null ? ` / ${formatBudgetCost(limitUsd)}` : ""})
            . You&apos;re over 80% of the project&apos;s cap.
          </>
        )}
      </span>
    </div>
  );
}

const FILE_DRAG_TYPE = "application/x-kady-filepath";

/**
 * Must be rendered inside <PromptInputProvider>.
 */
function PromptDropZone({
  children,
  onFileDrop,
  onFilesUpload,
}: {
  children: React.ReactNode;
  onFileDrop?: (path: string) => void;
  onFilesUpload?: (files: FileList | File[], paths?: string[]) => void;
}) {
  const controller = usePromptInputController();
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  const isAccepted = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes(FILE_DRAG_TYPE) || e.dataTransfer.types.includes("Files");
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isAccepted(e)) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  }, [isAccepted]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isAccepted(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [isAccepted]);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const path = e.dataTransfer.getData(FILE_DRAG_TYPE);
      if (path) {
        if (onFileDrop) {
          onFileDrop(path);
        } else {
          const current = controller.textInput.value;
          const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
          controller.textInput.setInput(current + sep + path);
        }
        return;
      }

      if (!onFilesUpload) return;

      if (hasDirectoryEntries(e.dataTransfer.items)) {
        const { files, paths } = await traverseDroppedEntries(e.dataTransfer.items);
        if (files.length > 0) onFilesUpload(files, paths);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFilesUpload(e.dataTransfer.files);
      }
    },
    [controller, onFileDrop, onFilesUpload],
  );

  const isOsDrag = isDragOver;
  const label = isDragOver ? "Drop to attach" : "Attach file";

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative"
    >
      {isOsDrag && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
          <div className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow">
            <PaperclipIcon className="size-3.5" />
            {label}
          </div>
        </div>
      )}
      <div className={cn("transition-all duration-150", isOsDrag && "opacity-40 pointer-events-none")}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// @ mention helpers
// ---------------------------------------------------------------------------

function mentionIconForFile(name: string): ReactNode {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cat = fileCategory(name);
  if (cat === "notebook") return <BookOpenIcon className="size-3.5 text-orange-500" />;
  if (cat === "fasta") return <ActivityIcon className="size-3.5 text-cyan-600" />;
  if (cat === "biotable") return <TableIcon className="size-3.5 text-indigo-500" />;
  if (cat === "image") return <FileImageIcon className="size-3.5 text-rose-500" />;
  if (cat === "markdown") return <FileTextIcon className="size-3.5 text-emerald-600" />;
  if (cat === "latex") return <FileCodeIcon className="size-3.5 text-teal-500" />;
  if (ext === "json" || ext === "jsonl") return <FileJsonIcon className="size-3.5 text-amber-600" />;
  const codeExts = ["py","ts","tsx","js","jsx","rs","go","java","c","cpp","h","rb","sh","bash","css","html","xml","yaml","yml","toml","sql"];
  if (codeExts.includes(ext)) return <FileCodeIcon className="size-3.5 text-violet-500" />;
  return <FileIcon className="size-3.5 text-muted-foreground" />;
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-foreground">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

function AssistantActivity({
  items,
  isStreaming,
}: {
  items: ActivityItem[];
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || expanded) { setIsOverflowing(false); return; }
    const check = () => setIsOverflowing(el.scrollHeight > el.clientHeight);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items, expanded]);

  if (items.length === 0 && !isStreaming) return null;

  const toggle = () => setExpanded((v) => !v);

  return (
    <div className="mb-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ActivityIcon className="size-3.5 shrink-0" />
        {isStreaming ? (
          <Shimmer as="span" className="text-xs" duration={1.2}>
            Working...
          </Shimmer>
        ) : (
          <span>Activity</span>
        )}
        {items.length > 1 && (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {items.length}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>
      {items.length > 0 ? (
        <div className="mt-2">
          <div
            ref={contentRef}
            className={cn(
              "overflow-hidden transition-all duration-200",
              expanded ? "max-h-[2000px]" : "max-h-24"
            )}
          >
            <div className="space-y-2">
              {items.map((item) => (
                <div key={item.id} className="flex items-start gap-2 text-xs">
                  {item.status === "running" ? (
                    <LoaderCircleIcon className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : item.status === "error" ? (
                    <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  )}
                  <div className="min-w-0">
                    <div className="text-foreground">{item.label}</div>
                    {item.detail && (
                      <div
                        className={cn(
                          "mt-0.5 text-muted-foreground",
                          !expanded && "line-clamp-2"
                        )}
                      >
                        {item.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {!expanded && isOverflowing && (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center justify-center gap-1 mt-1.5 text-[11px] font-medium text-primary/70 hover:text-primary transition-colors cursor-pointer"
            >
              <span>Show all {items.length} items</span>
              <ChevronDownIcon className="size-3" />
            </button>
          )}
          {expanded && items.length > 3 && (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center justify-center gap-1 mt-1.5 text-[11px] font-medium text-primary/70 hover:text-primary transition-colors cursor-pointer"
            >
              <span>Show less</span>
              <ChevronDownIcon className="size-3 rotate-180" />
            </button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Waiting for the delegated task to report progress...
        </p>
      )}
    </div>
  );
}

function MessageQueueDisplay({
  queue,
  onRemove,
}: {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-10 mb-2">
      <div className="overflow-hidden rounded-xl border bg-background shadow-lg">
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <ListOrderedIcon className="size-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Queued
          </span>
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {queue.length}/{MAX_QUEUE}
          </span>
        </div>
        <div className="max-h-52 overflow-y-auto py-1">
          {queue.map((item, i) => (
            <div
              key={item.id}
              className="group flex items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-muted/50"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">
                  {item.rawText || item.text.split("\n")[0]}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {item.model.label}
                    {item.expertModel.id !== item.model.id && (
                      <>
                        <span className="mx-0.5 text-muted-foreground/50">·</span>
                        {item.expertModel.label}
                      </>
                    )}
                  </span>
                  {item.files.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <PaperclipIcon className="size-2.5" />
                      {item.files.length}
                    </span>
                  )}
                  {item.databases.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <DatabaseIcon className="size-2.5" />
                      {item.databases.length}
                    </span>
                  )}
                  {item.compute && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <CpuIcon className="size-2.5" />
                      {item.compute.label}
                    </span>
                  )}
                  {item.skills.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <SparklesIcon className="size-2.5" />
                      {item.skills.length}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="shrink-0 rounded p-1 text-muted-foreground/40 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Remove queued message ${i + 1}`}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Full prompt input with @ mention overlay + drag-drop zone.
 * Must be rendered inside <PromptInputProvider>.
 */
function ChatInput({
  allFiles,
  attachedFiles,
  onAddFile,
  onRemoveFile,
  onClearFiles,
  onSubmit,
  isStreaming,
  agentStatus,
  onStop,
  selectedDbs,
  onDbsChange,
  selectedCompute,
  onComputeChange,
  selectedModel,
  onModelChange,
  selectedExpertModel,
  onExpertModelChange,
  onUploadFiles,
  modalConfigured,
  allSkills,
  selectedSkills,
  onSkillsChange,
  queuedMessages,
  onRemoveFromQueue,
  budgetState = "ok",
  budgetTotalUsd = 0,
  budgetLimitUsd = null,
}: {
  allFiles: string[];
  attachedFiles: string[];
  onAddFile: (path: string) => void;
  onRemoveFile: (path: string) => void;
  onClearFiles: () => void;
  onSubmit: Parameters<typeof PromptInput>[0]["onSubmit"];
  isStreaming: boolean;
  agentStatus: string;
  onStop: () => void;
  selectedDbs: Database[];
  onDbsChange: (dbs: Database[]) => void;
  selectedCompute: ModalInstance | null;
  onComputeChange: (instance: ModalInstance | null) => void;
  selectedModel: Model;
  onModelChange: (model: Model) => void;
  selectedExpertModel: Model;
  onExpertModelChange: (model: Model) => void;
  onUploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  modalConfigured: boolean;
  allSkills: Skill[];
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
  queuedMessages: QueuedMessage[];
  onRemoveFromQueue: (id: string) => void;
  budgetState?: "ok" | "warn" | "exceeded";
  budgetTotalUsd?: number;
  budgetLimitUsd?: number | null;
}) {
  const budgetBlocked = budgetState === "exceeded";
  const controller = usePromptInputController();
  const browserUse = useBrowserUseSettings();
  const chromeProfiles = useChromeProfiles();

  const handleFilesUpload = useCallback(async (files: FileList | File[], paths?: string[]) => {
    const uploaded = await onUploadFiles(files, paths);
    for (const p of uploaded) onAddFile(p);
  }, [onUploadFiles, onAddFile]);

  // Wrap onSubmit to append attached file paths and database context, then clear chips
  const handleSubmit = useCallback<Parameters<typeof PromptInput>[0]["onSubmit"]>(
    (msg, event) => {
      if (budgetBlocked) {
        event?.preventDefault();
        return;
      }
      const refs = attachedFiles.length > 0 ? "\n" + attachedFiles.join("\n") : "";
      const dbCtx = buildDatabaseContext(selectedDbs);
      const computeCtx = buildComputeContext(selectedCompute);
      const skillsCtx = buildSkillsContext(selectedSkills);
      const browserCtx = buildBrowserContext(browserUse.config, chromeProfiles.profiles);
      onSubmit({ ...msg, text: msg.text + refs + dbCtx + computeCtx + skillsCtx + browserCtx }, event);
      onClearFiles();
    },
    [budgetBlocked, onSubmit, attachedFiles, onClearFiles, selectedDbs, selectedCompute, selectedSkills, browserUse.config, chromeProfiles.profiles]
  );

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAtIdx, setMentionAtIdx] = useState(0);
  const [mentionSelIdx, setMentionSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredFiles = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    if (!q) return allFiles.slice(0, 8);
    const nameHits = allFiles.filter(f =>
      (f.split("/").pop()?.toLowerCase() ?? "").includes(q)
    );
    const pathOnly = allFiles.filter(f => {
      const name = f.split("/").pop()?.toLowerCase() ?? "";
      return !name.includes(q) && f.toLowerCase().includes(q);
    });
    return [...nameHits, ...pathOnly].slice(0, 8);
  }, [allFiles, mentionQuery]);

  useEffect(() => {
    if (mentionSelIdx >= filteredFiles.length) setMentionSelIdx(0);
  }, [filteredFiles.length, mentionSelIdx]);

  useEffect(() => {
    listRef.current
      ?.children[mentionSelIdx]
      ?.scrollIntoView({ block: "nearest" });
  }, [mentionSelIdx]);

  const closeMention = useCallback(() => setMentionQuery(null), []);

  const applyMention = useCallback((path: string) => {
    const current = controller.textInput.value;
    const before = current.slice(0, mentionAtIdx).trimEnd();
    const after = current.slice(mentionAtIdx + 1 + (mentionQuery?.length ?? 0)).trimStart();
    const cleaned = [before, after].filter(Boolean).join(" ");
    controller.textInput.setInput(cleaned);
    onAddFile(path);
    setMentionQuery(null);
    setMentionSelIdx(0);
  }, [controller, mentionAtIdx, mentionQuery, onAddFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const m = before.match(/@([^\s@]*)$/);
    if (m && m.index !== undefined) {
      setMentionQuery(m[1]);
      setMentionAtIdx(m.index);
      setMentionSelIdx(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isOpen = mentionQuery !== null && filteredFiles.length > 0;
    if (!isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionSelIdx(i => Math.min(i + 1, filteredFiles.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionSelIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyMention(filteredFiles[mentionSelIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  }, [mentionQuery, filteredFiles, mentionSelIdx, applyMention, closeMention]);

  const handleTranscription = useCallback((text: string) => {
    const current = controller.textInput.value;
    const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
    controller.textInput.setInput(current + sep + text);
  }, [controller]);

  const isMentionOpen = mentionQuery !== null && filteredFiles.length > 0;
  const submitStatus = isStreaming ? "streaming" : agentStatus === "error" ? "error" : "ready";

  return (
    <PromptDropZone onFileDrop={onAddFile} onFilesUpload={handleFilesUpload}>
      <div className="relative">
        {isMentionOpen && (
          <div
            className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border bg-background shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Files</span>
              {mentionQuery && (
                <span className="font-mono text-[11px] text-primary">@{mentionQuery}</span>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {filteredFiles.length} match{filteredFiles.length !== 1 ? "es" : ""}
              </span>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↑↓</kbd>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
            </div>

            <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
              {filteredFiles.map((path, i) => {
                const name = path.split("/").pop() ?? path;
                const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                return (
                  <div
                    key={path}
                    onClick={() => applyMention(path)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs transition-colors",
                      i === mentionSelIdx ? "bg-muted" : "hover:bg-muted/50"
                    )}
                  >
                    <span className="shrink-0">{mentionIconForFile(name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">
                        <HighlightMatch text={name} query={mentionQuery ?? ""} />
                      </span>
                      {dir && (
                        <span className="block truncate text-muted-foreground/70 text-[11px]">
                          <HighlightMatch text={dir} query={mentionQuery ?? ""} />
                        </span>
                      )}
                    </span>
                    {i === mentionSelIdx && (
                      <kbd className="ml-auto shrink-0 rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isMentionOpen && (
          <MessageQueueDisplay queue={queuedMessages} onRemove={onRemoveFromQueue} />
        )}

        {budgetState !== "ok" && (
          <BudgetBanner
            state={budgetState}
            totalUsd={budgetTotalUsd}
            limitUsd={budgetLimitUsd}
          />
        )}

        <PromptInput onSubmit={handleSubmit} className="rounded-xl border shadow-sm">
          <ContextChipsBar
            attachedFiles={attachedFiles}
            onRemoveFile={onRemoveFile}
            selectedDbs={selectedDbs}
            onDbsChange={onDbsChange}
            selectedCompute={selectedCompute}
            onComputeChange={onComputeChange}
            selectedSkills={selectedSkills}
            onSkillsChange={onSkillsChange}
          />
          <PromptInputTextarea
            placeholder={
              queuedMessages.length >= MAX_QUEUE
                ? `Queue full (${MAX_QUEUE}/${MAX_QUEUE})`
                : isStreaming && queuedMessages.length > 0
                  ? `Ask Kady anything… (${queuedMessages.length}/${MAX_QUEUE} queued)`
                  : "Ask Kady anything… (@ for files, + for data / compute / skills)"
            }
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
          <PromptInputFooter>
            <div className="flex min-w-0 items-center gap-1.5">
              <AddContextMenu
                selectedDbs={selectedDbs}
                onDbsChange={onDbsChange}
                selectedCompute={selectedCompute}
                onComputeChange={onComputeChange}
                modalConfigured={modalConfigured}
                allSkills={allSkills}
                selectedSkills={selectedSkills}
                onSkillsChange={onSkillsChange}
                onUploadFiles={handleFilesUpload}
              />
              <PairedModelSelector
                orchestrator={selectedModel}
                expert={selectedExpertModel}
                onChangeOrchestrator={onModelChange}
                onChangeExpert={onExpertModelChange}
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <InfoTooltip
                content={
                  <>
                    <b>Dictate</b>
                    <br />
                    Transcribe speech into the prompt. Uses the provider
                    configured in Settings → Speech.
                  </>
                }
              >
                <span>
                  <SpeechInput
                    size="icon-sm"
                    variant="ghost"
                    onTranscriptionChange={handleTranscription}
                  />
                </span>
              </InfoTooltip>
              <InfoTooltip
                content={
                  budgetBlocked ? (
                    <>
                      <b>Spend limit reached</b>
                      <br />
                      Project has hit its spend limit (
                      {formatBudgetCost(budgetTotalUsd)}
                      {budgetLimitUsd !== null
                        ? ` / ${formatBudgetCost(budgetLimitUsd)}`
                        : ""}
                      ). Raise the limit in the project settings to continue.
                    </>
                  ) : isStreaming ? (
                    <>
                      <b>Stop</b>
                      <br />
                      Cancel the current turn. Files the agent already wrote
                      stay in the sandbox.
                    </>
                  ) : queuedMessages.length >= MAX_QUEUE ? (
                    <>
                      <b>Queue is full</b>
                      <br />
                      Wait for the agent to finish before adding more prompts.
                    </>
                  ) : (
                    <>
                      <b>Send message</b>
                      <br />
                      Press <kbd>↵</kbd> to send, <kbd>⇧</kbd>+<kbd>↵</kbd> for
                      a new line. Prompts sent while the agent is busy are
                      queued.
                    </>
                  )
                }
              >
                <PromptInputSubmit
                  status={submitStatus as "streaming" | "error" | "ready"}
                  onStop={onStop}
                  disabled={budgetBlocked && !isStreaming}
                />
              </InfoTooltip>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptDropZone>
  );
}

function AssistantMessageBody({ message }: { message: ChatMessage }) {
  return (
    <>
      <MessageResponse>{message.content}</MessageResponse>
      {message.citations && (
        <div className="flex flex-wrap items-center gap-2">
          <CitationBadge report={message.citations} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ChatTab — full chat surface (Conversation + ChatInput + queue) for one tab.
// Each tab owns its own agent session, model selection, attached files,
// queued messages, etc. Sandbox/file tree are shared and passed in.
// ---------------------------------------------------------------------------

export interface ChatTabMeta {
  sessionId: string | null;
  status: "ready" | "submitted" | "streaming" | "error";
  isStreaming: boolean;
  messages: ChatMessage[];
  turnMeta: Map<string, TurnMeta>;
  userMessageCount: number;
}

export interface ChatTabHandle {
  /**
   * Send a workflow-style prompt into this tab. Used by the Workflows panel
   * which routes its launches to the active chat tab.
   */
  launchWorkflow: (
    prompt: string,
    model: Model,
    compute: ModalInstance | null,
    suggestedSkills: string[],
    uploadedFiles: string[],
  ) => Promise<void>;
  /**
   * Send a one-off prompt using the tab's currently selected model.
   * Used for ad-hoc actions like "Organize files" from the file-tree panel.
   */
  sendQuick: (prompt: string) => Promise<void>;
  /**
   * Cancel the in-flight turn (if any). Called by the parent when a tab
   * is closed while streaming, so the agent doesn't keep running with
   * nowhere to render its output.
   */
  stop: () => void;
}

export interface ChatTabProps {
  tabId: string;
  isActive: boolean;
  // Shared sandbox/state passed in (one instance for the whole project)
  allFiles: string[];
  uploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  onSandboxRefresh: () => void;
  onTurnComplete: () => void;
  modalConfigured: boolean;
  allSkills: Skill[];
  budgetState: "ok" | "warn" | "exceeded";
  budgetTotalUsd: number;
  budgetLimitUsd: number | null;
  onMetaChange: (tabId: string, meta: ChatTabMeta) => void;
}

export const ChatTab = forwardRef<ChatTabHandle, ChatTabProps>(function ChatTab(
  {
    tabId,
    isActive,
    allFiles,
    uploadFiles,
    onSandboxRefresh,
    onTurnComplete,
    modalConfigured,
    allSkills,
    budgetState,
    budgetTotalUsd,
    budgetLimitUsd,
    onMetaChange,
  },
  ref,
) {
  const { messages, status, send, stop, getSessionId } = useAgent();
  const isStreaming = status === "streaming" || status === "submitted";

  const turnMetaRef = useRef<Map<string, TurnMeta>>(new Map());
  // Bumped whenever a new entry is recorded on turnMetaRef, so the
  // onMetaChange effect refires and the parent's provenance panel sees
  // the new turn metadata even if no other state changed afterwards.
  const [turnMetaVersion, setTurnMetaVersion] = useState(0);
  const recordTurnMeta = useCallback((msgId: string, meta: TurnMeta) => {
    turnMetaRef.current.set(msgId, meta);
    setTurnMetaVersion((v) => v + 1);
  }, []);
  const prevMessageCount = useRef(0);

  // Per-tab settings
  const [selectedModel, setSelectedModel] = useState<Model>(DEFAULT_MODEL);
  const [selectedExpertModel, setSelectedExpertModel] = useState<Model>(DEFAULT_EXPERT_MODEL);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [selectedDbs, setSelectedDbs] = useState<Database[]>([]);
  const [selectedCompute, setSelectedCompute] = useState<ModalInstance | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const queueIdCounter = useRef(0);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const addAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.includes(path) ? prev : [...prev, path]);
  }, []);
  const removeAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.filter(p => p !== path));
  }, []);
  const clearAttachedFiles = useCallback(() => setAttachedFiles([]), []);

  const removeFromQueue = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleCopy = useCallback((id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const activeAssistantId =
    [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null;

  // Auto-refresh sandbox tree when this tab finishes a turn
  useEffect(() => {
    if (
      status === "ready" &&
      messages.length > 0 &&
      messages.length !== prevMessageCount.current
    ) {
      prevMessageCount.current = messages.length;
      onSandboxRefresh();
      onTurnComplete();
    }
  }, [status, messages.length, onSandboxRefresh, onTurnComplete]);

  // Auto-send the next queued message when the agent becomes ready
  useEffect(() => {
    if (status !== "ready" || messageQueue.length === 0) return;
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    send(next.text, next.model.id, {
      expertModel: next.expertModel.id,
      attachments: next.files,
      skills: next.skills.map((s) => s.name),
      databases: next.databases.map((db) => db.name),
      compute: next.compute?.label ?? null,
    }).then((msgId) => {
      if (msgId) {
        recordTurnMeta(msgId, {
          model: next.model.label,
          expertModel: next.expertModel.label,
          databases: next.databases.map((db) => db.name),
          compute: next.compute?.label ?? null,
          skills: next.skills.map((s) => s.name),
          filesAttached: [...next.files],
          timestamp: next.timestamp,
        });
      }
    });
  }, [status, messageQueue, send, recordTurnMeta]);

  // Bubble meta up to parent so the page can drive the cost pill,
  // provenance panel, and tab strip badges from the active tab.
  const sessionId = getSessionId();
  const userMessageCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages],
  );
  useEffect(() => {
    onMetaChange(tabId, {
      sessionId,
      status,
      isStreaming,
      messages,
      turnMeta: turnMetaRef.current,
      userMessageCount,
    });
    // turnMetaVersion is intentionally a dep — it bumps when we set a new
    // entry in turnMetaRef so the parent's provenance panel sees the
    // latest turn metadata even if no other state changed.
  }, [tabId, sessionId, status, isStreaming, messages, userMessageCount, onMetaChange, turnMetaVersion]);

  const handleSubmit = useCallback(
    async ({ text }: { text: string }) => {
      if (budgetState === "exceeded") return;
      if (isStreaming) {
        if (messageQueue.length >= MAX_QUEUE) return;
        const rawText = text.split("\n")[0];
        setMessageQueue((prev) => [
          ...prev,
          {
            id: String(++queueIdCounter.current),
            rawText,
            text,
            model: { id: selectedModel.id, label: selectedModel.label },
            expertModel: { id: selectedExpertModel.id, label: selectedExpertModel.label },
            databases: [...selectedDbs],
            compute: selectedCompute,
            skills: [...selectedSkills],
            files: [...attachedFiles],
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      const msgId = await send(text, selectedModel.id, {
        expertModel: selectedExpertModel.id,
        attachments: attachedFiles,
        skills: selectedSkills.map((s) => s.name),
        databases: selectedDbs.map((db) => db.name),
        compute: selectedCompute?.label ?? null,
      });
      if (msgId) {
        recordTurnMeta(msgId, {
          model: selectedModel.label,
          expertModel: selectedExpertModel.label,
          databases: selectedDbs.map((db) => db.name),
          compute: selectedCompute?.label ?? null,
          skills: selectedSkills.map((s) => s.name),
          filesAttached: [...attachedFiles],
          timestamp: Date.now(),
        });
      }
    },
    [
      send,
      selectedModel,
      selectedExpertModel,
      selectedDbs,
      selectedCompute,
      selectedSkills,
      attachedFiles,
      isStreaming,
      messageQueue.length,
      budgetState,
      recordTurnMeta,
    ],
  );

  // Imperatively launch a workflow into this tab (called by parent on the
  // active tab when the user hits "Launch" on a workflow template).
  useImperativeHandle(
    ref,
    () => ({
      stop,
      sendQuick: async (prompt: string) => {
        if (budgetState === "exceeded") return;
        await send(prompt, selectedModel.id);
      },
      launchWorkflow: async (prompt, model, compute, suggestedSkills, uploadedFiles) => {
        if (budgetState === "exceeded") return;
        setSelectedModel(model);
        setSelectedExpertModel(model);
        setSelectedCompute(compute);
        const fileRefs = uploadedFiles.length > 0 ? "\n" + uploadedFiles.join("\n") : "";
        const computeCtx = buildComputeContext(compute);
        const skillsCtx = suggestedSkills.length > 0
          ? `\n\nMake sure to instruct the delegated expert to use the skills: ${suggestedSkills.map((s) => `'${s}'`).join(", ")}`
          : "";
        const fullPrompt = prompt + fileRefs + computeCtx + skillsCtx;
        const msgId = await send(fullPrompt, model.id, {
          expertModel: model.id,
          attachments: uploadedFiles,
          skills: suggestedSkills,
          databases: [],
          compute: compute?.label ?? null,
        });
        if (msgId) {
          recordTurnMeta(msgId, {
            model: model.label,
            expertModel: model.label,
            databases: [],
            compute: compute?.label ?? null,
            skills: suggestedSkills,
            filesAttached: [...uploadedFiles],
            timestamp: Date.now(),
          });
        }
      },
    }),
    [send, stop, budgetState, selectedModel.id, recordTurnMeta],
  );

  // Background tabs stay mounted (so streaming + queue auto-send continue,
  // and the textarea / scroll position survive a tab switch) but use
  // `display: none` to drop out of the layout. React keeps the component
  // instance alive, so all hooks above this branch keep running.
  return (
    <div
      className={cn(
        "flex flex-1 flex-col min-h-0 overflow-hidden",
        !isActive && "hidden",
      )}
    >
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-full px-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="What can I help you with?"
              description="I can research topics, write code, analyze data, and delegate tasks to specialized agents."
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.role === "assistant" && (
                    <AssistantActivity
                      items={message.activities ?? []}
                      isStreaming={
                        isStreaming && message.id === activeAssistantId
                      }
                    />
                  )}
                  {message.role === "assistant" &&
                  !message.content &&
                  !(message.activities && message.activities.length > 0) &&
                  isStreaming ? (
                    <Shimmer className="text-sm" duration={1.5}>
                      Thinking...
                    </Shimmer>
                  ) : message.role === "assistant" ? (
                    <AssistantMessageBody message={message} />
                  ) : (
                    <MessageResponse>{message.content}</MessageResponse>
                  )}
                  {message.role === "assistant" && message.modelVersion && (
                    <span className="text-xs text-muted-foreground mt-1">
                      {message.modelVersion}
                    </span>
                  )}
                </MessageContent>
                {message.role === "assistant" && message.content && (
                  <MessageToolbar>
                    <MessageActions>
                      <MessageAction
                        tooltip="Copy"
                        onClick={() => handleCopy(message.id, message.content)}
                      >
                        {copiedId === message.id ? (
                          <CheckIcon className="size-4" />
                        ) : (
                          <CopyIcon className="size-4" />
                        )}
                      </MessageAction>
                    </MessageActions>
                  </MessageToolbar>
                )}
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="px-4 pb-6 pt-2">
        <PromptInputProvider>
          <ChatInput
            allFiles={allFiles}
            attachedFiles={attachedFiles}
            onAddFile={addAttachedFile}
            onRemoveFile={removeAttachedFile}
            onClearFiles={clearAttachedFiles}
            onSubmit={handleSubmit}
            isStreaming={isStreaming}
            agentStatus={status}
            onStop={stop}
            selectedDbs={selectedDbs}
            onDbsChange={setSelectedDbs}
            selectedCompute={selectedCompute}
            onComputeChange={setSelectedCompute}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            selectedExpertModel={selectedExpertModel}
            onExpertModelChange={setSelectedExpertModel}
            onUploadFiles={uploadFiles}
            modalConfigured={modalConfigured}
            allSkills={allSkills}
            selectedSkills={selectedSkills}
            onSkillsChange={setSelectedSkills}
            queuedMessages={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            budgetState={budgetState}
            budgetTotalUsd={budgetTotalUsd}
            budgetLimitUsd={budgetLimitUsd}
          />
        </PromptInputProvider>
      </div>
    </div>
  );
});
