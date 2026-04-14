"use client";

import { rawFileUrl, type LatexCompileResult } from "@/lib/use-sandbox";
import { cn } from "@/lib/utils";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { githubLight } from "@uiw/codemirror-theme-github";
import { keymap } from "@codemirror/view";
import {
  PlayIcon,
  CheckIcon,
  XIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileTextIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Engine = "pdflatex" | "xelatex" | "lualatex";

const ENGINES: { id: Engine; label: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX" },
  { id: "xelatex", label: "XeLaTeX" },
  { id: "lualatex", label: "LuaLaTeX" },
];

export interface LatexEditorProps {
  path: string;
  name: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onCompile: (path: string, engine?: string) => Promise<LatexCompileResult>;
  onDiscard: () => void;
}

export function LatexEditor({
  path,
  name,
  initialContent,
  onSave,
  onCompile,
  onDiscard,
}: LatexEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [engine, setEngine] = useState<Engine>("pdflatex");
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfKey, setPdfKey] = useState(0);
  const [logText, setLogText] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [splitPct, setSplitPct] = useState(50);

  const isDirty = content !== initialContent;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handleSaveRef = useRef<() => void>(() => {});
  const handleCompileRef = useRef<() => void>(() => {});
  const dividerRef = useRef<HTMLDivElement>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await onSave(content);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  }, [content, onSave]);

  const handleCompile = useCallback(async () => {
    if (isDirty) {
      setSaving(true);
      const ok = await onSave(content);
      setSaving(false);
      if (!ok) return;
    }
    setCompiling(true);
    const result = await onCompile(path, engine);
    setCompiling(false);
    setLogText(result.log);
    setErrors(result.errors);

    if (result.success && result.pdf_path) {
      setPdfPath(result.pdf_path);
      setPdfKey((k) => k + 1);
      setLogOpen(false);
    } else {
      setLogOpen(true);
    }
  }, [content, isDirty, onSave, onCompile, path, engine]);

  handleSaveRef.current = handleSave;
  handleCompileRef.current = handleCompile;

  const texLang = useMemo(() => loadLanguage("tex"), []);

  const extensions = useMemo(() => {
    return [
      ...(texLang ? [texLang] : []),
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", run: () => { handleSaveRef.current(); return true; } },
        { key: "Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
        { key: "Shift-Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
      ]),
    ];
  }, [texLang]);

  // Resizable split pane
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !dividerRef.current) return;
      const parent = dividerRef.current.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(25, Math.min(75, pct)));
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <button
          onClick={handleCompile}
          disabled={compiling}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            compiling
              ? "bg-muted text-muted-foreground"
              : "bg-emerald-600 text-white hover:bg-emerald-700",
          )}
        >
          {compiling ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          {compiling ? "Compiling…" : "Compile"}
        </button>

        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value as Engine)}
          className="rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none"
        >
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
        </select>

        {/* Status */}
        {errors.length > 0 && !compiling && (
          <button
            onClick={() => setLogOpen((v) => !v)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 transition-colors"
          >
            <AlertTriangleIcon className="size-3.5" />
            {errors.length} error{errors.length !== 1 ? "s" : ""}
          </button>
        )}
        {pdfPath && errors.length === 0 && !compiling && (
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <CheckIcon className="size-3.5" /> PDF ready
          </span>
        )}

        <div className="flex-1" />

        {logText !== null && (
          <button
            onClick={() => setLogOpen((v) => !v)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            {logOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronUpIcon className="size-3.5" />}
            Log
          </button>
        )}

        <div className="h-4 w-px bg-border" />

        <div className={cn("size-2 rounded-full transition-colors", isDirty ? "bg-amber-500" : "bg-muted-foreground/30")} />
        <span className="text-[10px] text-muted-foreground/60 font-mono">⌘S save · ⌘↵ compile</span>

        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {saved ? <CheckIcon className="size-3" /> : null}
          {saving ? "Saving…" : saved ? "Saved!" : "Save"}
        </button>

        <button
          onClick={onDiscard}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Close
        </button>
      </div>

      {/* Split pane: editor + PDF */}
      <div className={cn("flex flex-1 min-h-0", dragging.current && "select-none")}>
        {/* Editor pane */}
        <div className="flex flex-col min-w-0 overflow-hidden" style={{ width: `${splitPct}%` }}>
          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-0">
              <CodeMirror
                value={content}
                onChange={setContent}
                extensions={extensions}
                theme={githubLight}
                height="100%"
                className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  foldGutter: true,
                  autocompletion: false,
                  bracketMatching: true,
                  indentOnInput: true,
                  tabSize: 2,
                }}
              />
            </div>
          </div>

          {/* Log panel (collapsible) */}
          {logOpen && logText && (
            <div className="shrink-0 max-h-48 overflow-auto border-t bg-muted/10">
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/40 px-3 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Compilation Log</span>
                <span className="flex-1" />
                <button onClick={() => setLogOpen(false)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <XIcon className="size-3" />
                </button>
              </div>
              <pre className="whitespace-pre-wrap break-words p-3 text-[11px] font-mono leading-relaxed text-muted-foreground">
                {logText.split("\n").map((line, i) => (
                  <span key={i} className={line.startsWith("!") ? "text-red-600 font-medium" : ""}>
                    {line}{"\n"}
                  </span>
                ))}
              </pre>
            </div>
          )}
        </div>

        {/* Resize divider */}
        <div
          ref={dividerRef}
          className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border hover:bg-blue-400 active:bg-blue-500 transition-colors"
          onMouseDown={() => { dragging.current = true; }}
        >
          <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 group-hover:bg-blue-400 transition-colors" />
        </div>

        {/* PDF pane */}
        <div className="flex-1 min-w-0 flex flex-col bg-muted/5">
          {pdfPath ? (
            <iframe
              ref={iframeRef}
              key={pdfKey}
              src={`${rawFileUrl(pdfPath)}&_t=${pdfKey}`}
              title="PDF Preview"
              className="h-full w-full"
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
                <FileTextIcon className="size-6 text-muted-foreground/30" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">No PDF yet</p>
                <p className="text-xs text-muted-foreground/60">
                  Press <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">⌘↵</kbd> to compile
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
