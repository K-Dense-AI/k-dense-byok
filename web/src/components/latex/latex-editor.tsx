"use client";

import { type LatexCompileResult } from "@/lib/use-sandbox";
import { parseCompileDiagnostics } from "@/lib/latex/diagnostics";
import { parseMagicComments, resolveRelative } from "@/lib/latex/magic-comments";
import { breadcrumbFor, parseOutline, type OutlineItem } from "@/lib/latex/outline";
import { proseWordCount } from "@/lib/latex/prose";
import { latexCompletionSource, scanBibFiles, scanBibKeys } from "@/lib/latex/completions";
import {
  readSandboxFile,
  fetchSynctexForward,
  fetchSynctexInverse,
  LatexAssistError,
  postLatexAssist,
  type LatexAssistResult,
} from "@/lib/latex/api";
import { prefillChat } from "@/lib/chat-prefill";
import { buildFixPayload, extractPreamble, lineRangeToOffsets } from "@/lib/latex/assist-helpers";
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
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { keymap } from "@codemirror/view";
import { Compartment, type Text } from "@codemirror/state";
import { autocompletion } from "@codemirror/autocomplete";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { LatexToolbar, type Engine, type SnippetAction } from "./latex-toolbar";
import { LogPanel, type LogFilter } from "./log-panel";
import { OutlinePanel } from "./outline-panel";
import { LatexPdfPane } from "./latex-pdf-pane";
import { AiEditPopover } from "./ai-edit-popover";
import type { PdfSyncClick, PdfSyncHighlight } from "@/components/pdf-viewer/pdf-viewer";

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
  onOpenFile,
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
  const [reloadToken, setReloadToken] = useState(0);
  const pdfPathRef = useRef<string | null>(null);
  useEffect(() => { pdfPathRef.current = pdfPath; }, [pdfPath]);
  const [syncHighlight, setSyncHighlight] = useState<PdfSyncHighlight | null>(null);
  const [synctexOk, setSynctexOk] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const syncTokenRef = useRef(0);
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

  // --- AI assist (Cmd+K edits / Fix with AI) --------------------------------
  const [aiPopover, setAiPopover] = useState<{ x: number; y: number } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // `applied` is the doc right after the AI change landed — finishReview uses
  // it to detect manual edits made during the review window.
  const [aiReview, setAiReview] = useState<{ original: string; applied: string; costUsd: number } | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  // Abort any in-flight assist request when the editor unmounts (tab switch,
  // file close) so the fetch doesn't outlive the component.
  useEffect(() => () => aiAbortRef.current?.abort(), []);
  // Per-request dynamic bits live in Compartments so toggling them doesn't
  // swap the whole extensions array (which forces a full root reconfigure).
  const lockComp = useMemo(() => new Compartment(), []);
  const mergeComp = useMemo(() => new Compartment(), []);

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
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
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
      setSynctexOk(result.synctex);
      if (result.success && result.pdf_path) {
        setPdfPath(result.pdf_path);
        setReloadToken((k) => k + 1);
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

  const closeLog = useCallback(() => setLogOpen(false), []);

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

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSyncNotice = useCallback((msg: string) => {
    setSyncNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSyncNotice(null), 4000);
  }, []);

  const jumpToPdf = useCallback(async () => {
    const view = viewRef.current;
    const pdf = pdfPathRef.current;
    if (!view || !pdf) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    // Claim the token before the await: if a newer jump starts while this one
    // is in flight, the stale response is dropped instead of winning the race.
    const token = ++syncTokenRef.current;
    const box = await fetchSynctexForward(path, line, pdf);
    if (token !== syncTokenRef.current) return;
    if (box === "unavailable" || box === null) {
      showSyncNotice(box === "unavailable" ? "SyncTeX not available (recompile first)" : "No PDF location found for this line");
      return;
    }
    setSyncHighlight({ ...box, token });
  }, [path, showSyncNotice]);
  const jumpToPdfRef = useRef(jumpToPdf);
  jumpToPdfRef.current = jumpToPdf;

  const askKady = useCallback(() => {
    prefillChat(`Regarding @${path}: `);
  }, [path]);

  const handleSyncClick = useCallback(
    async (pos: PdfSyncClick) => {
      const pdf = pdfPathRef.current;
      if (!pdf) return;
      const loc = await fetchSynctexInverse(pdf, pos.page, pos.x, pos.y);
      if (loc === "unavailable" || loc === null || !loc.file) {
        showSyncNotice("No source location found");
        return;
      }
      if (loc.file === path) {
        jumpToLine(loc.line);
        return;
      }
      // Switching tabs unmounts this editor and its unsaved CodeMirror doc —
      // never follow a cross-file jump over unsaved edits.
      if (isDirty) {
        showSyncNotice(`Source is in ${loc.file}:${loc.line} — save (${modKey}S) to follow`);
        return;
      }
      onOpenFile?.(loc.file);
      showSyncNotice(`Source is in ${loc.file}:${loc.line}`);
    },
    [path, jumpToLine, onOpenFile, showSyncNotice, isDirty, modKey],
  );

  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => {
      localStorage.setItem(OUTLINE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // --- AI assist: review flow + edit/fix flows ------------------------------
  const startReview = useCallback(
    (from: number, to: number, expected: string, replacement: string, costUsd: number) => {
      const view = viewRef.current;
      if (!view) return;
      // `from`/`to` were captured before the AI round-trip. The editable lock
      // only blocks direct input — programmatic edits (snippet buttons,
      // spellcheck fixes, external file refresh) can still move the doc — so
      // refuse to apply unless the range still holds exactly the text the AI
      // was asked to replace.
      if (to > view.state.doc.length || view.state.sliceDoc(from, to) !== expected) {
        showSyncNotice("Document changed during the AI request — edit not applied");
        return;
      }
      const original = view.state.doc.toString();
      view.dispatch({ changes: { from, to, insert: replacement } });
      view.dispatch({
        effects: mergeComp.reconfigure(unifiedMergeView({ original, mergeControls: true })),
      });
      setAiReview({ original, applied: view.state.doc.toString(), costUsd });
      view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
    },
    [mergeComp, showSyncNotice],
  );

  const finishReview = useCallback(
    (revert: boolean) => {
      const view = viewRef.current;
      if (view && revert) {
        const original = getOriginalDoc(view.state).toString();
        const manuallyEdited =
          aiReview !== null && view.state.doc.toString() !== aiReview.applied;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
        if (manuallyEdited) {
          showSyncNotice("Reverted AI edit — manual edits made during review were reverted too (undo to restore)");
        }
      }
      view?.dispatch({ effects: mergeComp.reconfigure([]) });
      setAiReview(null);
      viewRef.current?.focus();
    },
    [aiReview, mergeComp, showSyncNotice],
  );

  // Shared request scaffolding for both assist flows: busy state, a
  // per-request AbortController, and error routing to the caller's sink.
  const requestAssist = useCallback(
    async (
      payload: Record<string, unknown>,
      onError: (msg: string) => void,
    ): Promise<LatexAssistResult | null> => {
      setAiBusy(true);
      const ctrl = new AbortController();
      aiAbortRef.current = ctrl;
      try {
        return await postLatexAssist(payload, ctrl.signal);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          onError(err instanceof LatexAssistError ? err.message : "AI request failed");
        }
        return null;
      } finally {
        setAiBusy(false);
        if (aiAbortRef.current === ctrl) aiAbortRef.current = null;
      }
    },
    [],
  );

  const runAiEdit = useCallback(
    async (instruction: string) => {
      const view = viewRef.current;
      if (!view || aiBusy) return;
      const { from, to } = view.state.selection.main;
      const selection = view.state.sliceDoc(from, to);
      setAiError(null);
      const res = await requestAssist(
        {
          mode: "edit", fileName: name, instruction, selection,
          preamble: extractPreamble(view.state.doc.toString()),
        },
        setAiError,
      );
      if (!res) return;
      setAiPopover(null);
      startReview(from, to, selection, res.replacement, res.costUsd);
    },
    [name, aiBusy, requestAssist, startReview],
  );

  const fixWithAi = useCallback(
    async (line: number, message: string) => {
      const view = viewRef.current;
      if (!view || aiBusy) return;
      // Log line numbers refer to the doc as compiled; refuse once it diverges
      // (same staleness rule the lint gutter enforces via snap.doc.eq).
      const snap = diagRef.current;
      if (!snap || !snap.doc.eq(view.state.doc)) {
        showSyncNotice("Document changed since the last compile — recompile before fixing with AI");
        return;
      }
      // Close a lingering Cmd+K popover so its cancel can't abort this request.
      setAiPopover(null);
      const doc = view.state.doc.toString();
      const payload = buildFixPayload(doc, name, line, message);
      const res = await requestAssist(payload, showSyncNotice);
      if (!res) return;
      const { from, to } = lineRangeToOffsets(
        doc, payload.context.startLine, payload.context.endLine,
      );
      startReview(from, to, payload.context.text, res.replacement, res.costUsd);
    },
    [name, aiBusy, requestAssist, startReview, showSyncNotice],
  );
  const fixWithAiRef = useRef(fixWithAi);
  fixWithAiRef.current = fixWithAi;

  const openAiPopover = useCallback(() => {
    const view = viewRef.current;
    if (!view) return false;
    if (aiBusy) {
      showSyncNotice("An AI request is already in flight");
      return true;
    }
    const { from, to, head } = view.state.selection.main;
    if (from === to) return false;
    // coordsAtPos is null when the head is outside the rendered viewport
    // (e.g. after Cmd+A in a long doc) — fall back to a top-center anchor
    // instead of silently swallowing the keystroke.
    const coords = view.coordsAtPos(head);
    const rect = view.dom.getBoundingClientRect();
    setAiError(null);
    setAiPopover(
      coords
        ? { x: coords.left, y: coords.bottom }
        : { x: rect.left + rect.width / 2 - 160, y: rect.top + 40 },
    );
    return true;
  }, [aiBusy, showSyncNotice]);
  const openAiPopoverRef = useRef(openAiPopover);
  openAiPopoverRef.current = openAiPopover;

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
              actions:
                it.severity === "error"
                  ? [{
                      name: "✦ Fix with AI",
                      apply: () => fixWithAiRef.current(it.line, it.message),
                    }]
                  : undefined,
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
        { key: "Mod-Alt-j", run: () => { jumpToPdfRef.current(); return true; } },
        { key: "Mod-k", run: () => openAiPopoverRef.current(), preventDefault: true },
      ]),
      // Populated with unifiedMergeView while an AI review is open (startReview /
      // finishReview reconfigure it) — a Compartment so entering/leaving review
      // doesn't rebuild the whole extension tree.
      mergeComp.of([]),
      // Locks the editor to direct input while an AI request is in flight
      // (reconfigured from the aiBusy effect below). This blocks typing only;
      // startReview additionally verifies the target range before applying.
      lockComp.of(EditorView.editable.of(true)),
    ];
  }, [texLang, texLinter, spellcheck, spellExt, mergeComp, lockComp]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: lockComp.reconfigure(EditorView.editable.of(!aiBusy)),
    });
  }, [aiBusy, lockComp]);

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
        syncAvailable={synctexOk && pdfPath !== null}
        onJumpToPdf={jumpToPdf}
        onAskKady={askKady}
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
          {aiBusy && !aiPopover && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-violet-500/10 px-3 py-1 text-[11px] text-violet-700 dark:text-violet-300">
              <LoaderCircleIcon className="size-3 animate-spin" />
              AI fix in progress — editor locked
              <span className="flex-1" />
              <button
                onClick={() => aiAbortRef.current?.abort()}
                className="rounded border px-2 py-0.5 hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          )}
          {aiReview && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-violet-500/10 px-3 py-1 text-[11px] text-violet-700 dark:text-violet-300">
              <SparklesIcon className="size-3" />
              AI edit applied — review the highlighted chunks
              {aiReview.costUsd > 0 && <span className="text-muted-foreground">· ${aiReview.costUsd.toFixed(4)}</span>}
              <span className="flex-1" />
              <button onClick={() => finishReview(false)} className="rounded bg-violet-600 px-2 py-0.5 text-white hover:bg-violet-700">
                Keep all
              </button>
              <button onClick={() => finishReview(true)} className="rounded border px-2 py-0.5 hover:bg-muted">
                Revert all
              </button>
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
            onClose={closeLog}
            filter={logFilter}
            onFilterChange={setLogFilter}
            fileName={name}
            onFixError={fixWithAi}
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

        <div className="flex min-w-0 flex-1 flex-col bg-muted/5">
          {syncNotice && (
            <div className="shrink-0 border-b bg-blue-500/10 px-3 py-1 text-[11px] text-blue-700 dark:text-blue-300">
              {syncNotice}
            </div>
          )}
          <LatexPdfPane
            pdfPath={pdfPath}
            reloadToken={reloadToken}
            syncHighlight={syncHighlight}
            onSyncClick={handleSyncClick}
            modKey={modKey}
          />
        </div>
      </div>

      {aiPopover && (
        <AiEditPopover
          anchor={aiPopover}
          busy={aiBusy}
          error={aiError}
          onSubmit={runAiEdit}
          onCancel={() => {
            aiAbortRef.current?.abort();
            setAiPopover(null);
          }}
        />
      )}
    </div>
  );
}
