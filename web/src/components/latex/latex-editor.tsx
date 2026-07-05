"use client";

import { rawFileUrl, type LatexCompileResult } from "@/lib/use-sandbox";
import { parseCompileDiagnostics } from "@/lib/latex/diagnostics";
import { parseMagicComments, resolveRelative } from "@/lib/latex/magic-comments";
import { breadcrumbFor, parseOutline, type OutlineItem } from "@/lib/latex/outline";
import { proseWordCount } from "@/lib/latex/prose";
import { latexCompletionSource, scanBibFiles, scanBibKeys } from "@/lib/latex/completions";
import { readSandboxFile } from "@/lib/latex/api";
import {
  createSpellWorker,
  latexSpellLinter,
  type SpellWorkerClient,
} from "@/lib/latex/spellcheck";
import { getActiveProjectId } from "@/lib/projects";
import { cn } from "@/lib/utils";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { keymap } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { autocompletion } from "@codemirror/autocomplete";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { FileTextIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LatexToolbar, type Engine, type SnippetAction } from "./latex-toolbar";
import { LogPanel, type LogFilter } from "./log-panel";
import { OutlinePanel } from "./outline-panel";

const AUTOCOMPILE_KEY = "kady:latex:autocompile";
const OUTLINE_KEY = "kady:latex:outline";
const SPELLCHECK_KEY = "kady:latex:spellcheck";

const LATEX_BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLine: true,
  foldGutter: true,
  autocompletion: false,
  bracketMatching: true,
  indentOnInput: true,
  tabSize: 2,
};

export interface LatexEditorProps {
  path: string;
  name: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onCompile: (path: string, engine?: string) => Promise<LatexCompileResult>;
  onDiscard: () => void;
  onOpenFile?: (path: string) => void;
}

function isValidEngine(p: string | undefined): p is Engine {
  return p === "pdflatex" || p === "xelatex" || p === "lualatex";
}

export function LatexEditor({
  path,
  name,
  initialContent,
  onSave,
  onCompile,
  onDiscard,
}: LatexEditorProps) {
  // --- document state: content lives in CodeMirror, not React state -------
  const contentRef = useRef(initialContent);
  const lastSavedRef = useRef(initialContent);
  const viewRef = useRef<EditorView | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const compilingRef = useRef(false);
  const [engine, setEngine] = useState<Engine>(() => {
    const p = parseMagicComments(initialContent).program;
    return isValidEngine(p) ? p : "pdflatex";
  });
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfKey, setPdfKey] = useState(0);
  const [logText, setLogText] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [errorCount, setErrorCount] = useState(0);
  const [warningCount, setWarningCount] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [splitPct, setSplitPct] = useState(50);
  const [wordCount, setWordCount] = useState(() => proseWordCount(initialContent));
  const [autoCompile, setAutoCompile] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(AUTOCOMPILE_KEY) === "1",
  );
  const [outline, setOutline] = useState<OutlineItem[]>(() => parseOutline(initialContent));
  const [outlineOpen, setOutlineOpen] = useState(
    () => typeof localStorage === "undefined" || localStorage.getItem(OUTLINE_KEY) !== "0",
  );
  const [cursorLine, setCursorLine] = useState(1);
  const breadcrumb = useMemo(() => breadcrumbFor(outline, cursorLine), [outline, cursorLine]);

  // --- spell check ------------------------------------------------------
  const [spellcheck, setSpellcheck] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(SPELLCHECK_KEY) === "1",
  );
  const spellWorkerRef = useRef<SpellWorkerClient | null>(null);
  const ignoredRef = useRef<Set<string>>(new Set());
  const dictKey = `kady:latex:dict:${getActiveProjectId()}`;
  const dictKeyRef = useRef(dictKey);
  dictKeyRef.current = dictKey;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(dictKeyRef.current);
      if (raw) ignoredRef.current = new Set(JSON.parse(raw) as string[]);
    } catch { /* corrupted store — start fresh */ }
  }, []);

  useEffect(() => {
    if (!spellcheck) return;
    spellWorkerRef.current = createSpellWorker();
    return () => {
      spellWorkerRef.current?.dispose();
      spellWorkerRef.current = null;
    };
  }, [spellcheck]);

  const addToDictionary = useCallback((word: string) => {
    ignoredRef.current.add(word.toLowerCase());
    localStorage.setItem(dictKeyRef.current, JSON.stringify([...ignoredRef.current]));
    if (viewRef.current) forceLinting(viewRef.current);
  }, []);

  const toggleSpellcheck = useCallback(() => {
    setSpellcheck((v) => {
      localStorage.setItem(SPELLCHECK_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  const spellExt = useMemo(
    () =>
      latexSpellLinter({
        client: () => spellWorkerRef.current,
        ignored: () => ignoredRef.current,
        onAddWord: addToDictionary,
      }),
    [addToDictionary],
  );

  const { resolvedTheme } = useTheme();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const modKey = isMac ? "⌘" : "Ctrl+";

  // Compile diagnostics pinned to the exact doc Text they were computed for;
  // Text.eq() is cheap (structural), unlike toString() comparisons.
  const diagRef = useRef<{
    doc: Text;
    items: { line: number; message: string; severity: "error" | "warning" }[];
  } | null>(null);

  // .bib key cache for \cite{} completion — a ref (not state) so the stable
  // autocompletion extension always reads the latest keys without needing
  // to be recreated.
  const bibKeysRef = useRef<string[]>([]);
  const refreshBibKeys = useCallback(async () => {
    const doc = viewRef.current?.state.doc.toString() ?? contentRef.current;
    const files = scanBibFiles(doc);
    if (!files.length) {
      bibKeysRef.current = [];
      return;
    }
    const keys: string[] = [];
    for (const f of files) {
      const text = await readSandboxFile(resolveRelative(path, f));
      if (text) keys.push(...scanBibKeys(text));
    }
    bibKeysRef.current = [...new Set(keys)];
  }, [path]);

  useEffect(() => {
    void refreshBibKeys();
  }, [refreshBibKeys]);

  const wordCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback((value: string) => {
    contentRef.current = value;
    setIsDirty(value !== lastSavedRef.current);
    if (wordCountTimer.current) clearTimeout(wordCountTimer.current);
    wordCountTimer.current = setTimeout(() => {
      setWordCount(proseWordCount(value));
      setOutline(parseOutline(value));
    }, 1000);
  }, []);
  useEffect(
    () => () => {
      if (wordCountTimer.current) clearTimeout(wordCountTimer.current);
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
    },
    [],
  );

  // --- save / compile ------------------------------------------------------
  const autoCompileRef = useRef(autoCompile);
  autoCompileRef.current = autoCompile;

  const doSave = useCallback(async (): Promise<boolean> => {
    const content = viewRef.current?.state.doc.toString() ?? contentRef.current;
    setSaving(true);
    const ok = await onSave(content);
    setSaving(false);
    if (ok) {
      lastSavedRef.current = content;
      contentRef.current = content;
      setIsDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
    return ok;
  }, [onSave]);

  const handleCompile = useCallback(async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    try {
      const docText = viewRef.current?.state.doc.toString() ?? contentRef.current;
      if (docText !== lastSavedRef.current) {
        const ok = await doSave();
        if (!ok) return;
      }
      const magic = parseMagicComments(docText);
      const target = magic.root ? resolveRelative(path, magic.root) : path;
      const result = await onCompile(target, engine);
      setLogText(result.log);
      void refreshBibKeys();
      const snapshot = viewRef.current?.state.doc ?? null;
      const items = parseCompileDiagnostics(result.log ?? "", name);
      if (snapshot) diagRef.current = { doc: snapshot, items };
      setErrorCount(items.filter((i) => i.severity === "error").length || result.errors.length);
      setWarningCount(items.filter((i) => i.severity === "warning").length);
      if (viewRef.current) forceLinting(viewRef.current);
      if (result.success && result.pdf_path) {
        setPdfPath(result.pdf_path);
        setPdfKey((k) => k + 1);
        setLogOpen(false);
      } else {
        setLogOpen(true);
      }
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  }, [doSave, onCompile, path, engine, name, refreshBibKeys]);

  const handleSave = useCallback(async () => {
    const ok = await doSave();
    if (ok && autoCompileRef.current) void handleCompile();
  }, [doSave, handleCompile]);

  const handleSaveRef = useRef(handleSave);
  const handleCompileRef = useRef(handleCompile);
  handleSaveRef.current = handleSave;
  handleCompileRef.current = handleCompile;

  const toggleAutoCompile = useCallback(() => {
    setAutoCompile((v) => {
      localStorage.setItem(AUTOCOMPILE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // --- snippet inserts ------------------------------------------------------
  const handleSnippet = useCallback((action: SnippetAction) => {
    const view = viewRef.current;
    if (!view) return;
    if (action.kind === "wrap") {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: [
          { from, insert: action.before },
          { from: to, insert: action.after },
        ],
        selection: {
          anchor: from + action.before.length,
          head: to + action.before.length,
        },
      });
    } else {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const insert = (line.length > 0 ? "\n" : "") + action.text;
      view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
      });
    }
    view.focus();
  }, []);

  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackCursor = useCallback((line: number) => {
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    cursorTimer.current = setTimeout(() => setCursorLine(line), 150);
  }, []);
  const trackCursorRef = useRef(trackCursor);
  trackCursorRef.current = trackCursor;

  const jumpToLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const ln = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: ln.from },
      effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
    });
    view.focus();
  }, []);

  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => {
      localStorage.setItem(OUTLINE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // --- editor extensions ----------------------------------------------------
  const texLang = useMemo(() => loadLanguage("tex"), []);

  const texLinter = useMemo(
    () =>
      linter(
        (view) => {
          const snap = diagRef.current;
          if (!snap || !snap.doc.eq(view.state.doc)) return [];
          const doc = view.state.doc;
          return snap.items.map((it): Diagnostic => {
            const lineNo = Math.max(1, Math.min(it.line, doc.lines));
            const ln = doc.line(lineNo);
            return {
              from: ln.from,
              to: ln.to,
              severity: it.severity,
              message: it.message,
            };
          });
        },
        { delay: 300 },
      ),
    [],
  );

  const extensions = useMemo(() => {
    return [
      ...(texLang ? [texLang] : []),
      EditorView.lineWrapping,
      lintGutter(),
      autocompletion({
        override: [latexCompletionSource({ getBibKeys: () => bibKeysRef.current })],
        activateOnTyping: true,
        maxRenderedOptions: 60,
      }),
      ...(spellcheck ? [spellExt] : []),
      texLinter,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) {
          trackCursorRef.current(u.state.doc.lineAt(u.state.selection.main.head).number);
        }
      }),
      keymap.of([
        { key: "Mod-s", run: () => { handleSaveRef.current(); return true; }, preventDefault: true },
        { key: "Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
        { key: "Shift-Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
      ]),
    ];
  }, [texLang, texLinter, spellcheck, spellExt]);

  // --- resizable split pane ---------------------------------------------------
  const dividerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const parent = dividerRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(25, Math.min(75, pct)));
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <div className="flex h-full flex-col">
      <LatexToolbar
        compiling={compiling}
        saving={saving}
        saved={saved}
        isDirty={isDirty}
        engine={engine}
        onEngineChange={setEngine}
        onCompile={handleCompile}
        onSave={handleSave}
        onDiscard={onDiscard}
        errorCount={errorCount}
        warningCount={warningCount}
        hasPdf={pdfPath !== null}
        hasLog={logText !== null}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
        autoCompile={autoCompile}
        onToggleAutoCompile={toggleAutoCompile}
        wordCount={wordCount}
        modKey={modKey}
        onSnippet={handleSnippet}
        outlineOpen={outlineOpen}
        onToggleOutline={toggleOutline}
        spellcheck={spellcheck}
        onToggleSpellcheck={toggleSpellcheck}
      />

      <div className={cn("flex flex-1 min-h-0", dragging && "select-none")}>
        {outlineOpen && (
          <OutlinePanel items={outline} currentLine={cursorLine} onJump={jumpToLine} />
        )}

        {/* Editor pane */}
        <div className="flex min-w-0 flex-col overflow-hidden" style={{ width: `${splitPct}%` }}>
          {breadcrumb.length > 0 && (
            <div className="flex shrink-0 items-center gap-1 truncate border-b bg-muted/20 px-3 py-1 text-[10px] text-muted-foreground">
              {breadcrumb.map((b, i) => (
                <span key={`${b.line}`} className="flex items-center gap-1 truncate">
                  {i > 0 && <span className="text-muted-foreground/40">›</span>}
                  <button className="truncate hover:text-foreground" onClick={() => jumpToLine(b.line)}>
                    {b.title}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-0">
              <CodeMirror
                value={initialContent}
                onChange={handleChange}
                onCreateEditor={(view) => { viewRef.current = view; }}
                extensions={extensions}
                theme={resolvedTheme === "dark" ? githubDark : githubLight}
                height="100%"
                className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
                basicSetup={LATEX_BASIC_SETUP}
              />
            </div>
          </div>

          <LogPanel
            log={logText ?? ""}
            open={logOpen}
            onClose={() => setLogOpen(false)}
            filter={logFilter}
            onFilterChange={setLogFilter}
          />
        </div>

        {/* Resize divider */}
        <div
          ref={dividerRef}
          className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border transition-colors hover:bg-blue-400 active:bg-blue-500"
          onMouseDown={() => setDragging(true)}
        >
          <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-blue-400" />
        </div>

        {/* PDF pane (iframe — replaced by LatexPdfPane in a later task) */}
        <div className="flex min-w-0 flex-1 flex-col bg-muted/5">
          {pdfPath ? (
            <iframe
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
                  Press{" "}
                  <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                    {modKey}↵
                  </kbd>{" "}
                  to compile
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
