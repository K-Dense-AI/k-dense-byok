"use client";

import {
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlusIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { InfoTooltip } from "@/components/ui/info-tooltip";
import { cn } from "@/lib/utils";

export interface ChatTabDescriptor {
  id: string;
  title: string;
  isStreaming: boolean;
  userMessageCount: number;
}

export interface ChatTabsBarProps {
  tabs: ChatTabDescriptor[];
  activeTabId: string;
  view: "chat" | "workflows";
  maxTabs: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onSelectWorkflows: () => void;
}

export function ChatTabsBar({
  tabs,
  activeTabId,
  view,
  maxTabs,
  onSelect,
  onClose,
  onNew,
  onRename,
  onSelectWorkflows,
}: ChatTabsBarProps) {
  const atLimit = tabs.length >= maxTabs;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (tab: ChatTabDescriptor) => {
    setEditingId(tab.id);
    setDraftTitle(tab.title);
  };

  const commitRename = () => {
    if (!editingId) return;
    const next = draftTitle.trim();
    if (next) onRename(editingId, next);
    setEditingId(null);
    setDraftTitle("");
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
      {/* Tabs + plus live in a scrollable region. Without this isolation the
          Workflows pill (after `ml-auto`) gets pushed to the far right of
          the scroll container — off-screen — once the tab strip overflows. */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = view === "chat" && tab.id === activeTabId;
          const canClose = tabs.length > 1;
          const isEditing = editingId === tab.id;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1.5 rounded-md pl-2.5 pr-1 py-1 text-xs font-medium transition-colors max-w-[180px]",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <button
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => startRename(tab)}
                className="flex min-w-0 items-center gap-1.5"
                type="button"
                title={`${tab.title} — double-click to rename`}
              >
                <MessageSquareTextIcon className="size-3.5 shrink-0" />
                {tab.isStreaming && (
                  <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-primary" />
                )}
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setDraftTitle("");
                      }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="w-24 bg-transparent text-xs font-medium outline-none border-b border-primary/40 focus:border-primary"
                    maxLength={40}
                  />
                ) : (
                  <span className="truncate">{tab.title}</span>
                )}
                {tab.userMessageCount > 0 && !isEditing && (
                  <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                    {tab.userMessageCount}
                  </span>
                )}
              </button>
              {!isEditing && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                    type="button"
                    aria-label={`Rename ${tab.title}`}
                    className={cn(
                      "rounded p-0.5 text-muted-foreground/40 transition-all hover:bg-muted-foreground/10 hover:text-foreground",
                      isActive
                        ? "opacity-60 hover:opacity-100"
                        : "opacity-0 group-hover:opacity-60",
                    )}
                    title="Rename tab"
                  >
                    <PencilIcon className="size-3" />
                  </button>
                  {canClose && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                      }}
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      className={cn(
                        "rounded p-0.5 text-muted-foreground/40 transition-all hover:bg-destructive/10 hover:text-destructive",
                        isActive
                          ? "opacity-60 hover:opacity-100"
                          : "opacity-0 group-hover:opacity-60",
                      )}
                      title={
                        tab.isStreaming
                          ? "Close tab (this will cancel the running turn)"
                          : "Close tab"
                      }
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        <InfoTooltip
          content={
            atLimit ? (
              <>
                <b>Tab limit reached</b>
                <br />
                You can have up to {maxTabs} chat tabs running at once. Close
                one to open a new one.
              </>
            ) : (
              <>
                <b>New chat tab</b>
                <br />
                Open another chat in the same project. All tabs share the
                same sandbox files but have independent message history.
              </>
            )
          }
        >
          <button
            onClick={onNew}
            type="button"
            disabled={atLimit}
            aria-label="New chat tab"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </InfoTooltip>
      </div>

      <div className="shrink-0 flex items-center gap-1 pl-2 border-l">
        <InfoTooltip
          content={
            <>
              <b>Workflows</b>
              <br />
              Pre-built scientific pipelines (e.g. RNA-seq, literature
              review). Pick a template, attach inputs, and launch — they
              run in the active chat tab.
            </>
          }
        >
          <button
            onClick={onSelectWorkflows}
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              view === "workflows"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <WorkflowIcon className="size-3.5" />
            Workflows
          </button>
        </InfoTooltip>
      </div>
    </div>
  );
}
