"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";

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
  | "text";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "heic"]);

const FASTA_EXTS = new Set(["fasta", "fa", "faa", "fna", "ffn", "fastq", "fq"]);

const BIOTABLE_EXTS = new Set(["vcf", "bed", "gff", "gtf", "gff3", "sam", "tsv", "bcf"]);

export function fileCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "ipynb") return "notebook";
  if (FASTA_EXTS.has(ext)) return "fasta";
  if (BIOTABLE_EXTS.has(ext)) return "biotable";
  return "text";
}

export function rawFileUrl(path: string): string {
  return `${API_BASE}/sandbox/raw?path=${encodeURIComponent(path)}`;
}

export interface Tab {
  path: string;
  content: string | null;
  loading: boolean;
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
    try {
      const res = await fetch(`${API_BASE}/sandbox/tree`);
      if (!res.ok) return;
      const data = await res.json();
      setTree(data);
    } catch {
      // silently fail -- sandbox may not exist yet
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

  const selectFile = useCallback(async (path: string) => {
    setActiveTabPath(path);

    // Tab already open — just switch to it
    if (openPathsRef.current.has(path)) return;
    openPathsRef.current.add(path);

    const newTab: Tab = { path, content: null, loading: true };
    setTabs((prev) => {
      const next = [...prev, newTab];
      tabsRef.current = next;
      return next;
    });

    const name = path.split("/").pop() ?? "";
    const cat = fileCategory(name);

    if (cat === "image" || cat === "pdf") {
      setTabs((prev) => {
        const next = prev.map((t) => (t.path === path ? { ...t, loading: false } : t));
        tabsRef.current = next;
        return next;
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${API_BASE}/sandbox/file?path=${encodeURIComponent(path)}`,
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
        const res = await fetch(`${API_BASE}/sandbox/upload`, { method: "POST", body });
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
      const res = await fetch(
        `${API_BASE}/sandbox/file?path=${encodeURIComponent(path)}`,
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
      const res = await fetch(
        `${API_BASE}/sandbox/file?path=${encodeURIComponent(path)}`,
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
        const res = await fetch(
          `${API_BASE}/sandbox/file?path=${encodeURIComponent(path)}`,
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
        const res = await fetch(
          `${API_BASE}/sandbox/directory?path=${encodeURIComponent(path)}`,
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
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-dir?path=${encodeURIComponent(path)}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const downloadFile = useCallback((path: string) => {
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download?path=${encodeURIComponent(path)}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const downloadAll = useCallback(() => {
    const a = document.createElement("a");
    a.href = `${API_BASE}/sandbox/download-all`;
    a.download = "sandbox.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const moveItem = useCallback(
    async (src: string, dest: string): Promise<boolean> => {
      try {
        const res = await fetch(`${API_BASE}/sandbox/move`, {
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
        const res = await fetch(`${API_BASE}/sandbox/mkdir`, {
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

  const refreshOpenTabs = useCallback(async () => {
    const current = tabsRef.current;
    for (const tab of current) {
      const name = tab.path.split("/").pop() ?? "";
      const cat = fileCategory(name);
      if (cat === "image" || cat === "pdf") continue;
      try {
        const res = await fetch(`${API_BASE}/sandbox/file?path=${encodeURIComponent(tab.path)}`);
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
      }
    }
  }, []);

  useEffect(() => {
    fetchTree();
    if (isActive) {
      const interval = setInterval(() => {
        fetchTree();
        refreshOpenTabs();
      }, 2000);
      return () => clearInterval(interval);
    } else {
      const interval = setInterval(fetchTree, 3000);
      return () => clearInterval(interval);
    }
  }, [isActive, fetchTree, refreshOpenTabs]);

  return {
    tree,
    tabs,
    activeTabPath,
    uploading,
    fetchTree,
    selectFile,
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
  };
}
