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
import {
  ModelSelector,
  DEFAULT_MODEL,
  type Model,
} from "@/components/model-selector";
import { ComputeSelector, type ModalInstance } from "@/components/compute-selector";
import {
  DEFAULT_THINKING_LEVEL,
  ThinkingSelector,
  type ThinkingLevel,
} from "@/components/thinking-selector";
import { apiFetch } from "@/lib/projects";
import { onChatPrefill } from "@/lib/chat-prefill";
import { buildSkillsContext, type Skill } from "@/components/skills-selector";
import { AddContextMenu } from "@/components/add-context-menu";
import { ContextChipsBar } from "@/components/context-chips";
import { CitationBadge } from "@/components/citation-badge";
import { ReasoningBlock, ToolActivityList } from "@/components/tool-activity";
import { InterviewCard } from "@/components/interview-form";
import { KadyFileIcon } from "@/components/file-icon";
import { hasDirectoryEntries, traverseDroppedEntries } from "@/lib/directory-upload";
import { suggestSkillsForFiles } from "@/lib/skill-suggestions";
import { useAgent, type ActivityItem, type ChatMessage } from "@/lib/use-agent";
import { routeSubmit, steerNotStreamingFallback, type SendIntent } from "@/lib/chat-routing";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import {
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  ListOrderedIcon,
  PaperclipIcon,
  SparklesIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { cn, formatUsd } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

const MAX_QUEUE = 5;

interface QueuedMessage {
  id: string;
  rawText: string;
  text: string;
  model: { id: string; label: string; fusionConfig?: Record<string, unknown> };
  databases: Database[];
  skills: Skill[];
  files: string[];
  /** Selected Modal compute instance id at enqueue time (null = local). */
  computeTarget: string | null;
  /** Thinking level at enqueue time (null = model doesn't support one). */
  thinkingLevel: ThinkingLevel | null;
  timestamp: number;
}

/** Models whose runs must NOT carry a thinkingLevel: Ollama models are built
 *  with reasoning:false (Pi clamps to off) and Fusion rewrites the wire body,
 *  so a level is meaningless there. Mirrors isOllama in model-selector.tsx. */
function thinkingUnsupported(model: { id: string; provider?: string }): boolean {
  return (
    model.provider === "Ollama" ||
    model.id.startsWith("ollama/") ||
    model.id.startsWith("fusion/")
  );
}

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
            <b>Project spend limit reached</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). New runs
            are blocked. Raise the limit in the project settings to continue.
          </>
        ) : (
          <>
            <b>Approaching spend limit</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). You&apos;re
            over 80% of the project&apos;s cap.
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
          appendToComposer(controller.textInput, path, " ");
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

/** Append text to the composer, inserting `separator` unless the current
 * value is empty or already ends in whitespace. Single home for the logic
 * shared by file drops, voice transcription, and the Ask Kady prefill. */
function appendToComposer(
  textInput: { value: string; setInput: (v: string) => void },
  text: string,
  separator: " " | "\n",
) {
  const current = textInput.value;
  const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? separator : "";
  textInput.setInput(current + sep + text);
}

// ---------------------------------------------------------------------------
// @ mention helpers
// ---------------------------------------------------------------------------

function mentionIconForFile(name: string) {
  return <KadyFileIcon name={name} className="size-3.5" />;
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

function MessageQueueDisplay({
  queue,
  steering,
  onRemove,
}: {
  queue: QueuedMessage[];
  steering: string[];
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0 && steering.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-10 mb-2">
      <div className="overflow-hidden rounded-xl border bg-background shadow-lg">
        {steering.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ZapIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Steering — delivers mid-run
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {steering.length}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto border-b py-1">
              {steering.map((text, i) => (
                <div key={`${i}-${text}`} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums text-muted-foreground">
                    ⏳
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground">{text}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {queue.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ListOrderedIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Run after
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
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Full prompt input with @ mention overlay + drag-drop zone.
 * Must be rendered inside <PromptInputProvider>.
 */
function ChatInput({
  isActiveTab,
  allFiles,
  attachedFiles,
  onAddFile,
  onRemoveFile,
  onClearFiles,
  onSend,
  pendingSteers,
  composerRestoreRef,
  inlineError,
  isStreaming,
  agentStatus,
  onStop,
  selectedDbs,
  onDbsChange,
  selectedModel,
  onModelChange,
  selectedComputeTarget,
  onComputeTargetChange,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingDisabled,
  modalConfigured,
  onUploadFiles,
  allSkills,
  selectedSkills,
  onSkillsChange,
  queuedMessages,
  onRemoveFromQueue,
  budgetState = "ok",
  budgetTotalUsd = 0,
  budgetLimitUsd = null,
}: {
  isActiveTab: boolean;
  allFiles: string[];
  attachedFiles: string[];
  onAddFile: (path: string) => void;
  onRemoveFile: (path: string) => void;
  onClearFiles: () => void;
  onSend: (text: string, intent: SendIntent) => void;
  pendingSteers: string[];
  composerRestoreRef: MutableRefObject<((text: string) => void) | null>;
  inlineError: string | null;
  isStreaming: boolean;
  agentStatus: string;
  onStop: () => void;
  selectedDbs: Database[];
  onDbsChange: (dbs: Database[]) => void;
  selectedModel: Model;
  onModelChange: (model: Model) => void;
  selectedComputeTarget: ModalInstance | null;
  onComputeTargetChange: (instance: ModalInstance | null) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  thinkingDisabled: boolean;
  modalConfigured: boolean;
  onUploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
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

  // "Ask Kady" handoff from the LaTeX editor: only the active tab's composer
  // appends the prefill text (it does not submit), so a background tab never
  // steals the event. Gated on the active TAB, not the visible view — tabs
  // stay mounted behind the Workflows view, and page.tsx switches the view
  // back to chat on the same event. The controller is read through a ref
  // because its identity changes on every keystroke.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    if (!isActiveTab) return;
    return onChatPrefill((text) => appendToComposer(controllerRef.current.textInput, text, "\n"));
  }, [isActiveTab]);

  // Steer failures and Stop restore undelivered text into this composer;
  // the parent holds the ref because it owns the steer/stop calls.
  useEffect(() => {
    composerRestoreRef.current = (text: string) =>
      appendToComposer(controllerRef.current.textInput, text, "\n");
    return () => {
      composerRestoreRef.current = null;
    };
  }, [composerRestoreRef]);

  const handleFilesUpload = useCallback(async (files: FileList | File[], paths?: string[]) => {
    const uploaded = await onUploadFiles(files, paths);
    for (const p of uploaded) onAddFile(p);
    // Surface skills that match the uploaded data formats (e.g. .h5ad → anndata)
    // by auto-attaching them; they appear as removable chips, so it's a
    // suggestion the user can undo, not a hidden side-effect.
    const suggested = suggestSkillsForFiles(uploaded, allSkills);
    if (suggested.length > 0) {
      const existing = new Set(selectedSkills.map((s) => s.id));
      const additions = suggested.filter((s) => !existing.has(s.id));
      if (additions.length > 0) onSkillsChange([...selectedSkills, ...additions]);
    }
  }, [onUploadFiles, onAddFile, allSkills, selectedSkills, onSkillsChange]);

  // Wrap onSubmit to append attached file paths and database/skills context,
  // then clear chips.
  const handleSubmit = useCallback<Parameters<typeof PromptInput>[0]["onSubmit"]>(
    (msg, event) => {
      const intent: SendIntent = queueIntentRef.current ? "queue" : "auto";
      queueIntentRef.current = false;
      if (budgetBlocked) {
        event?.preventDefault();
        return;
      }
      const refs = attachedFiles.length > 0 ? "\n" + attachedFiles.join("\n") : "";
      const dbCtx = buildDatabaseContext(selectedDbs);
      const skillsCtx = buildSkillsContext(selectedSkills);
      const baseText = msg.text ?? "";
      if (!baseText.trim() && attachedFiles.length === 0) return;
      onSend(baseText + refs + dbCtx + skillsCtx, intent);
      onClearFiles();
    },
    [budgetBlocked, onSend, attachedFiles, onClearFiles, selectedDbs, selectedSkills]
  );

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAtIdx, setMentionAtIdx] = useState(0);
  const [mentionSelIdx, setMentionSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Alt is read from keydown, not the form submit event, which carries no
  // modifiers by the time the library's Enter handler calls requestSubmit().
  const queueIntentRef = useRef(false);

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

  const safeMentionSelIdx =
    filteredFiles.length === 0
      ? 0
      : Math.min(mentionSelIdx, filteredFiles.length - 1);

  useEffect(() => {
    listRef.current
      ?.children[safeMentionSelIdx]
      ?.scrollIntoView({ block: "nearest" });
  }, [safeMentionSelIdx]);

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
    // An Enter consumed by the mention overlay must not record queue intent —
    // the next submit may be a button click that can't overwrite the flag.
    if (!isOpen && e.key === "Enter" && !e.shiftKey) {
      queueIntentRef.current = e.altKey;
    }
    if (!isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionSelIdx(i => Math.min(i + 1, filteredFiles.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionSelIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyMention(filteredFiles[safeMentionSelIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  }, [mentionQuery, filteredFiles, safeMentionSelIdx, applyMention, closeMention]);

  const handleTranscription = useCallback((text: string) => {
    appendToComposer(controller.textInput, text, " ");
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
                      i === safeMentionSelIdx ? "bg-muted" : "hover:bg-muted/50"
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
                    {i === safeMentionSelIdx && (
                      <kbd className="ml-auto shrink-0 rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isMentionOpen && (
          <MessageQueueDisplay queue={queuedMessages} steering={pendingSteers} onRemove={onRemoveFromQueue} />
        )}

        {inlineError && (
          <div
            role="alert"
            className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inlineError}
          </div>
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
            selectedSkills={selectedSkills}
            onSkillsChange={onSkillsChange}
          />
          <PromptInputTextarea
            placeholder={
              isStreaming
                ? pendingSteers.length > 0
                  ? `Steer the run… (${pendingSteers.length} pending · ⌥↵ to run after)`
                  : "Steer the run… (⌥↵ to run after)"
                : queuedMessages.length >= MAX_QUEUE
                  ? `Queue full (${MAX_QUEUE}/${MAX_QUEUE})`
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
                allSkills={allSkills}
                selectedSkills={selectedSkills}
                onSkillsChange={onSkillsChange}
                onUploadFiles={handleFilesUpload}
              />
              <ModelSelector
                selected={selectedModel}
                onChange={onModelChange}
              />
              <ThinkingSelector
                selected={thinkingLevel}
                onChange={onThinkingLevelChange}
                disabled={thinkingDisabled}
              />
              <ComputeSelector
                selected={selectedComputeTarget}
                onChange={onComputeTargetChange}
                modalConfigured={modalConfigured}
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
                      {formatUsd(budgetTotalUsd)}
                      {budgetLimitUsd !== null
                        ? ` / ${formatUsd(budgetLimitUsd)}`
                        : ""}
                      ). Raise the limit in the project settings to continue.
                    </>
                  ) : isStreaming ? (
                    <>
                      <b>Stop</b>
                      <br />
                      Cancel the current turn (⏎ steers it instead). Undelivered
                      steering messages return to the composer; files the agent
                      already wrote stay in the sandbox.
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
                      a new line. Prompts sent while the agent is busy steer
                      the live run; ⌥⏎ queues a new run instead.
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

function AssistantMessageBody({
  message,
  isStreaming,
  sessionId,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  sessionId: string | null;
}) {
  const activities = message.activities ?? [];
  const hasReasoning = Boolean(message.reasoning?.trim());
  const hasAnything =
    Boolean(message.content) || activities.length > 0 || hasReasoning;

  // Interview tool calls render as interactive forms, in stream order between
  // the surrounding tool cards (consecutive non-interview calls are chunked
  // into one ToolActivityList).
  const activityBlocks: ReactNode[] = [];
  let chunk: ActivityItem[] = [];
  const flushChunk = () => {
    if (!chunk.length) return;
    activityBlocks.push(
      <ToolActivityList key={`tools-${chunk[0].id}`} activities={chunk} />,
    );
    chunk = [];
  };
  for (const a of activities) {
    if (a.toolName === "interview") {
      flushChunk();
      activityBlocks.push(<InterviewCard key={a.id} item={a} sessionId={sessionId} />);
    } else {
      chunk.push(a);
    }
  }
  flushChunk();

  return (
    <>
      {hasReasoning && <ReasoningBlock reasoning={message.reasoning ?? ""} />}
      {activityBlocks}
      {message.content ? (
        <MessageResponse>{message.content}</MessageResponse>
      ) : isStreaming && !hasAnything ? (
        <Shimmer className="text-sm" duration={1.5}>
          Thinking...
        </Shimmer>
      ) : null}
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
  /** True when this is the selected tab, even if the Workflows view hides the
   * chat column — the Ask Kady prefill targets the tab, not the view. */
  isActiveTab: boolean;
  /** Stored session to reopen into this tab (History menu / reload recovery). */
  initialSessionId?: string | null;
  // Shared sandbox/state passed in (one instance for the whole project)
  allFiles: string[];
  uploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  onSandboxRefresh: () => void;
  onTurnComplete: () => void;
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
    isActiveTab,
    initialSessionId,
    allFiles,
    uploadFiles,
    onSandboxRefresh,
    onTurnComplete,
    allSkills,
    budgetState,
    budgetTotalUsd,
    budgetLimitUsd,
    onMetaChange,
  },
  ref,
) {
  const { messages, status, send, stop, steer, pendingSteers, getSessionId, loadSession } = useAgent();
  const isStreaming = status === "streaming" || status === "submitted";

  // Reopened tab: hydrate the transcript from the stored session before any
  // sends. loadSession refuses to run once the tab is bound to a session, so
  // this fires meaningfully only on first mount.
  useEffect(() => {
    if (initialSessionId) void loadSession(initialSessionId);
  }, [initialSessionId, loadSession]);

  const prevMessageCount = useRef(0);

  // Per-tab settings
  const [selectedModel, setSelectedModel] = useState<Model>(DEFAULT_MODEL);
  const [selectedComputeTarget, setSelectedComputeTarget] = useState<ModalInstance | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const thinkingDisabled = thinkingUnsupported(selectedModel);
  const [modalConfigured, setModalConfigured] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [selectedDbs, setSelectedDbs] = useState<Database[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const queueIdCounter = useRef(0);
  // Mirrored every render so async continuations (the steer fallback) read
  // the CURRENT queue length, not the one closed over before the await.
  const messageQueueLengthRef = useRef(0);
  messageQueueLengthRef.current = messageQueue.length;
  const composerRestoreRef = useRef<((text: string) => void) | null>(null);
  const [steerError, setSteerError] = useState<string | null>(null);

  useEffect(() => {
    if (!steerError) return;
    const t = window.setTimeout(() => setSteerError(null), 5000);
    return () => window.clearTimeout(t);
  }, [steerError]);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modal compute is gated on both token halves being set; the ComputeSelector
  // shows a "keys not configured" notice and disables GPU rows until then.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/credentials")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setModalConfigured(Boolean(d.modalTokenId?.set && d.modalTokenSecret?.set));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    const id = window.setTimeout(() => {
      setMessageQueue(rest);
      void send(
        next.text,
        next.model.id,
        {
          attachments: next.files,
          skills: next.skills.map((s) => s.name),
          databases: next.databases.map((db) => db.name),
        },
        next.model.fusionConfig,
        next.computeTarget ?? undefined,
        next.thinkingLevel ?? undefined,
      );
    }, 0);
    return () => window.clearTimeout(id);
  }, [status, messageQueue, send]);

  // Bubble meta up to parent so the page can drive the cost pill and tab
  // strip badges from the active tab.
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
      userMessageCount,
    });
  }, [tabId, sessionId, status, isStreaming, messages, userMessageCount, onMetaChange]);

  const enqueue = useCallback(
    (trimmed: string) => {
      if (messageQueue.length >= MAX_QUEUE) return;
      setMessageQueue((prev) => [
        ...prev,
        {
          id: String(++queueIdCounter.current),
          rawText: trimmed.split("\n")[0],
          text: trimmed,
          model: {
            id: selectedModel.id,
            label: selectedModel.label,
            fusionConfig: selectedModel.fusionConfig,
          },
          databases: [...selectedDbs],
          skills: [...selectedSkills],
          files: [...attachedFiles],
          computeTarget: selectedComputeTarget?.id ?? null,
          thinkingLevel: thinkingDisabled ? null : thinkingLevel,
          timestamp: Date.now(),
        },
      ]);
    },
    [messageQueue.length, selectedModel, selectedDbs, selectedSkills, attachedFiles, selectedComputeTarget, thinkingDisabled, thinkingLevel],
  );

  const handleSend = useCallback(
    async (text: string, intent: SendIntent) => {
      if (budgetState === "exceeded") return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const sendNow = () =>
        send(
          trimmed,
          selectedModel.id,
          {
            attachments: attachedFiles,
            skills: selectedSkills.map((s) => s.name),
            databases: selectedDbs.map((db) => db.name),
          },
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
          thinkingDisabled ? undefined : thinkingLevel,
        );
      const route = routeSubmit(isStreaming, intent);
      if (route === "queue") {
        enqueue(trimmed);
        return;
      }
      if (route === "steer") {
        const result = await steer(trimmed);
        if (result === "ok") return;
        if (result === "not_streaming") {
          // The run ended while we typed: keep ordering behind any queue.
          if (steerNotStreamingFallback(messageQueueLengthRef.current) === "queue") enqueue(trimmed);
          else void sendNow();
          return;
        }
        composerRestoreRef.current?.(trimmed);
        setSteerError("Couldn't deliver the steering message — your text was restored.");
        return;
      }
      await sendNow();
    },
    [
      budgetState,
      isStreaming,
      steer,
      enqueue,
      send,
      selectedModel,
      selectedComputeTarget,
      selectedDbs,
      selectedSkills,
      attachedFiles,
      thinkingDisabled,
      thinkingLevel,
    ],
  );

  const handleStop = useCallback(async () => {
    const restored = await stop();
    if (restored.length > 0) composerRestoreRef.current?.(restored.join("\n"));
  }, [stop]);

  // Imperatively launch a workflow into this tab (called by parent on the
  // active tab when the user hits "Launch" on a workflow template).
  useImperativeHandle(
    ref,
    () => ({
      stop,
      sendQuick: async (prompt: string) => {
        if (budgetState === "exceeded") return;
        await send(
          prompt,
          selectedModel.id,
          undefined,
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
          thinkingDisabled ? undefined : thinkingLevel,
        );
      },
      launchWorkflow: async (prompt, model, suggestedSkills, uploadedFiles) => {
        if (budgetState === "exceeded") return;
        setSelectedModel(model);
        const fileRefs = uploadedFiles.length > 0 ? "\n" + uploadedFiles.join("\n") : "";
        const skillsCtx = suggestedSkills.length > 0
          ? `\n\nMake sure to use the skills: ${suggestedSkills.map((s) => `'${s}'`).join(", ")}`
          : "";
        const fullPrompt = prompt + fileRefs + skillsCtx;
        await send(
          fullPrompt,
          model.id,
          {
            attachments: uploadedFiles,
            skills: suggestedSkills,
            databases: [],
          },
          model.fusionConfig,
          selectedComputeTarget?.id,
          thinkingUnsupported(model) ? undefined : thinkingLevel,
        );
      },
    }),
    [
      send,
      stop,
      budgetState,
      selectedModel.id,
      selectedModel.fusionConfig,
      selectedComputeTarget?.id,
      thinkingDisabled,
      thinkingLevel,
    ],
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
              description="I can research topics, write code, and analyze data."
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.role === "assistant" ? (
                    <AssistantMessageBody
                      message={message}
                      isStreaming={isStreaming}
                      sessionId={sessionId}
                    />
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
                    {typeof message.runCostUsd === "number" &&
                      message.runCostUsd > 0 && (
                        <InfoTooltip
                          content={
                            <>
                              <b>Cost of this reply</b>
                              <br />
                              {formatUsd(message.runCostUsd)}
                              {typeof message.runTokens === "number" &&
                              message.runTokens > 0
                                ? ` · ${message.runTokens.toLocaleString()} tokens`
                                : ""}
                            </>
                          }
                        >
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatUsd(message.runCostUsd)}
                          </span>
                        </InfoTooltip>
                      )}
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
            isActiveTab={isActiveTab}
            allFiles={allFiles}
            attachedFiles={attachedFiles}
            onAddFile={addAttachedFile}
            onRemoveFile={removeAttachedFile}
            onClearFiles={clearAttachedFiles}
            onSend={handleSend}
            pendingSteers={pendingSteers}
            composerRestoreRef={composerRestoreRef}
            inlineError={steerError}
            isStreaming={isStreaming}
            agentStatus={status}
            onStop={handleStop}
            selectedDbs={selectedDbs}
            onDbsChange={setSelectedDbs}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            selectedComputeTarget={selectedComputeTarget}
            onComputeTargetChange={setSelectedComputeTarget}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={setThinkingLevel}
            thinkingDisabled={thinkingDisabled}
            modalConfigured={modalConfigured}
            onUploadFiles={uploadFiles}
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
