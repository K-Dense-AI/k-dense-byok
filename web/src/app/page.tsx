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
import { FileTreePanel } from "@/components/sandbox-panel";
import { FilePreviewPanel } from "@/components/file-preview-panel";
import { DatabaseSelector, buildDatabaseContext, type Database } from "@/components/database-selector";
import { ComputeSelector, buildComputeContext, type ModalInstance } from "@/components/compute-selector";
import { ModelSelector, DEFAULT_MODEL, type Model } from "@/components/model-selector";
import { SkillsSelector, buildSkillsContext, type Skill } from "@/components/skills-selector";
import { ProvenancePanel } from "@/components/provenance-panel";
import { WorkflowsPanel } from "@/components/workflows-panel";
import { useAgent, type ActivityItem } from "@/lib/use-agent";
import { useConfig } from "@/lib/use-config";
import { useSkills } from "@/lib/use-skills";
import type { TurnMeta } from "@/lib/provenance";
import { useSandbox, fileCategory, type TreeNode } from "@/lib/use-sandbox";
import {
  CopyIcon,
  CheckIcon,
  LoaderCircleIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  FileIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileTextIcon,
  FileImageIcon,
  BookOpenIcon,
  ActivityIcon,
  TableIcon,
  XIcon,
  PaperclipIcon,
  ChevronDownIcon,
  ScrollTextIcon,
  MessageSquareTextIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";

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

const FILE_DRAG_TYPE = "application/x-kady-filepath";

/**
 * Must be rendered inside <PromptInputProvider>.
 * Accepts both internal file-path drags (from file tree / tabs) and
 * OS file drops from outside the browser.
 */
function PromptDropZone({
  children,
  onFileDrop,
  onFilesUpload,
}: {
  children: React.ReactNode;
  onFileDrop?: (path: string) => void;
  onFilesUpload?: (files: FileList) => void;
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
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      // Internal file-path drag from tree/tabs
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

      // OS file drop from outside the browser
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && onFilesUpload) {
        onFilesUpload(e.dataTransfer.files);
      }
    },
    [controller, onFileDrop, onFilesUpload]
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

function flattenFiles(node: TreeNode | null): string[] {
  if (!node) return [];
  const paths: string[] = [];
  function walk(n: TreeNode) {
    if (n.type === "file") paths.push(n.path);
    for (const c of n.children ?? []) walk(c);
  }
  walk(node);
  return paths;
}

function mentionIconForFile(name: string): ReactNode {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cat = fileCategory(name);
  if (cat === "notebook") return <BookOpenIcon className="size-3.5 text-orange-500" />;
  if (cat === "fasta") return <ActivityIcon className="size-3.5 text-cyan-600" />;
  if (cat === "biotable") return <TableIcon className="size-3.5 text-indigo-500" />;
  if (cat === "image") return <FileImageIcon className="size-3.5 text-rose-500" />;
  if (cat === "markdown") return <FileTextIcon className="size-3.5 text-emerald-600" />;
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

function FileChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = path.split("/").pop() ?? path;
  return (
    <div className="group flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/60 pl-1.5 pr-1 py-1 text-xs transition-colors hover:bg-muted">
      <span className="shrink-0">{mentionIconForFile(name)}</span>
      <span className="max-w-[140px] truncate font-medium text-foreground/80">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:!text-destructive"
        aria-label={`Remove ${name}`}
      >
        <XIcon className="size-2.5" />
      </button>
    </div>
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

  if (items.length === 0 && !isStreaming) return null;

  return (
    <div className="mb-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
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
        <ChevronDownIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>
      {items.length > 0 ? (
        <div
          className={cn(
            "relative overflow-hidden transition-all duration-200",
            expanded ? "max-h-[2000px] mt-2" : "max-h-24 mt-2"
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
          {!expanded && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-muted/60 to-transparent rounded-b-xl" />
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

/**
 * Full prompt input: @ mention overlay + drag-drop zone.
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
  onUploadFiles,
  modalConfigured,
  allSkills,
  selectedSkills,
  onSkillsChange,
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
  onUploadFiles: (files: FileList | File[]) => Promise<string[]>;
  modalConfigured: boolean;
  allSkills: Skill[];
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
}) {
  const controller = usePromptInputController();

  const handleFilesUpload = useCallback(async (files: FileList) => {
    const paths = await onUploadFiles(files);
    for (const p of paths) onAddFile(p);
  }, [onUploadFiles, onAddFile]);

  // Wrap onSubmit to append attached file paths and database context, then clear chips
  const handleSubmit = useCallback<Parameters<typeof PromptInput>[0]["onSubmit"]>(
    (msg, event) => {
      const refs = attachedFiles.length > 0 ? "\n" + attachedFiles.join("\n") : "";
      const dbCtx = buildDatabaseContext(selectedDbs);
      const computeCtx = buildComputeContext(selectedCompute);
      const skillsCtx = buildSkillsContext(selectedSkills);
      onSubmit({ ...msg, text: msg.text + refs + dbCtx + computeCtx + skillsCtx }, event);
      onClearFiles();
    },
    [onSubmit, attachedFiles, onClearFiles, selectedDbs, selectedCompute, selectedSkills]
  );

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAtIdx, setMentionAtIdx] = useState(0);
  const [mentionSelIdx, setMentionSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filtered + sorted file list for the current query
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

  // Close mention when selection goes out of range
  useEffect(() => {
    if (mentionSelIdx >= filteredFiles.length) setMentionSelIdx(0);
  }, [filteredFiles.length, mentionSelIdx]);

  // Scroll selected item into view
  useEffect(() => {
    listRef.current
      ?.children[mentionSelIdx]
      ?.scrollIntoView({ block: "nearest" });
  }, [mentionSelIdx]);

  const closeMention = useCallback(() => setMentionQuery(null), []);

  const applyMention = useCallback((path: string) => {
    // Strip the @query text from the input and add a chip instead
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
    // Match last @ that isn't preceded by a non-space character (i.e., starts a mention)
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

  const isMentionOpen = mentionQuery !== null && filteredFiles.length > 0;
  const submitStatus = isStreaming ? "streaming" : agentStatus === "error" ? "error" : "ready";

  return (
    <PromptDropZone onFileDrop={onAddFile} onFilesUpload={handleFilesUpload}>
      {/* Relative container so the dropdown can be absolute-positioned above the input */}
      <div className="relative">
        {/* @ mention dropdown */}
        {isMentionOpen && (
          <div
            className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border bg-background shadow-lg"
            onMouseDown={(e) => e.preventDefault()} // prevent textarea blur on click
          >
            {/* Header */}
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

            {/* File list */}
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

        <PromptInput onSubmit={handleSubmit} className="rounded-xl border shadow-sm">
          {/* Attached file chips */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachedFiles.map(path => (
                <FileChip key={path} path={path} onRemove={() => onRemoveFile(path)} />
              ))}
            </div>
          )}
          <PromptInputTextarea
            placeholder="Ask Kady anything… (@ for files, drag to attach)"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
          <PromptInputFooter>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ModelSelector selected={selectedModel} onChange={onModelChange} />
              <DatabaseSelector selected={selectedDbs} onChange={onDbsChange} />
              <ComputeSelector selected={selectedCompute} onChange={onComputeChange} modalConfigured={modalConfigured} />
              <SkillsSelector skills={allSkills} selected={selectedSkills} onChange={onSkillsChange} />
            </div>
            <PromptInputSubmit
              className="shrink-0"
              status={submitStatus as "streaming" | "error" | "ready"}
              onStop={onStop}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptDropZone>
  );
}

export default function ChatPage() {
  const { messages, status, send, stop, reset } = useAgent();
  const isStreaming = status === "streaming" || status === "submitted";
  const sandbox = useSandbox(isStreaming);
  const config = useConfig();
  const { skills: allSkills } = useSkills();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const turnMetaRef = useRef<Map<string, TurnMeta>>(new Map());
  const prevMessageCount = useRef(0);

  // Resizable panel widths (px)
  const [treeWidth, setTreeWidth] = useState(224);
  const [chatWidth, setChatWidth] = useState(420);
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

  // Auto-refresh sandbox tree when the agent finishes a response
  useEffect(() => {
    if (
      status === "ready" &&
      messages.length > 0 &&
      messages.length !== prevMessageCount.current
    ) {
      prevMessageCount.current = messages.length;
      sandbox.fetchTree();
      sandbox.refreshOpenTabs();
    }
  }, [status, messages.length, sandbox]);

  // Selected LLM model
  const [selectedModel, setSelectedModel] = useState<Model>(DEFAULT_MODEL);

  const handleCopy = useCallback((id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const activeAssistantId =
    [...messages].reverse().find((message) => message.role === "assistant")?.id ??
    null;

  // Flat list of all sandbox file paths for @ mentions
  const allFiles = useMemo(() => flattenFiles(sandbox.tree), [sandbox.tree]);

  // Attached file chips — lifted here so file selection can write to them
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const addAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.includes(path) ? prev : [...prev, path]);
  }, []);
  const removeAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.filter(p => p !== path));
  }, []);
  const clearAttachedFiles = useCallback(() => setAttachedFiles([]), []);

  // Selected data source databases
  const [selectedDbs, setSelectedDbs] = useState<Database[]>([]);

  // Selected Modal compute instance
  const [selectedCompute, setSelectedCompute] = useState<ModalInstance | null>(null);

  // Selected expert skills
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);

  // Chat vs Workflows tab
  const [activeTab, setActiveTab] = useState<"chat" | "workflows">("chat");

  const handleWorkflowLaunch = useCallback(
    async (prompt: string, model: Model, compute: ModalInstance | null, suggestedSkills: string[]) => {
      setSelectedModel(model);
      setSelectedCompute(compute);
      setActiveTab("chat");
      const computeCtx = buildComputeContext(compute);
      const skillsCtx = suggestedSkills.length > 0
        ? `\n\nMake sure to instruct the delegated expert to use the skills: ${suggestedSkills.map((s) => `'${s}'`).join(", ")}`
        : "";
      const fullPrompt = prompt + computeCtx + skillsCtx;
      const msgId = await send(fullPrompt, model.id);
      if (msgId) {
        turnMetaRef.current.set(msgId, {
          model: model.label,
          databases: [],
          compute: compute?.label ?? null,
          skills: suggestedSkills,
          filesAttached: [...attachedFiles],
          timestamp: Date.now(),
        });
      }
    },
    [send, attachedFiles]
  );

  const handleSubmit = useCallback(
    async ({ text }: { text: string }) => {
      const msgId = await send(text, selectedModel.id);
      if (msgId) {
        turnMetaRef.current.set(msgId, {
          model: selectedModel.label,
          databases: selectedDbs.map((db) => db.name),
          compute: selectedCompute?.label ?? null,
          skills: selectedSkills.map((s) => s.name),
          filesAttached: [...attachedFiles],
          timestamp: Date.now(),
        });
      }
    },
    [send, selectedModel, selectedDbs, selectedCompute, selectedSkills, attachedFiles]
  );

  const handleOrganize = useCallback(() => {
    send("Organize all the files in the sandbox directory", selectedModel.id);
  }, [send, selectedModel]);

  // Selecting a file in the preview auto-attaches it to the chat input
  const handleFileSelect = useCallback((path: string) => {
    sandbox.selectFile(path);
    addAttachedFile(path);
  }, [sandbox, addAttachedFile]);

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b px-6 py-3">
        <a href="https://www.k-dense.ai" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
          <Image
            src="/brand/kdense-logo.png"
            alt="K-Dense BYOK"
            width={120}
            height={28}
            className="h-7 w-auto object-contain"
            priority
          />
          <span className="text-sm font-semibold tracking-tight text-foreground/80">BYOK</span>
        </a>
        <p className="absolute left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/60 tracking-wide select-none">
          Brought to you by K-Dense, Inc.
        </p>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <>
              <button
                onClick={() => setProvenanceOpen(true)}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Session provenance"
              >
                <ScrollTextIcon className="size-4" />
              </button>
              <button
                onClick={reset}
                className="rounded-lg px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
              >
                New chat
              </button>
            </>
          )}
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={panelOpen ? "Hide sandbox" : "Show sandbox"}
          >
            {panelOpen ? (
              <PanelLeftCloseIcon className="size-4" />
            ) : (
              <PanelLeftIcon className="size-4" />
            )}
          </button>
        </div>
      </header>

      {/* Main content area — three columns: file tree | preview | chat */}
      <div className={cn("flex flex-1 overflow-hidden", isResizing && "select-none")}>

        {/* Left: file tree */}
        {panelOpen && (
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
              onClose={() => setPanelOpen(false)}
              onUpload={sandbox.uploadFiles}
              onOrganize={handleOrganize}
            />
          </div>
        )}

        {/* Drag handle: tree ↔ preview */}
        {panelOpen && <ResizeHandle onMouseDown={startDrag("tree")} />}

        {/* Middle: file preview with tabs */}
        {panelOpen && (
          <div className="flex-1 min-w-0 overflow-hidden">
            <FilePreviewPanel
              tabs={sandbox.tabs}
              activeTabPath={sandbox.activeTabPath}
              onTabSelect={handleFileSelect}
              onTabClose={sandbox.closeTab}
              onDownload={sandbox.downloadFile}
              onSaveText={sandbox.saveFile}
              onSaveImageBlob={sandbox.saveImageBlob}
            />
          </div>
        )}

        {/* Drag handle: preview ↔ chat */}
        {panelOpen && <ResizeHandle onMouseDown={startDrag("chat")} />}

        {/* Right: chat / workflows — fills all space when sandbox is hidden */}
        <div className={`flex flex-col border-l overflow-hidden ${panelOpen ? "shrink-0" : "flex-1"}`} style={{ width: panelOpen ? chatWidth : undefined }}>

          {/* Tab bar */}
          <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            <button
              onClick={() => setActiveTab("chat")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                activeTab === "chat"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <MessageSquareTextIcon className="size-3.5" />
              Chat
              {messages.length > 0 && (
                <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                  {messages.filter(m => m.role === "user").length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("workflows")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                activeTab === "workflows"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <WorkflowIcon className="size-3.5" />
              Workflows
            </button>
          </div>

          {/* Tab content */}
          {activeTab === "chat" ? (
            <>
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
                                onClick={() =>
                                  handleCopy(message.id, message.content)
                                }
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
                    onUploadFiles={sandbox.uploadFiles}
                    modalConfigured={config.modalConfigured}
                    allSkills={allSkills}
                    selectedSkills={selectedSkills}
                    onSkillsChange={setSelectedSkills}
                  />
                </PromptInputProvider>
              </div>
            </>
          ) : (
            <WorkflowsPanel
              onLaunch={handleWorkflowLaunch}
              onUploadFiles={sandbox.uploadFiles}
              modalConfigured={config.modalConfigured}
            />
          )}
        </div>

      </div>

      {provenanceOpen && (
        <ProvenancePanel
          messages={messages}
          turnMeta={turnMetaRef.current}
          onClose={() => setProvenanceOpen(false)}
        />
      )}
    </div>
  );
}
