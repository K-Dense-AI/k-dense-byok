"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE, apiFetch, getActiveProjectId, onProjectChange } from "@/lib/projects";
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
  | "text";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "heic"]);

const FASTA_EXTS = new Set(["fasta", "fa", "faa", "fna", "ffn", "fastq", "fq"]);

const BIOTABLE_EXTS = new Set(["vcf", "bed", "gff", "gtf", "gff3", "sam", "tsv", "bcf"]);

const LATEX_EXTS = new Set(["tex", "latex"]);

const MOLECULE2D_EXTS = new Set(["smi", "smiles", "inchi", "mol", "sdf", "mol2"]);

const STRUCTURE3D_EXTS = new Set(["pdb", "ent", "cif", "mmcif", "xyz", "gro", "pdbqt"]);

const MASSSPEC_EXTS = new Set(["mzml", "mzxml", "mgf", "jdx", "dx"]);

export function fileCategory(name: string): FileCategory {
  const lower = name.toLowerCase();
  // Handle compound extensions like .h5ad.gz before the generic split
  if (lower.endsWith(".h5ad") || lower.endsWith(".h5ad.gz")) return "anndata";
  const ext = lower.split(".").pop() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
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
  return "text";
}

export function rawFileUrl(path: string): string {
  const project = encodeURIComponent(getActiveProjectId());
  return `${API_BASE}/sandbox/raw?path=${encodeURIComponent(path)}&project=${project}`;
}

export function anndataSummaryUrl(path: string): string {
  const project = encodeURIComponent(getActiveProjectId());
  return `${API_BASE}/sandbox/anndata-summary?path=${encodeURIComponent(path)}&project=${project}`;
}

export function anndataEmbeddingUrl(
  path: string,
  key: string,
  color?: string | null,
): string {
  const params = new URLSearchParams({
    path,
    key,
    project: getActiveProjectId(),
  });
  if (color) params.set("color", color);
  return `${API_BASE}/sandbox/anndata-embedding.png?${params.toString()}`;
}

export function sciSummaryUrl(path: string, kind: string): string {
  const params = new URLSearchParams({ path, kind, project: getActiveProjectId() });
  return `${API_BASE}/sandbox/sci-summary?${params.toString()}`;
}

export function sciRenderUrl(path: string, kind: string, index = 0): string {
  const params = new URLSearchParams({
    path, kind, index: String(index), project: getActiveProjectId(),
  });
  return `${API_BASE}/sandbox/sci-render.png?${params.toString()}`;
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

export interface LatexCompileResult {
  success: boolean;
  pdf_path: string | null;
  log: string;
  errors: string[];
}

export function useSandbox(isActive = false) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Refs for synchronous reads inside callbacks (avoids stale closures)
  const tabsRef = useRef<Tab[]>([]);
  const openPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const fetchTree = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await apiFetch(`/sandbox/tree`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      setTree(data);
    } catch {
      // silently fail -- sandbox may not exist yet, or request timed out
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  const closeTab = useCallback((path: string) => {
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
  }, []);

  // Fetch file body into an open tab, handling timeout/error bookkeeping.
  // Kept as its own callback so retryFile can reuse it without re-adding
  // the tab.
  const fetchFileContent = useCallback(async (path: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await apiFetch(
        `/sandbox/file?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      );
      const content = res.ok
        ? await res.text()
        : `[Error: ${res.status} ${res.statusText}]`;
      setTabs((prev) => {
        const next = prev.map((t) => (t.path === path ? { ...t, content, loading: false } : t));
        tabsRef.current = next;
        return next;
      });
    } catch {
      // Drop the path so a later click or explicit retry re-fetches cleanly.
      openPathsRef.current.delete(path);
      setTabs((prev) => {
        const next = prev.map((t) =>
          t.path === path ? { ...t, content: "[Error: Could not load file — click to retry]", loading: false } : t
        );
        tabsRef.current = next;
        return next;
      });
    } finally {
      clearTimeout(timeout);
    }
  }, []);

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
    openPathsRef.current.add(path);
    setTabs((prev) => {
      const next = prev.map((t) =>
        t.path === path ? { ...t, content: null, loading: true } : t,
      );
      tabsRef.current = next;
      return next;
    });
    await fetchFileContent(path);
  }, [fetchFileContent]);

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
        const res = await apiFetch(`/sandbox/upload`, { method: "POST", body });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();
        await fetchTree();
        return (data.uploaded as string[]) ?? [];
      } catch {
        return [];
      } finally {
        setUploading(false);
      }
    },
    [fetchTree],
  );

  const saveFile = useCallback(async (path: string, content: string): Promise<boolean> => {
    try {
      const res = await apiFetch(
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
    }
  }, []);

  const saveImageBlob = useCallback(async (path: string, blob: Blob): Promise<boolean> => {
    try {
      const res = await apiFetch(
        `/sandbox/file?path=${encodeURIComponent(path)}`,
        { method: "PUT", body: blob }
      );
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const deleteFile = useCallback(
    async (path: string) => {
      try {
        const res = await apiFetch(
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
    [fetchTree, closeTab]
  );

  const deleteDir = useCallback(
    async (path: string) => {
      try {
        const res = await apiFetch(
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
    [fetchTree, closeTab]
  );

  const downloadDir = useCallback((path: string) => {
    const project = encodeURIComponent(getActiveProjectId());
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-dir?path=${encodeURIComponent(path)}&project=${project}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const downloadFile = useCallback((path: string) => {
    const project = encodeURIComponent(getActiveProjectId());
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download?path=${encodeURIComponent(path)}&project=${project}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const downloadAll = useCallback(() => {
    const project = encodeURIComponent(getActiveProjectId());
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-all?project=${project}`;
    a.download = "sandbox.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const moveItem = useCallback(
    async (src: string, dest: string): Promise<boolean> => {
      try {
        const res = await apiFetch(`/sandbox/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ src, dest }),
        });
        if (!res.ok) return false;

        // Remap any open tabs whose paths were under the old location
        const current = tabsRef.current;
        const updated = current.map((t) => {
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
    [fetchTree]
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
        const res = await apiFetch(`/sandbox/mkdir`, {
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
    [fetchTree]
  );

  const compileLatex = useCallback(
    async (path: string, engine = "pdflatex"): Promise<LatexCompileResult> => {
      try {
        const res = await apiFetch(`/sandbox/compile-latex`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, engine }),
        });
        if (!res.ok) {
          const detail = await res.text();
          return { success: false, pdf_path: null, log: detail, errors: [detail] };
        }
        return (await res.json()) as LatexCompileResult;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        return { success: false, pdf_path: null, log: msg, errors: [msg] };
      }
    },
    [],
  );

  const refreshOpenTabs = useCallback(async () => {
    const current = tabsRef.current;
    for (const tab of current) {
      const name = tab.path.split("/").pop() ?? "";
      const cat = fileCategory(name);
      const def = getViewerDef(cat);
      const loadMode = def
        ? def.loadMode
        : cat === "image" || cat === "pdf" || cat === "anndata" ? "none" : "text";
      if (loadMode !== "text") continue;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await apiFetch(
          `/sandbox/file?path=${encodeURIComponent(tab.path)}`,
          { signal: controller.signal },
        );
        const content = res.ok
          ? await res.text()
          : `[Error: ${res.status} ${res.statusText}]`;
        setTabs((prev) => {
          const next = prev.map((t) => (t.path === tab.path ? { ...t, content } : t));
          tabsRef.current = next;
          return next;
        });
      } catch {
        // silently skip tabs that fail to refresh
      } finally {
        clearTimeout(timeout);
      }
    }
  }, []);

  useEffect(() => {
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
      if (isActive && !cancelled) await refreshOpenTabs();
      if (!cancelled) timer = setTimeout(tick, isActive ? 1500 : IDLE_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isActive, fetchTree, refreshOpenTabs]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchTree();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchTree]);

  useEffect(
    () =>
      onProjectChange(() => {
        openPathsRef.current = new Set();
        tabsRef.current = [];
        setTabs([]);
        setActiveTabPath(null);
        setTree(null);
        void fetchTree();
      }),
    [fetchTree]
  );

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
