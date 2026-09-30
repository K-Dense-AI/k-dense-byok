"use client";

import { useId, useMemo, useRef, useState } from "react";
import { FileIcon, FolderIcon, FolderUpIcon, LoaderIcon, RefreshCwIcon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface WorkflowInputProps {
  availableFiles?: string[];
  availableFolders?: string[];
  filesReady?: boolean;
  onRefreshFiles?: () => Promise<void>;
  onUploadFiles?: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
}

export function WorkflowInputs({
  availableFiles = [], availableFolders = [], filesReady = true, onRefreshFiles, onUploadFiles,
  files, onFilesChange, folders, onFoldersChange, sources, onSourcesChange, uploading, onUploadingChange,
}: WorkflowInputProps & {
  files: string[];
  onFilesChange: (files: string[]) => void;
  folders: string[];
  onFoldersChange: (folders: string[]) => void;
  sources: string;
  onSourcesChange: (sources: string) => void;
  uploading: boolean;
  onUploadingChange: (uploading: boolean) => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const entries = useMemo(() => [
    ...availableFolders.map((path) => ({ path, folder: true })),
    ...availableFiles.map((path) => ({ path, folder: false })),
  ], [availableFiles, availableFolders]);
  const matches = useMemo(() => entries.filter(({ path }) => path.toLowerCase().includes(query.trim().toLowerCase())), [entries, query]);
  const selected = [
    ...folders.map((path) => ({ path, folder: true })),
    ...files.map((path) => ({ path, folder: false })),
  ];

  function select(path: string, folder: boolean, checked: boolean) {
    const values = folder ? folders : files;
    const onChange = folder ? onFoldersChange : onFilesChange;
    onChange(checked ? [...new Set([...values, path])] : values.filter((value) => value !== path));
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const picked = Array.from(input.files ?? []);
    if (!picked.length || !onUploadFiles) return;
    onUploadingChange(true);
    setError(null);
    try {
      const paths = await onUploadFiles(picked);
      onFilesChange([...new Set([...files, ...paths])]);
      if (paths.length < picked.length) setError("Some files were not uploaded. Check the selected inputs and retry any missing files.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      input.value = "";
      onUploadingChange(false);
    }
  }

  return <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-xs font-medium">Project sandbox</legend>
      <p className="text-xs text-muted-foreground">Choose files or folders already in this project, including results from earlier chats. These are on the machine running BYOK.</p>
      <div className="flex gap-2">
        <input aria-label="Search sandbox files and folders" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or path" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs" />
        {onRefreshFiles && <Button type="button" size="xs" variant="outline" disabled={refreshing} aria-label="Refresh sandbox files and folders" onClick={async () => {
          setRefreshing(true);
          setError(null);
          try { await onRefreshFiles(); }
          catch { setError("Could not refresh project files. Try again."); }
          finally { setRefreshing(false); }
        }}><RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} /> Refresh</Button>}
      </div>
      {!filesReady ? <p className="text-xs text-muted-foreground">Project file list is not available yet. Refresh to try again, or specify a data location below.</p> : !matches.length ? <p className="text-xs text-muted-foreground">{entries.length ? "No matching files or folders." : "No project files or folders yet. Upload files or specify a data location below."}</p> : <div className="max-h-40 overflow-y-auto rounded border bg-background p-2">
        {matches.slice(0, 100).map(({ path, folder }) => <label key={`${folder}:${path}`} className="flex items-start gap-2 py-1 text-xs">
          <input type="checkbox" checked={(folder ? folders : files).includes(path)} disabled={uploading} onChange={(e) => select(path, folder, e.target.checked)} />
          {folder ? <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="break-all">{path}{folder ? "/" : ""}</span>
        </label>)}
      </div>}
      {matches.length > 100 && <p className="text-xs text-muted-foreground">Showing 100 of {matches.length} files and folders. Search to narrow the list.</p>}
    </fieldset>
    {!!selected.length && <div className="space-y-1">
      <p className="text-xs font-medium">Selected project inputs</p>
      <ul className="max-h-24 overflow-y-auto">
        {selected.map(({ path, folder }) => <li key={`${folder}:${path}`} className="flex items-start justify-between gap-2 text-xs">
          <span className="break-all">{path}{folder ? "/" : ""}</span>
          <button type="button" disabled={uploading} aria-label={`Remove ${path}${folder ? "/" : ""} from workflow`} onClick={() => select(path, folder, false)} className="shrink-0 p-0.5"><XIcon className="size-3" /></button>
        </li>)}
      </ul>
      <p className="text-[11px] text-muted-foreground">Removing a selection keeps the data in the project.</p>
    </div>}
    <p className="text-xs text-muted-foreground">You can also upload from this device or add a host path or data URL. Sources can be combined.</p>
    {onUploadFiles && <div className="flex flex-wrap gap-2">
      <input ref={fileInput} aria-label="Upload workflow files" type="file" multiple className="hidden" onChange={upload} />
      {/* @ts-expect-error -- webkitdirectory is supported in all major browsers */}
      <input ref={folderInput} aria-label="Upload workflow folder" type="file" webkitdirectory="" className="hidden" onChange={upload} />
      <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
        {uploading ? <LoaderIcon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />} Upload files from this device
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => folderInput.current?.click()}>
        <FolderUpIcon className="size-3.5" /> Upload folder
      </Button>
    </div>}
    <details>
      <summary className="cursor-pointer text-xs font-medium">Use a host path or data URL</summary>
      <label htmlFor={`${id}-sources`} className="mb-1 mt-2 block text-xs font-medium">Data locations (one per line)</label>
      <textarea id={`${id}-sources`} value={sources} onChange={(e) => onSourcesChange(e.target.value)} rows={3}
        placeholder={"/mnt/study/counts.csv\nuser_data/study/\ns3://bucket/study/\nhttps://example.org/data.csv"}
        className="w-full resize-y rounded-md border bg-background px-2 py-1 text-xs" aria-describedby={`${id}-help`} />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">Paths must be readable where BYOK runs. URLs and storage locations need a reachable source and any required connector or host credentials already configured. Kady checks access when the workflow starts. Do not paste secrets or signed URLs here.</p>
    </details>
    {uploading && <p role="status" className="text-xs text-muted-foreground">Uploading to the BYOK project…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
