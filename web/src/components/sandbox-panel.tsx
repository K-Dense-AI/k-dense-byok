"use client";

import {
  FileTreeIcon,
  FileTreeName,
  FileTreeActions,
} from "@/components/ai-elements/file-tree";
import { KadyFileIcon } from "@/components/file-icon";
import {
  FILE_TREE_ROW_HEIGHT,
  flattenVisibleTree,
  virtualTreeRange,
  type VisibleTreeRow,
} from "@/lib/file-tree-virtualization";
import { cn } from "@/lib/utils";
import { hasDirectoryEntries, traverseDroppedEntries } from "@/lib/directory-upload";
import { type TreeNode } from "@/lib/use-sandbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderUpIcon,
  XIcon,
  RefreshCwIcon,
  UploadIcon,
  LoaderIcon,
  DownloadIcon,
  ArchiveIcon,
  Trash2Icon,
  WandSparklesIcon,
  PencilIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

const FILE_DRAG_TYPE = "application/x-kady-filepath";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDragGhost(label: string, color: string) {
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.cssText = `position:absolute;top:-1000px;background:${color};color:white;padding:3px 8px;border-radius:4px;font-size:11px;font-family:monospace;box-shadow:0 2px 8px rgba(0,0,0,0.2)`;
  document.body.appendChild(ghost);
  return ghost;
}

// ---------------------------------------------------------------------------
// InlineInput — used for rename and create-directory
// ---------------------------------------------------------------------------

function InlineInput({
  defaultValue,
  onSubmit,
  onCancel,
  placeholder,
}: {
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (defaultValue) {
      const dotIdx = defaultValue.lastIndexOf(".");
      el.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length);
    }
  }, [defaultValue]);

  const submit = useCallback(() => {
    if (submittedRef.current) return;
    const trimmed = value.trim();
    if (trimmed && !trimmed.includes("/")) {
      submittedRef.current = true;
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  }, [value, onSubmit, onCancel]);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={submit}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="h-5 min-w-0 flex-1 truncate rounded border border-primary bg-background px-1 text-xs outline-none"
    />
  );
}

// ---------------------------------------------------------------------------
// Tree renderer
// ---------------------------------------------------------------------------

interface VirtualTreeRowProps {
  row: VisibleTreeRow;
  top: number;
  onSelect: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
  onDownloadDir: (path: string) => void;
  onDeleteDir: (path: string) => void;
  onMove: (src: string, dest: string) => void;
  selectedPath: string | null;
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onRename: (path: string, newName: string) => void;
  onCancelRename: () => void;
  dropTargetPath: string | null;
  setDropTargetPath: (path: string | null) => void;
  onCreateDir: (path: string) => void;
  onCancelCreateDir: () => void;
  onStartCreateDir: (parentPath: string) => void;
  expandedPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
}

const VirtualTreeRow = memo(function VirtualTreeRow({
  row,
  top,
  onSelect,
  onDownload,
  onDelete,
  onDownloadDir,
  onDeleteDir,
  onMove,
  selectedPath,
  renamingPath,
  onStartRename,
  onRename,
  onCancelRename,
  dropTargetPath,
  setDropTargetPath,
  onCreateDir,
  onCancelCreateDir,
  onStartCreateDir,
  expandedPaths,
  onToggleDirectory,
}: VirtualTreeRowProps) {
  const style = {
    height: FILE_TREE_ROW_HEIGHT,
    transform: `translateY(${top}px)`,
    paddingLeft: row.depth * 16 + 8,
  };

  if (row.kind === "create") {
    return (
      <div
        className="absolute inset-x-0 top-0 flex items-center gap-1 pr-2"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={false}
        style={style}
      >
        <span className="size-4 shrink-0" />
        <FolderIcon className="size-4 shrink-0 text-blue-500" />
        <InlineInput
          defaultValue=""
          placeholder="Folder name"
          onSubmit={(name) =>
            onCreateDir(row.parentPath ? `${row.parentPath}/${name}` : name)
          }
          onCancel={onCancelCreateDir}
        />
      </div>
    );
  }

  const { node } = row;
  const isDirectory = node.type === "directory";
  const isExpanded = isDirectory && expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;

  if (isDirectory) {
    return (
      <div
        className={cn(
          "group/folder absolute inset-x-0 top-0 flex cursor-pointer items-center gap-1 rounded pr-2 text-left transition-colors hover:bg-muted/50",
          isSelected && "bg-muted",
          dropTargetPath === node.path && "ring-2 ring-primary/40",
        )}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={isExpanded}
        aria-selected={isSelected}
        tabIndex={0}
        style={style}
        draggable={renamingPath !== node.path}
        onClick={() => onToggleDirectory(node.path)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggleDirectory(node.path);
          }
        }}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData(FILE_DRAG_TYPE, node.path);
          event.dataTransfer.effectAllowed = "copyMove";
          const ghost = makeDragGhost(node.name, "#3b82f6");
          event.dataTransfer.setDragImage(ghost, 0, 0);
          setTimeout(() => ghost.remove(), 0);
        }}
        onDragEnd={() => setDropTargetPath(null)}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTargetPath(node.path);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTargetPath(null);
          const srcPath = event.dataTransfer.getData(FILE_DRAG_TYPE);
          if (!srcPath || srcPath === node.path || node.path.startsWith(`${srcPath}/`)) return;
          const fileName = srcPath.split("/").pop() ?? srcPath;
          const dest = node.path ? `${node.path}/${fileName}` : fileName;
          const srcParent = srcPath.includes("/")
            ? srcPath.slice(0, srcPath.lastIndexOf("/"))
            : "";
          if (srcParent !== node.path) onMove(srcPath, dest);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDropTargetPath(null);
          }
        }}
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        <FileTreeIcon>
          {isExpanded ? (
            <FolderOpenIcon className="size-4 text-blue-500" />
          ) : (
            <FolderIcon className="size-4 text-blue-500" />
          )}
        </FileTreeIcon>
        {renamingPath === node.path ? (
          <InlineInput
            defaultValue={node.name}
            onSubmit={(newName) => onRename(node.path, newName)}
            onCancel={onCancelRename}
          />
        ) : (
          <FileTreeName>{node.name}</FileTreeName>
        )}
        {renamingPath !== node.path && (
          <FileTreeActions>
            <button
              onClick={() => onStartCreateDir(node.path)}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
              title="New folder inside"
            >
              <FolderPlusIcon className="size-3" />
            </button>
            <button
              onClick={() => onStartRename(node.path)}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
              title={`Rename ${node.name}`}
            >
              <PencilIcon className="size-3" />
            </button>
            <button
              onClick={() => onDownloadDir(node.path)}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
              title={`Download ${node.name} as zip`}
            >
              <DownloadIcon className="size-3" />
            </button>
            <button
              onClick={() => onDeleteDir(node.path)}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/folder:opacity-100"
              title={`Delete ${node.name}`}
            >
              <Trash2Icon className="size-3" />
            </button>
          </FileTreeActions>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/file absolute inset-x-0 top-0 flex cursor-pointer items-center gap-1 rounded pr-2 transition-colors hover:bg-muted/50",
        isSelected && "bg-muted",
      )}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      tabIndex={0}
      style={style}
      draggable={renamingPath !== node.path}
      onClick={() => onSelect(node.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.path);
        }
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData(FILE_DRAG_TYPE, node.path);
        event.dataTransfer.effectAllowed = "copyMove";
        const ghost = makeDragGhost(node.name, "#6366f1");
        event.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      }}
      onDragEnd={() => setDropTargetPath(null)}
    >
      <span className="size-4 shrink-0" />
      <FileTreeIcon>
        <KadyFileIcon name={node.name} />
      </FileTreeIcon>
      {renamingPath === node.path ? (
        <InlineInput
          defaultValue={node.name}
          onSubmit={(newName) => onRename(node.path, newName)}
          onCancel={onCancelRename}
        />
      ) : (
        <FileTreeName>{node.name}</FileTreeName>
      )}
      {renamingPath !== node.path && (
        <FileTreeActions>
          <button
            onClick={() => onStartRename(node.path)}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/file:opacity-100"
            title={`Rename ${node.name}`}
          >
            <PencilIcon className="size-3" />
          </button>
          <button
            onClick={() => onDownload(node.path)}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/file:opacity-100"
            title={`Download ${node.name}`}
          >
            <DownloadIcon className="size-3" />
          </button>
          <button
            onClick={() => onDelete(node.path)}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/file:opacity-100"
            title={`Delete ${node.name}`}
          >
            <Trash2Icon className="size-3" />
          </button>
        </FileTreeActions>
      )}
    </div>
  );
});

function countFiles(node: TreeNode): number {
  if (node.type === "file") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countFiles(c), 0);
}

// ---------------------------------------------------------------------------
// FileTreePanel — left sidebar
// ---------------------------------------------------------------------------

interface FileTreePanelProps {
  tree: TreeNode | null;
  selectedPath: string | null;
  uploading: boolean;
  onSelect: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
  onDownloadDir: (path: string) => void;
  onDeleteDir: (path: string) => void;
  onDownloadAll: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onUpload: (files: FileList | File[], paths?: string[]) => void;
  onOrganize?: () => void;
  onMove: (src: string, dest: string) => void;
  onRename: (path: string, newName: string) => void;
  onCreateDir: (path: string) => void;
}

export const FileTreePanel = memo(function FileTreePanel({
  tree,
  selectedPath,
  uploading,
  onSelect,
  onDownload,
  onDelete,
  onDownloadDir,
  onDeleteDir,
  onDownloadAll,
  onRefresh,
  onClose,
  onUpload,
  onOrganize,
  onMove,
  onRename,
  onCreateDir,
}: FileTreePanelProps) {
  const totalFiles = useMemo(() => (tree ? countFiles(tree) : 0), [tree]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // OS file drag-and-drop
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Internal tree features
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingDirIn, setCreatingDirIn] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const hasOsFiles = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(FILE_DRAG_TYPE);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  }, [hasOsFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [hasOsFiles]);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);

    if (hasDirectoryEntries(e.dataTransfer.items)) {
      const { files, paths } = await traverseDroppedEntries(e.dataTransfer.items);
      if (files.length > 0) onUpload(files, paths);
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUpload(e.dataTransfer.files);
    }
  }, [onUpload]);

  const allDirPaths = useMemo(() => {
    const dirs = new Set<string>();
    function collect(node: TreeNode) {
      if (node.type === "directory") {
        dirs.add(node.path);
        for (const child of node.children ?? []) collect(child);
      }
    }
    if (tree) collect(tree);
    return dirs;
  }, [tree]);

  // Directories start collapsed. On restoration, reveal only the ancestors of
  // the persisted selected file instead of eagerly opening the entire tree.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    if (!selectedPath) return new Set();
    const parts = selectedPath.split("/");
    return new Set(
      parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")),
    );
  });
  const visibleExpandedPaths = useMemo(
    () => new Set([...expandedPaths].filter((path) => allDirPaths.has(path))),
    [allDirPaths, expandedPaths],
  );

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleStartCreateDir = useCallback((parentPath: string) => {
    if (parentPath) {
      setExpandedPaths((prev) => {
        if (prev.has(parentPath)) return prev;
        const next = new Set(prev);
        next.add(parentPath);
        return next;
      });
    }
    setCreatingDirIn(parentPath);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onUpload(e.target.files);
        e.target.value = "";
      }
    },
    [onUpload],
  );

  const handleRename = useCallback((path: string, newName: string) => {
    const currentName = path.split("/").pop() ?? path;
    setRenamingPath(null);
    if (newName !== currentName) onRename(path, newName);
  }, [onRename]);

  const handleCreateDir = useCallback((path: string) => {
    setCreatingDirIn(null);
    onCreateDir(path);
  }, [onCreateDir]);
  const handleCancelRename = useCallback(() => setRenamingPath(null), []);
  const handleCancelCreateDir = useCallback(() => setCreatingDirIn(null), []);

  const visibleRows = useMemo(
    () =>
      flattenVisibleTree(
        tree?.children ?? [],
        visibleExpandedPaths,
        creatingDirIn,
      ),
    [creatingDirIn, tree, visibleExpandedPaths],
  );
  const treeViewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const viewport = treeViewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const height = viewport.clientHeight;
      if (height > 0) setViewportHeight(height);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(
    () => virtualTreeRange(visibleRows.length, scrollTop, viewportHeight),
    [scrollTop, viewportHeight, visibleRows.length],
  );

  return (
    <div
      className="relative flex h-full flex-col border-r"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary rounded-md">
          <div className="flex flex-col items-center gap-1.5">
            <UploadIcon className="size-5 text-primary" />
            <span className="text-xs font-medium text-primary">Drop files or folders to upload</span>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <InfoTooltip
            content={
              <>
                <b>Sandbox</b>
                <br />
                Shared working directory the agent can read from and write to.
                Drop files/folders here or upload — they persist across turns
                in this project.
              </>
            }
          >
            <div className="flex items-center gap-2 cursor-help">
              <FolderOpenIcon className="size-4 text-blue-500" />
              <span className="font-semibold text-sm">Sandbox</span>
              {totalFiles > 0 && (
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600 tabular-nums">
                  {totalFiles}
                </span>
              )}
            </div>
          </InfoTooltip>
        </div>
        <div className="flex items-center gap-0.5">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
          {/* @ts-expect-error -- webkitdirectory is non-standard but supported in all major browsers */}
          <input ref={dirInputRef} type="file" webkitdirectory="" className="hidden" onChange={handleFileChange} />
          {totalFiles > 0 && onOrganize && (
            <InfoTooltip
              content={
                <>
                  <b>Auto-organize files</b>
                  <br />
                  Ask the agent to tidy the sandbox — group related files into
                  folders (raw data, figures, notebooks, results). Does not
                  delete anything.
                </>
              }
            >
              <button onClick={onOrganize} aria-label="Auto-organize files" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <WandSparklesIcon className="size-3.5" />
              </button>
            </InfoTooltip>
          )}
          {totalFiles > 0 && (
            <InfoTooltip
              content={
                <>
                  <b>Download all as zip</b>
                  <br />
                  Package the entire sandbox into a <kbd>.zip</kbd> for archiving,
                  sharing with collaborators, or your lab notebook.
                </>
              }
            >
              <button onClick={onDownloadAll} aria-label="Download all as zip" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <ArchiveIcon className="size-3.5" />
              </button>
            </InfoTooltip>
          )}
          <InfoTooltip
            content={
              <>
                <b>New folder</b>
                <br />
                Create a subdirectory at the sandbox root. You can also drag
                files between folders to organize them.
              </>
            }
          >
            <button onClick={() => setCreatingDirIn("")} aria-label="New folder" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <FolderPlusIcon className="size-3.5" />
            </button>
          </InfoTooltip>
          <DropdownMenu>
            <InfoTooltip
              content={
                <>
                  <b>Upload files or folder</b>
                  <br />
                  Add data to the sandbox. Folders preserve their structure.
                  Drag-and-drop anywhere in this panel also works.
                </>
              }
            >
              <DropdownMenuTrigger asChild>
                <button disabled={uploading} aria-label="Upload files or folder" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50">
                  {uploading ? <LoaderIcon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />}
                </button>
              </DropdownMenuTrigger>
            </InfoTooltip>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                <UploadIcon className="mr-2 size-3.5" />
                Upload files
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => dirInputRef.current?.click()}>
                <FolderUpIcon className="mr-2 size-3.5" />
                Upload folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <InfoTooltip
            content={
              <>
                <b>Refresh</b>
                <br />
                Reload the file tree from disk. Useful if you edited files
                outside of Kady.
              </>
            }
          >
            <button onClick={onRefresh} aria-label="Refresh" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <RefreshCwIcon className="size-3.5" />
            </button>
          </InfoTooltip>
          <InfoTooltip content="Hide the sandbox panel">
            <button onClick={onClose} aria-label="Close sandbox panel" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <XIcon className="size-3.5" />
            </button>
          </InfoTooltip>
        </div>
      </div>

      {/* Tree: flatten expanded branches, then mount only the viewport rows. */}
      <div
        ref={treeViewportRef}
        className="flex-1 overflow-y-auto p-2"
        role="tree"
        aria-label="Sandbox files"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {!tree || ((tree.children ?? []).length === 0 && creatingDirIn === null) ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-muted/60">
              <FolderOpenIcon className="size-5 text-muted-foreground/50" />
            </div>
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-muted-foreground">No files yet</p>
              <p className="text-[11px] text-muted-foreground/60">Drop files or folders here, or use the upload button</p>
            </div>
          </div>
        ) : (
          <div
            className="relative rounded-lg bg-background font-mono text-sm"
            style={{ height: range.totalHeight }}
          >
            {visibleRows.slice(range.start, range.end).map((row, index) => (
              <VirtualTreeRow
                key={row.kind === "node" ? row.node.path : `create:${row.parentPath}`}
                row={row}
                top={(range.start + index) * FILE_TREE_ROW_HEIGHT}
                onSelect={onSelect}
                onDownload={onDownload}
                onDelete={onDelete}
                onDownloadDir={onDownloadDir}
                onDeleteDir={onDeleteDir}
                onMove={onMove}
                selectedPath={selectedPath}
                renamingPath={renamingPath}
                onStartRename={setRenamingPath}
                onRename={handleRename}
                onCancelRename={handleCancelRename}
                dropTargetPath={dropTargetPath}
                setDropTargetPath={setDropTargetPath}
                onCreateDir={handleCreateDir}
                onCancelCreateDir={handleCancelCreateDir}
                onStartCreateDir={handleStartCreateDir}
                expandedPaths={visibleExpandedPaths}
                onToggleDirectory={handleToggleDirectory}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
