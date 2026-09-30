"use client";

import { useId, useMemo, useRef, useState } from "react";
import { FolderUpIcon, LoaderIcon, RefreshCwIcon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface WorkflowInputProps {
  availableFiles?: string[];
  filesReady?: boolean;
  onRefreshFiles?: () => Promise<void>;
  onUploadFiles?: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
}

export function WorkflowInputs({
  availableFiles = [], filesReady = true, onRefreshFiles, onUploadFiles,
  files, onFilesChange, sources, onSourcesChange, uploading, onUploadingChange,
}: WorkflowInputProps & {
  files: string[];
  onFilesChange: (files: string[]) => void;
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
  const matches = useMemo(() => availableFiles.filter((path) => path.toLowerCase().includes(query.trim().toLowerCase())), [availableFiles, query]);

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
    <p className="text-xs text-muted-foreground">Use data already available to BYOK, or upload from this device. You can combine sources.</p>
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
      <summary className="cursor-pointer text-xs font-medium">Choose existing project files</summary>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2">
          <input aria-label="Search project files" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or path" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs" />
          {onRefreshFiles && <Button type="button" size="xs" variant="outline" disabled={refreshing} aria-label="Refresh project files" onClick={async () => {
            setRefreshing(true);
            setError(null);
            try { await onRefreshFiles(); }
            catch { setError("Could not refresh project files. Try again."); }
            finally { setRefreshing(false); }
          }}><RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} /> Refresh</Button>}
        </div>
        {!filesReady ? <p className="text-xs text-muted-foreground">Project file list is not available yet. Refresh to try again, or specify a data location below.</p> : !matches.length ? <p className="text-xs text-muted-foreground">{availableFiles.length ? "No matching files." : "No project files yet. Upload files or specify a data location below."}</p> : <div className="max-h-32 overflow-y-auto rounded border bg-background p-2">
          {matches.slice(0, 100).map((path) => <label key={path} className="flex items-start gap-2 py-1 text-xs">
            <input type="checkbox" checked={files.includes(path)} disabled={uploading} onChange={(e) => onFilesChange(e.target.checked ? [...new Set([...files, path])] : files.filter((file) => file !== path))} />
            <span className="break-all">{path}</span>
          </label>)}
        </div>}
        {matches.length > 100 && <p className="text-xs text-muted-foreground">Showing 100 of {matches.length} files. Search to narrow the list, or enter a folder path below.</p>}
      </div>
    </details>
    <details>
      <summary className="cursor-pointer text-xs font-medium">Use a host path or data URL</summary>
      <label htmlFor={`${id}-sources`} className="mb-1 mt-2 block text-xs font-medium">Data locations (one per line)</label>
      <textarea id={`${id}-sources`} value={sources} onChange={(e) => onSourcesChange(e.target.value)} rows={3}
        placeholder={"/mnt/study/counts.csv\nuser_data/study/\ns3://bucket/study/\nhttps://example.org/data.csv"}
        className="w-full resize-y rounded-md border bg-background px-2 py-1 text-xs" aria-describedby={`${id}-help`} />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">Paths must be readable where BYOK runs. URLs and storage locations need a reachable source and any required connector or host credentials already configured. Kady checks access when the workflow starts. Do not paste secrets or signed URLs here.</p>
    </details>
    {!!files.length && <div className="space-y-1">
      <p className="text-xs font-medium">Selected project files</p>
      <ul className="max-h-24 overflow-y-auto">
        {files.map((path) => <li key={path} className="flex items-start justify-between gap-2 text-xs">
          <span className="break-all">{path}</span>
          <button type="button" disabled={uploading} aria-label={`Remove ${path} from workflow`} onClick={() => onFilesChange(files.filter((file) => file !== path))} className="shrink-0 p-0.5"><XIcon className="size-3" /></button>
        </li>)}
      </ul>
      <p className="text-[11px] text-muted-foreground">Removing a selection keeps the file in the project.</p>
    </div>}
    {uploading && <p role="status" className="text-xs text-muted-foreground">Uploading to the BYOK project…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
