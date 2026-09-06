"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  API_BASE,
  apiFetch,
  getActiveProjectId,
  useProjectScopeId,
} from "@/lib/projects";
import { getViewerDef } from "@/lib/viewers/registry";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  size?: number;
  children?: TreeNode[];
}

export type FileCategory =
  | "image"
  | "pdf"
  | "markdown"
  | "csv"
  | "notebook"
  | "fasta"
  | "biotable"
  | "latex"
  | "anndata"
  | "molecule2d"
  | "structure3d"
  | "massspec"
  | "arraydata"
  | "phylo"
  | "alignment"
  | "dicom"
  | "nifti"
  | "microscopy"
  | "text";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "heic"]);

const FASTA_EXTS = new Set(["fasta", "fa", "faa", "fna", "ffn", "fastq", "fq"]);

const BIOTABLE_EXTS = new Set(["vcf", "bed", "gff", "gtf", "gff3", "sam", "tsv", "bcf"]);

const LATEX_EXTS = new Set(["tex", "latex"]);

const MOLECULE2D_EXTS = new Set(["smi", "smiles", "inchi", "mol", "sdf", "mol2"]);

const STRUCTURE3D_EXTS = new Set(["pdb", "ent", "cif", "mmcif", "xyz", "gro", "pdbqt"]);

const MASSSPEC_EXTS = new Set(["mzml", "mzxml", "mgf", "jdx", "dx"]);

const ARRAYDATA_EXTS = new Set(["h5", "hdf5", "parquet", "npy", "npz", "nc", "nc4", "cdf"]);

const PHYLO_EXTS = new Set(["nwk", "newick", "tree", "nhx"]);

const ALIGNMENT_EXTS = new Set(["aln", "clustal", "sto", "stk", "phy", "phylip"]);

const MICROSCOPY_EXTS = new Set(["tif", "tiff"]);

export function fileCategory(name: string): FileCategory {
  const lower = name.toLowerCase();
  // Handle compound extensions like .h5ad.gz before the generic split
  if (lower.endsWith(".h5ad") || lower.endsWith(".h5ad.gz")) return "anndata";
  if (lower.endsWith(".nii") || lower.endsWith(".nii.gz")) return "nifti";
  if (lower.endsWith(".ome.tif") || lower.endsWith(".ome.tiff")) return "microscopy";
  const ext = lower.split(".").pop() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MICROSCOPY_EXTS.has(ext)) return "microscopy";
  if (ext === "dcm" || ext === "dicom") return "dicom";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "ipynb") return "notebook";
  if (FASTA_EXTS.has(ext)) return "fasta";
  if (BIOTABLE_EXTS.has(ext)) return "biotable";
  if (LATEX_EXTS.has(ext)) return "latex";
  if (MOLECULE2D_EXTS.has(ext)) return "molecule2d";
  if (STRUCTURE3D_EXTS.has(ext)) return "structure3d";
  if (MASSSPEC_EXTS.has(ext)) return "massspec";
  if (ARRAYDATA_EXTS.has(ext)) return "arraydata";
  if (PHYLO_EXTS.has(ext)) return "phylo";
  if (ALIGNMENT_EXTS.has(ext)) return "alignment";
  return "text";
}

export function rawFileUrl(path: string, projectId = getActiveProjectId()): string {
  const project = encodeURIComponent(projectId);
  return `${API_BASE}/sandbox/raw?path=${encodeURIComponent(path)}&project=${project}`;
}

export function anndataSummaryUrl(path: string, projectId = getActiveProjectId()): string {
  const project = encodeURIComponent(projectId);
  return `${API_BASE}/sandbox/anndata-summary?path=${encodeURIComponent(path)}&project=${project}`;
}

export function anndataEmbeddingUrl(
  path: string,
  key: string,
  color?: string | null,
  projectId = getActiveProjectId(),
): string {
  const params = new URLSearchParams({
    path,
    key,
    project: projectId,
  });
  if (color) params.set("color", color);
  return `${API_BASE}/sandbox/anndata-embedding.png?${params.toString()}`;
}

export function sciSummaryUrl(
  path: string,
  kind: string,
  projectId = getActiveProjectId(),
): string {
  const params = new URLSearchParams({ path, kind, project: projectId });
  return `${API_BASE}/sandbox/sci-summary?${params.toString()}`;
}

export function sciRenderUrl(
  path: string,
  kind: string,
  index = 0,
  axis?: string,
  projectId = getActiveProjectId(),
): string {
  const params = new URLSearchParams({
    path, kind, index: String(index), project: projectId,
  });
  if (axis) params.set("axis", axis);
  return `${API_BASE}/sandbox/sci-render.png?${params.toString()}`;
}

/** Last segment of a sandbox-relative path (paths are always `/`-separated). */
function baseName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

export function flattenFiles(node: TreeNode | null): string[] {
  if (!node) return [];
  const paths: string[] = [];
  function walk(current: TreeNode) {
    if (current.type === "file") paths.push(current.path);
    for (const child of current.children ?? []) walk(child);
  }
  walk(node);
  return paths;
}

export interface Tab {
  path: string;
  content: string | null;
  loading: boolean;
}

export interface SandboxPersistenceState {
  openPaths: string[];
  activePath: string | null;
}

export interface LatexCompileResult {
  success: boolean;
  pdf_path: string | null;
  log: string;
  errors: string[];
  synctex: boolean;
}

export function useSandbox(
  isActive = false,
  projectId?: string,
  initialState?: SandboxPersistenceState,
  onStateChange?: (state: SandboxPersistenceState) => void,
) {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const scopedFetch = useCallback(
    (requestPath: string, init: RequestInit = {}) =>
      apiFetch(requestPath, init, scopedProjectId),
    [scopedProjectId],
  );
  const [tree, setTree] = useState<TreeNode | null>(null);
  const initialOpenPaths = useRef(
    [...new Set(initialState?.openPaths ?? [])].filter((path) => !!path.trim()),
  );
  const initialActivePath =
    initialState?.activePath && initialOpenPaths.current.includes(initialState.activePath)
      ? initialState.activePath
      : initialOpenPaths.current[0] ?? null;
  const [tabs, setTabs] = useState<Tab[]>(() =>
    initialOpenPaths.current.map((path) => ({ path, content: null, loading: true })),
  );
  const [activeTabPath, setActiveTabPath] = useState<string | null>(initialActivePath);
  const [uploading, setUploading] = useState(false);

  // Refs for synchronous reads inside callbacks (avoids stale closures)
  const tabsRef = useRef<Tab[]>(tabs);
  const openPathsRef = useRef<Set<string>>(new Set(initialOpenPaths.current));
  const treeRequestRef = useRef<Promise<void> | null>(null);
  const treeEtagRef = useRef<string | null>(null);
  const fileEtags = useRef(new Map<string, string>());
  const fileRequests = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  const fileGenerations = useRef(new Map<string, object>());
  const savingPaths = useRef(new Set<string>());
  const refreshRequest = useRef<Promise<void> | null>(null);
  const scopeEpoch = useRef(0);
  const invalidateFile = useCallback((path: string) => {
    fileRequests.current.get(path)?.controller.abort();
    fileRequests.current.delete(path);
    fileEtags.current.delete(path);
    fileGenerations.current.delete(path);
  }, []);
  useEffect(() => () => {
    for (const request of fileRequests.current.values()) request.controller.abort();
    fileRequests.current.clear();
    fileEtags.current.clear();
    fileGenerations.current.clear();
    scopeEpoch.current++;
    refreshRequest.current = null;
  }, [scopedProjectId]);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  useEffect(() => {
    onStateChange?.({
      openPaths: tabs.map((tab) => tab.path),
      activePath: activeTabPath,
    });
  }, [activeTabPath, onStateChange, tabs]);

  const fetchTree = useCallback((): Promise<void> => {
    // Streaming and manual refreshes can land close together. Reuse the
    // current request instead of making the backend walk the same tree twice.
    if (treeRequestRef.current) return treeRequestRef.current;

    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await scopedFetch(`/sandbox/tree`, {
          signal: controller.signal,
          headers: treeEtagRef.current
            ? { "If-None-Match": treeEtagRef.current }
            : undefined,
        });
        if (res.status === 304) return;
        if (!res.ok) return;
        const etag = res.headers?.get?.("etag");
        if (etag) treeEtagRef.current = etag;
        const data = await res.json() as TreeNode;
        setTree(data);
        const existingPaths = new Set(flattenFiles(data));
        const current = tabsRef.current;
        const next = current.filter((tab) => {
          if (existingPaths.has(tab.path)) return true;
          invalidateFile(tab.path);
          return false;
        });
        if (next.length !== current.length) {
          tabsRef.current = next;
          openPathsRef.current = new Set(next.map((tab) => tab.path));
          setTabs(next);
          setActiveTabPath((active) =>
            active && existingPaths.has(active) ? active : next[0]?.path ?? null,
          );
        }
      } catch {
        // silently fail -- sandbox may not exist yet, or request timed out
      } finally {
        clearTimeout(timeout);
      }
    })();

    treeRequestRef.current = request;
    void request.finally(() => {
      if (treeRequestRef.current === request) treeRequestRef.current = null;
    });
    return request;
  }, [invalidateFile, scopedFetch]);

  const closeTab = useCallback((path: string) => {
    invalidateFile(path);
    openPathsRef.current.delete(path);
    const current = tabsRef.current;
    const idx = current.findIndex((t) => t.path === path);
    const newTabs = current.filter((t) => t.path !== path);
    tabsRef.current = newTabs;
    setTabs(newTabs);
    setActiveTabPath((prev) => {
      if (prev !== path) return prev;
      return newTabs[Math.min(idx, newTabs.length - 1)]?.path ?? null;
    });
  }, [invalidateFile]);

  // Fetch file body into an open tab, handling timeout/error bookkeeping.
  // Kept as its own callback so retryFile can reuse it without re-adding
  // the tab.
  const fetchFileContent = useCallback((path: string, refresh = false): Promise<void> => {
    if (savingPaths.current.has(path)) return Promise.resolve();
    const pending = fileRequests.current.get(path);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const request = { controller, promise: Promise.resolve() };
    fileRequests.current.set(path, request);
    const generation = fileGenerations.current.get(path) ?? {};
    fileGenerations.current.set(path, generation);
    const isCurrent = () => fileGenerations.current.get(path) === generation;
    const update = (content: string) => {
      setTabs((prev) => {
        if (!isCurrent()) return prev;
        let changed = false;
        const next = prev.map((tab) => {
          if (tab.path !== path || (tab.content === content && !tab.loading)) return tab;
          changed = true;
          return { ...tab, content, loading: false };
        });
        if (!changed) return prev;
        tabsRef.current = next;
        return next;
      });
    };
    request.promise = (async () => {
      const timeout = setTimeout(() => controller.abort(), refresh ? 5000 : 20000);
      try {
        const etag = fileEtags.current.get(path);
        const res = await scopedFetch(`/sandbox/file?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
          headers: etag ? { "If-None-Match": etag } : undefined,
        });
        if (!isCurrent() || controller.signal.aborted || res.status === 304) return;
        const content = res.ok ? await res.text() : `[Error: ${res.status} ${res.statusText}]`;
        if (!isCurrent() || controller.signal.aborted) return;
        const nextEtag = res.ok ? res.headers.get("etag") : null;
        if (nextEtag) fileEtags.current.set(path, nextEtag);
        else fileEtags.current.delete(path);
        update(content);
      } catch {
        if (!refresh && isCurrent()) {
          fileEtags.current.delete(path);
          openPathsRef.current.delete(path);
          update("[Error: Could not load file — click to retry]");
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    void request.promise.finally(() => {
      // Mutation generations outlive requests so deferred React updaters
      // remain valid after completion, but never after close/save/rename.
      if (fileRequests.current.get(path) === request) fileRequests.current.delete(path);
    });
    return request.promise;
  }, [scopedFetch]);

  useEffect(() => {
    for (const path of initialOpenPaths.current) {
      const name = path.split("/").pop() ?? "";
      const category = fileCategory(name);
      const definition = getViewerDef(category);
      const loadMode = definition
        ? definition.loadMode
        : category === "image" || category === "pdf" || category === "anndata"
          ? "none"
          : "text";
      if (loadMode === "text") {
        void fetchFileContent(path);
      } else {
        setTabs((current) => {
          const next = current.map((tab) =>
            tab.path === path ? { ...tab, loading: false } : tab,
          );
          tabsRef.current = next;
          return next;
        });
      }
    }
  }, [fetchFileContent]);

  const selectFile = useCallback(async (path: string) => {
    setActiveTabPath(path);

    // Tab already open — just switch to it
    if (openPathsRef.current.has(path)) return;
    openPathsRef.current.add(path);

    const newTab: Tab = { path, content: null, loading: true };
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      const next = [...prev, newTab];
      tabsRef.current = next;
      return next;
    });

    const name = path.split("/").pop() ?? "";
    const cat = fileCategory(name);

    const def = getViewerDef(cat);
    const loadMode = def
      ? def.loadMode
      : cat === "image" || cat === "pdf" || cat === "anndata" ? "none" : "text";
    if (loadMode !== "text") {
      setTabs((prev) => {
        const next = prev.map((t) => (t.path === path ? { ...t, loading: false } : t));
        tabsRef.current = next;
        return next;
      });
      return;
    }
    await fetchFileContent(path);
  }, [fetchFileContent]);

  const retryFile = useCallback(async (path: string) => {
    invalidateFile(path);
    openPathsRef.current.add(path);
    setTabs((prev) => {
      const next = prev.map((t) =>
        t.path === path ? { ...t, content: null, loading: true } : t,
      );
      tabsRef.current = next;
      return next;
    });
    await fetchFileContent(path);
  }, [fetchFileContent, invalidateFile]);

  const uploadFiles = useCallback(
    async (files: FileList | File[], paths?: string[]): Promise<string[]> => {
      if (!files.length) return [];
      setUploading(true);
      try {
        const body = new FormData();
        const arr = Array.from(files);
        for (let i = 0; i < arr.length; i++) {
          body.append("files", arr[i]);
          body.append(
            "paths",
            paths?.[i] || (arr[i] as File & { webkitRelativePath?: string }).webkitRelativePath || "",
          );
        }
        const res = await scopedFetch(`/sandbox/upload`, { method: "POST", body });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(detail?.detail || `Upload failed (${res.status})`);
        }
        const data = await res.json();
        await fetchTree();
        // The backend parks an upload beside a same-named file rather than
        // overwriting it. Say so, or the user is left looking for a file that
        // isn't where they expect and assuming their original was replaced.
        const renamed = (data.renamed as { from: string; to: string }[] | undefined) ?? [];
        if (renamed.length === 1) {
          toast.info(`"${baseName(renamed[0].from)}" already existed`, {
            description: `Saved as "${baseName(renamed[0].to)}" so the original is untouched.`,
          });
        } else if (renamed.length > 1) {
          toast.info(`${renamed.length} files already existed`, {
            description: "They were saved under numbered names so the originals are untouched.",
          });
        }
        return (data.uploaded as string[]) ?? [];
      } catch (err) {
        // Silently returning [] made a rejected upload (too large, backend
        // down) look like a no-op the user could only detect by hunting the
        // file tree.
        toast.error("Upload failed", {
          description: err instanceof Error ? err.message : "The files were not saved.",
        });
        return [];
      } finally {
        setUploading(false);
      }
    },
    [fetchTree, scopedFetch],
  );

  const saveFile = useCallback(async (path: string, content: string): Promise<boolean> => {
    savingPaths.current.add(path);
    invalidateFile(path);
    try {
      const res = await scopedFetch(
        `/sandbox/file?path=${encodeURIComponent(path)}`,
        { method: "PUT", body: content, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
      if (res.ok) {
        setTabs((prev) => {
          const next = prev.map((t) => (t.path === path ? { ...t, content } : t));
          tabsRef.current = next;
          return next;
        });
      }
      return res.ok;
    } catch {
      return false;
    } finally {
      invalidateFile(path);
      savingPaths.current.delete(path);
    }
  }, [invalidateFile, scopedFetch]);

  const saveImageBlob = useCallback(async (path: string, blob: Blob): Promise<boolean> => {
    try {
      const res = await scopedFetch(
        `/sandbox/file?path=${encodeURIComponent(path)}`,
        { method: "PUT", body: blob }
      );
      return res.ok;
    } catch {
      return false;
    }
  }, [scopedFetch]);

  const deleteFile = useCallback(
    async (path: string) => {
      try {
        const res = await scopedFetch(
          `/sandbox/file?path=${encodeURIComponent(path)}`,
          { method: "DELETE" }
        );
        if (!res.ok) return;
        closeTab(path);
        await fetchTree();
      } catch {
        // silently fail
      }
    },
    [fetchTree, closeTab, scopedFetch]
  );

  const deleteDir = useCallback(
    async (path: string) => {
      try {
        const res = await scopedFetch(
          `/sandbox/directory?path=${encodeURIComponent(path)}`,
          { method: "DELETE" }
        );
        if (!res.ok) return;
        // Close all tabs under this directory
        const toClose = tabsRef.current
          .filter((t) => t.path === path || t.path.startsWith(path + "/"))
          .map((t) => t.path);
        for (const p of toClose) closeTab(p);
        await fetchTree();
      } catch {
        // silently fail
      }
    },
    [fetchTree, closeTab, scopedFetch]
  );

  const downloadDir = useCallback((path: string) => {
    const project = encodeURIComponent(scopedProjectId);
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-dir?path=${encodeURIComponent(path)}&project=${project}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [scopedProjectId]);

  const downloadFile = useCallback((path: string) => {
    const project = encodeURIComponent(scopedProjectId);
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download?path=${encodeURIComponent(path)}&project=${project}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [scopedProjectId]);

  const downloadAll = useCallback(() => {
    const project = encodeURIComponent(scopedProjectId);
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-all?project=${project}`;
    a.download = "sandbox.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [scopedProjectId]);

  const moveItem = useCallback(
    async (src: string, dest: string): Promise<boolean> => {
      try {
        const res = await scopedFetch(`/sandbox/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ src, dest }),
        });
        if (!res.ok) return false;

        // Remap any open tabs whose paths were under the old location
        const current = tabsRef.current;
        const updated = current.map((t) => {
          if (t.path === src || t.path.startsWith(src + "/")) invalidateFile(t.path);
          if (t.path === src) return { ...t, path: dest };
          if (t.path.startsWith(src + "/"))
            return { ...t, path: dest + t.path.slice(src.length) };
          return t;
        });
        const pathsChanged = updated.some((t, i) => t.path !== current[i].path);
        if (pathsChanged) {
          tabsRef.current = updated;
          openPathsRef.current = new Set(updated.map((t) => t.path));
          setTabs(updated);
          setActiveTabPath((prev) => {
            if (prev === src) return dest;
            if (prev && prev.startsWith(src + "/"))
              return dest + prev.slice(src.length);
            return prev;
          });
        }

        await fetchTree();
        return true;
      } catch {
        return false;
      }
    },
    [fetchTree, invalidateFile, scopedFetch]
  );

  const renameItem = useCallback(
    async (oldPath: string, newName: string): Promise<boolean> => {
      const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
      const dest = parent ? `${parent}/${newName}` : newName;
      return moveItem(oldPath, dest);
    },
    [moveItem]
  );

  const createDir = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const res = await scopedFetch(`/sandbox/mkdir`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) return false;
        await fetchTree();
        return true;
      } catch {
        return false;
      }
    },
    [fetchTree, scopedFetch]
  );

  const compileLatex = useCallback(
    async (path: string, engine = "pdflatex"): Promise<LatexCompileResult> => {
      try {
        const res = await scopedFetch(`/sandbox/compile-latex`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, engine }),
        });
        if (!res.ok) {
          const detail = await res.text();
          return { success: false, pdf_path: null, log: detail, errors: [detail], synctex: false };
        }
        return (await res.json()) as LatexCompileResult;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        return { success: false, pdf_path: null, log: msg, errors: [msg], synctex: false };
      }
    },
    [scopedFetch],
  );

  const refreshOpenTabs = useCallback((): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    const queue = tabsRef.current.filter((tab) => {
      const cat = fileCategory(tab.path);
      const def = getViewerDef(cat);
      return (def ? def.loadMode : ["image", "pdf", "anndata"].includes(cat) ? "none" : "text") === "text";
    });
    // Small bounded fan-out: one slow file doesn't block all other previews.
    const epoch = scopeEpoch.current;
    const worker = async () => {
      for (let tab = queue.shift(); tab; tab = queue.shift()) {
        if (scopeEpoch.current !== epoch) return;
        if (openPathsRef.current.has(tab.path)) await fetchFileContent(tab.path, true);
      }
    };
    const request = Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker)).then(() => {});
    refreshRequest.current = request;
    void request.finally(() => {
      if (refreshRequest.current === request) refreshRequest.current = null;
    });
    return request;
  }, [fetchFileContent]);

  useEffect(() => {
    // Hidden project workspaces stay mounted so their live chat streams can
    // finish, but they must not keep scanning their sandboxes in the
    // background. React reruns this effect and performs an immediate catch-up
    // when the project becomes active again.
    if (!isActive) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // The fast, live refresh during a run is driven elsewhere (page.tsx polls
    // at 1.5s while any tab streams, and refreshes once on turn completion).
    // This base loop is just a slow safety net for changes made outside the
    // app (e.g. the user editing files on disk). Polling hard every 3s while
    // idle — and especially while the tab is hidden — was pure waste, so we
    // back off to 15s and skip entirely when the tab isn't visible. The
    // visibilitychange handler below does an immediate catch-up on return.
    const IDLE_MS = 15000;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, IDLE_MS);
        return;
      }
      await fetchTree();
      if (!cancelled) await refreshOpenTabs();
      if (!cancelled) timer = setTimeout(tick, IDLE_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isActive, fetchTree, refreshOpenTabs]);

  useEffect(() => {
    if (!isActive) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchTree();
        void refreshOpenTabs();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchTree, isActive, refreshOpenTabs]);

  return {
    tree,
    tabs,
    activeTabPath,
    uploading,
    fetchTree,
    selectFile,
    retryFile,
    closeTab,
    saveFile,
    saveImageBlob,
    uploadFiles,
    deleteFile,
    deleteDir,
    downloadFile,
    downloadDir,
    downloadAll,
    moveItem,
    renameItem,
    createDir,
    refreshOpenTabs,
    compileLatex,
  };
}
