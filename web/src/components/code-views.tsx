"use client";

import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { keymap } from "@codemirror/view";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const EXT_ALIAS: Record<string, LanguageName> = {
  ipynb: "json",
  pyw: "py",
  mjs: "js",
  cjs: "js",
  cts: "ts",
  mts: "ts",
  jsonl: "json",
  mkd: "markdown",
  mdx: "markdown",
  yml: "yaml",
  htm: "html",
  hbs: "html",
  cc: "cpp",
  cxx: "cpp",
  hxx: "cpp",
  hpp: "cpp",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  ksh: "sh",
  zsh: "bash",
  fish: "bash",
  ps1: "sh",
  ltx: "tex",
  latex: "tex",
  bib: "tex",
  scss: "css",
  less: "css",
  rst: "markdown",
};

function langExtension(name: string) {
  const raw = name.split(".").pop()?.toLowerCase() ?? "";
  const key = (EXT_ALIAS[raw] ?? raw) as LanguageName;
  return loadLanguage(key) ?? null;
}

// ---------------------------------------------------------------------------
// Read-only code viewer with syntax highlighting
// ---------------------------------------------------------------------------

export function ReadOnlyCodeView({
  content,
  name,
  className,
  revealLine,
  revealToken,
}: {
  content: string;
  name: string;
  className?: string;
  revealLine?: number;
  revealToken?: number;
}) {
  const editorViewRef = useRef<EditorView | null>(null);
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => {
    const lang = langExtension(name);
    return [
      ...(lang ? [lang] : []),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ];
  }, [name]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || !revealLine || revealLine < 1) return;
    const doc = view.state.doc;
    const safeLine = Math.min(revealLine, doc.lines);
    try {
      const pos = doc.line(safeLine).from;
      view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
        selection: { anchor: pos, head: pos },
      });
    } catch {
      // ignore out-of-range scroll requests
    }
  }, [revealLine, revealToken, content]);

  return (
    <CodeMirror
      value={content}
      extensions={extensions}
      theme={resolvedTheme === "dark" ? githubDark : githubLight}
      editable={false}
      readOnly
      height="100%"
      onCreateEditor={(view) => {
        editorViewRef.current = view;
      }}
      className={cn(
        "text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto [&_.cm-gutters]:bg-muted/20 [&_.cm-activeLine]:bg-transparent [&_.cm-activeLineGutter]:bg-transparent",
        className,
      )}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: false,
        foldGutter: true,
        autocompletion: false,
        bracketMatching: true,
        indentOnInput: false,
        tabSize: 2,
      }}
    />
  );
}

export function TextEditor({
  path,
  name,
  initialContent,
  onSave,
  onDiscard,
}: {
  path: string;
  name: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onDiscard: () => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The sandbox poll refreshes `initialContent`, so comparing against the prop
  // made the dirty flag (and the Save button) flip off when the agent touched
  // the file — leaving real edits unsavable. Track what we last wrote instead.
  const savedRef = useRef(initialContent);
  const contentRef = useRef(content);
  contentRef.current = content;
  const [diskChanged, setDiskChanged] = useState(false);
  const isDirty = content !== savedRef.current;

  useEffect(() => {
    if (initialContent === savedRef.current) return;
    if (contentRef.current === savedRef.current) {
      savedRef.current = initialContent;
      setContent(initialContent);
      setDiskChanged(false);
      return;
    }
    setDiskChanged(true);
  }, [initialContent]);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const { resolvedTheme } = useTheme();

  // Use a ref so the keymap closure never goes stale
  const handleSaveRef = useRef<() => void>(() => {});
  const viewRef = useRef<EditorView | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await onSave(content);
    setSaving(false);
    if (ok) {
      savedRef.current = content;
      setDiskChanged(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [content, onSave]);

  handleSaveRef.current = handleSave;

  const extensions = useMemo(() => {
    const lang = langExtension(name);
    return [
      ...(lang ? [lang] : []),
      EditorView.lineWrapping,
      keymap.of([{ key: "Mod-s", run: () => { handleSaveRef.current(); return true; } }]),
    ];
  }, [name]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-amber-50/80 px-3 py-1.5">
        <div className={cn("size-2 rounded-full transition-colors", isDirty ? "bg-amber-500" : "bg-muted-foreground/30")} />
        <span className="text-xs text-muted-foreground">
          {saved ? "Saved" : isDirty ? "Unsaved changes" : "No changes"}
        </span>
        {diskChanged && (
          <button
            onClick={() => {
              savedRef.current = initialContent;
              setContent(initialContent);
              setDiskChanged(false);
            }}
            className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-700 transition-colors hover:bg-amber-500/10"
            title="Discard your edits and load the version on disk"
          >
            Changed on disk — load it
          </button>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/50 font-mono">{isMac ? "⌘S" : "Ctrl+S"} to save</span>
        <button
          onClick={onDiscard}
          className="rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Close editor
        </button>
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {saved ? <CheckIcon className="size-3" /> : null}
          {saving ? "Saving…" : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {/* CodeMirror editor — fills remaining height */}
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">
          <CodeMirror
            value={content}
            onChange={setContent}
            extensions={extensions}
            theme={resolvedTheme === "dark" ? githubDark : githubLight}
            height="100%"
            className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
            onCreateEditor={(view) => { viewRef.current = view; }}
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
    </div>
  );
}
