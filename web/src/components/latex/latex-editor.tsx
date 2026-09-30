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
import { useProjectScopeId } from "@/lib/projects";
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
import { AlertTriangleIcon, LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { LatexToolbar, type Engine, type SnippetAction, type LatexViewMode } from "./latex-toolbar";
import { LogPanel, type LogFilter } from "./log-panel";
import { OutlinePanel } from "./outline-panel";
import { LatexPdfPane } from "./latex-pdf-pane";
import { AiEditPopover } from "./ai-edit-popover";
import type { PdfSyncClick, PdfSyncHighlight } from "@/components/pdf-viewer/pdf-viewer";

const AUTOCOMPILE_KEY = "kady:latex:autocompile";
const OUTLINE_KEY = "kady:latex:outline";
const SPELLCHECK_KEY = "kady:latex:spellcheck";
const VIEW_KEY = "kady:latex:view";
const SPLIT_KEY = "kady:latex:split";

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
  model?: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onCompile: (path: string, engine?: string) => Promise<LatexCompileResult>;
  onDiscard: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenFile?: (path: string) => void;
}

function isValidEngine(p: string | undefined): p is Engine {
  return p === "pdflatex" || p === "xelatex" || p === "lualatex";
}

export function LatexEditor({
  path,
  name,
  model,
  initialContent,
  onSave,
  onCompile,
  onDiscard,
  onDirtyChange,
  onOpenFile,
}: LatexEditorProps) {
  const projectId = useProjectScopeId();
  // --- document state: content lives in CodeMirror, not React state -------
  const contentRef = useRef(initialContent);
  const lastSavedRef = useRef(initialContent);
  const viewRef = useRef<EditorView | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  // CodeMirror's `value` is controlled: handing it new text replaces the doc.
  // The sandbox poll rewrites `initialContent` every few seconds, so binding
  // the prop directly let a background refresh wipe unsaved edits mid-sentence.
  // The editor is pinned to the text we opened with; later disk versions
  // surface through `diskContent` instead.
  const openedContentRef = useRef(initialContent);
  const [diskContent, setDiskContent] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const compilingRef = useRef(false);
  const [engine, setEngine] = useState<Engine>(() => {
    const p = parseMagicComments(initialContent).program;
    return isValidEngine(p) ? p : "pdflatex";
  });
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const pdfDocRef = useRef<Text | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [compileFailed, setCompileFailed] = useState(false);
  const [diagnosticsStale, setDiagnosticsStale] = useState(false);
  const [compileTarget, setCompileTarget] = useState(path);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<LatexViewMode>(() => {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    return value === "source" || value === "pdf" ? value : "split";
  });
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
  const [splitPct, setSplitPct] = useState(() => {
    const value = typeof localStorage !== "undefined" ? Number(localStorage.getItem(SPLIT_KEY)) : 50;
    return value >= 25 && value <= 75 ? value : 50;
  });
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
  const aiReviewRef = useRef(aiReview);
  aiReviewRef.current = aiReview;
  const diskContentRef = useRef(diskContent);
  diskContentRef.current = diskContent;
  const aiAbortRef = useRef<AbortController | null>(null);
  // Abort any in-flight assist request when the editor unmounts (tab switch,
  // file close) so the fetch doesn't outlive the component.
  useEffect(() => () => aiAbortRef.current?.abort(), []);
  // Per-request dynamic bits live in Compartments so toggling them doesn't
  // swap the whole extensions array (which forces a full root reconfigure).
  const lockComp = useMemo(() => new Compartment(), []);
  const mergeComp = useMemo(() => new Compartment(), []);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSyncNotice = useCallback((msg: string) => {
    setSyncNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSyncNotice(null), 6000);
  }, []);

  const changeViewMode = useCallback((mode: LatexViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_KEY, mode);
  }, []);

  // --- spell check ------------------------------------------------------
  const [spellcheck, setSpellcheck] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(SPELLCHECK_KEY) === "1",
  );
  const spellWorkerRef = useRef<SpellWorkerClient | null>(null);
  const ignoredRef = useRef<Set<string>>(new Set());
  const dictKey = `kady:latex:dict:${projectId}`;
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
      const text = await readSandboxFile(resolveRelative(path, f), projectId);
      if (text) keys.push(...scanBibKeys(text));
    }
    bibKeysRef.current = [...new Set(keys)];
  }, [path, projectId]);

  useEffect(() => {
    void refreshBibKeys();
  }, [refreshBibKeys]);

  const wordCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback((value: string) => {
    contentRef.current = value;
    setIsDirty(value !== lastSavedRef.current);
    setSaved(false);
    const doc = viewRef.current?.state.doc;
    setPreviewStale(!!pdfDocRef.current && (!doc || !pdfDocRef.current.eq(doc)));
    setDiagnosticsStale(!!diagRef.current && (!doc || !diagRef.current.doc.eq(doc)));
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
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const applyDiskContent = useCallback((next: string) => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    }
    contentRef.current = next;
    lastSavedRef.current = next;
    setIsDirty(false);
    setDiskContent(null);
    setWordCount(proseWordCount(next));
    setOutline(parseOutline(next));
  }, []);

  const keepEditorContent = useCallback(() => {
    const disk = diskContentRef.current;
    if (disk === null) return;
    // The retained document must be compared with the actual disk version,
    // including when undo has restored the editor's old saved text.
    lastSavedRef.current = disk;
    const current = viewRef.current?.state.doc.toString() ?? contentRef.current;
    setIsDirty(current !== disk);
    setSaved(false);
    diskContentRef.current = null;
    setDiskContent(null);
  }, []);

  // The file changed underneath us — usually the agent editing the same .tex.
  // Adopt it silently when there is nothing to lose, otherwise let the user
  // choose rather than deciding for them.
  useEffect(() => {
    if (initialContent === lastSavedRef.current) {
      setDiskContent(null);
      return;
    }
    const current = viewRef.current?.state.doc.toString() ?? contentRef.current;
    if (current === initialContent) {
      lastSavedRef.current = initialContent;
      setIsDirty(false);
      setDiskContent(null);
      return;
    }
    if (current === lastSavedRef.current && !aiAbortRef.current && !aiReviewRef.current) {
      applyDiskContent(initialContent);
      return;
    }
    setDiskContent(initialContent);
  }, [initialContent, applyDiskContent]);

  // --- save / compile ------------------------------------------------------
  const autoCompileRef = useRef(autoCompile);
  autoCompileRef.current = autoCompile;

  const doSave = useCallback(async (): Promise<boolean> => {
    if (aiAbortRef.current || aiReviewRef.current) {
      showSyncNotice("Finish the AI edit review before saving or compiling");
      return false;
    }
    if (diskContentRef.current !== null) {
      showSyncNotice("Choose Load disk version or Keep mine before saving");
      return false;
    }
    // Serialize keyboard/button saves; never let an older request overwrite
    // a newer one or mark keystrokes made during the request as saved.
    while (savePromiseRef.current) await savePromiseRef.current;
    if (aiAbortRef.current || aiReviewRef.current || diskContentRef.current !== null) return false;
    const content = viewRef.current?.state.doc.toString() ?? contentRef.current;
    if (content === lastSavedRef.current) return true;
    setSaving(true);
    const promise = Promise.resolve().then(() => onSave(content)).catch((error: unknown) => {
      showSyncNotice(error instanceof Error ? error.message : "Could not save document");
      return false;
    });
    savePromiseRef.current = promise;
    try {
      const ok = await promise;
      if (ok) {
        lastSavedRef.current = content;
        const current = viewRef.current?.state.doc.toString() ?? contentRef.current;
        setIsDirty(current !== content);
        setSaved(current === content);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1500);
      } else showSyncNotice("Could not save document. Your edits are still in the editor.");
      return ok;
    } finally {
      savePromiseRef.current = null;
      setSaving(false);
    }
  }, [onSave, showSyncNotice]);

  const handleCompile = useCallback(async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    try {
      const ok = await doSave();
      if (!ok) return;
      const snapshot = viewRef.current?.state.doc ?? null;
      const docText = snapshot?.toString() ?? contentRef.current;
      if (docText !== lastSavedRef.current) {
        showSyncNotice("Source changed while saving. Compile again to include your latest edits.");
        return;
      }
      const magic = parseMagicComments(docText);
      const target = magic.root ? resolveRelative(path, magic.root) : path;
      setCompileTarget(target);
      const result = await onCompile(target, engine);
      setLogText(result.log);
      setCompileErrors(result.errors);
      setCompileFailed(!result.success);
      void refreshBibKeys();
      const items = parseCompileDiagnostics(result.diagnostics_log ?? result.log ?? "", path, target);
      if (snapshot) diagRef.current = { doc: snapshot, items };
      const stale = !!snapshot && !!viewRef.current && !snapshot.eq(viewRef.current.state.doc);
      setDiagnosticsStale(stale);
      setErrorCount(items.filter((i) => i.severity === "error").length || result.errors.length);
      setWarningCount(items.filter((i) => i.severity === "warning").length);
      if (viewRef.current) forceLinting(viewRef.current);
      setSynctexOk(result.synctex);
      if (result.success && result.pdf_path) {
        pdfDocRef.current = snapshot;
        setPreviewStale(stale);
        setSyncHighlight(null);
        setPdfPath(result.pdf_path);
        setReloadToken((k) => k + 1);
        setLogOpen(false);
      } else {
        setLogOpen(true);
      }
    } catch (error) {
      diagRef.current = null;
      setDiagnosticsStale(false);
      const message = error instanceof Error ? error.message : "Compilation failed";
      setLogText(message);
      setCompileErrors([message]);
      setCompileFailed(true);
      setSynctexOk(false);
      setErrorCount(1);
      setLogOpen(true);
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  }, [doSave, onCompile, path, engine, refreshBibKeys, showSyncNotice]);

  const handleSave = useCallback(async () => {
    if (compilingRef.current) {
      showSyncNotice("Compilation is in progress. Save again when it finishes.");
      return;
    }
    const ok = await doSave();
    if (ok && autoCompileRef.current) void handleCompile();
  }, [doSave, handleCompile, showSyncNotice]);

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
    if (aiAbortRef.current) return;
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
    setViewMode((mode) => mode === "pdf" ? "split" : mode);
    const view = viewRef.current;
    if (!view) return;
    const ln = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: ln.from },
      effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
    });
    view.focus();
  }, []);

  const jumpToPdf = useCallback(async () => {
    const view = viewRef.current;
    const pdf = pdfPathRef.current;
    if (!view || !pdf) return;
    if (compilingRef.current || !pdfDocRef.current?.eq(view.state.doc) || !synctexOk) {
      showSyncNotice("Recompile before jumping between source and PDF");
      return;
    }
    setViewMode((mode) => mode === "source" ? "split" : mode);
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    // Claim the token before the await: if a newer jump starts while this one
    // is in flight, the stale response is dropped instead of winning the race.
    const token = ++syncTokenRef.current;
    const box = await fetchSynctexForward(path, line, pdf, projectId);
    if (token !== syncTokenRef.current) return;
    if (box === "unavailable" || box === null) {
      showSyncNotice(box === "unavailable" ? "SyncTeX not available (recompile first)" : "No PDF location found for this line");
      return;
    }
    setSyncHighlight({ ...box, token });
  }, [path, projectId, showSyncNotice, synctexOk]);
  const jumpToPdfRef = useRef(jumpToPdf);
  jumpToPdfRef.current = jumpToPdf;

  const askKady = useCallback(() => {
    prefillChat(`Regarding @${path}: `);
  }, [path]);

  const handleSyncClick = useCallback(
    async (pos: PdfSyncClick) => {
      const pdf = pdfPathRef.current;
      if (!pdf) return;
      if (compilingRef.current || !synctexOk || !viewRef.current || !pdfDocRef.current?.eq(viewRef.current.state.doc)) {
        showSyncNotice("Recompile before jumping between source and PDF");
        return;
      }
      const loc = await fetchSynctexInverse(pdf, pos.page, pos.x, pos.y, projectId);
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
      if (contentRef.current !== lastSavedRef.current || aiAbortRef.current || aiReviewRef.current) {
        showSyncNotice(`Source is in ${loc.file}:${loc.line} — save (${modKey}S) to follow`);
        return;
      }
      onOpenFile?.(loc.file);
      showSyncNotice(`Source is in ${loc.file}:${loc.line}`);
    },
    [path, projectId, jumpToLine, onOpenFile, showSyncNotice, modKey, synctexOk],
  );

  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => {
      localStorage.setItem(OUTLINE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // --- AI assist: review flow + edit/fix flows ------------------------------
  const startReview = useCallback(
    (from: number, to: number, expected: Text, replacement: string, costUsd: number) => {
      const view = viewRef.current;
      if (!view) return;
      // `from`/`to` were captured before the AI round-trip. The editable lock
      // only blocks direct input — programmatic edits (snippet buttons,
      // spellcheck fixes, external file refresh) can still move the doc — so
      // refuse if any of the source context changed during the round-trip.
      if (!expected.eq(view.state.doc) || aiReviewRef.current) {
        showSyncNotice("Document changed during the AI request — edit not applied");
        return;
      }
      const original = view.state.doc.toString();
      view.dispatch({ changes: { from, to, insert: replacement } });
      view.dispatch({
        effects: mergeComp.reconfigure(unifiedMergeView({ original, mergeControls: true })),
      });
      const review = { original, applied: view.state.doc.toString(), costUsd };
      aiReviewRef.current = review;
      setAiReview(review);
      setViewMode((mode) => mode === "pdf" ? "split" : mode);
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
      aiReviewRef.current = null;
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
      source: string,
    ): Promise<LatexAssistResult | null> => {
      if (aiAbortRef.current || aiReviewRef.current || savePromiseRef.current || compilingRef.current) {
        onError("Finish the current save, compilation, or AI review before starting another edit");
        return null;
      }
      setAiBusy(true);
      const ctrl = new AbortController();
      aiAbortRef.current = ctrl;
      try {
        // Included chapters often lack a preamble. Give the model the root's
        // definitions without expanding the editable selection beyond this file.
        if (!payload.preamble) {
          const root = parseMagicComments(source).root;
          if (root) {
            const rootSource = await readSandboxFile(resolveRelative(path, root), projectId);
            if (rootSource) payload = { ...payload, preamble: extractPreamble(rootSource) };
          }
        }
        if (ctrl.signal.aborted) return null;
        const result = await postLatexAssist(
          model ? { ...payload, model } : payload,
          ctrl.signal,
          projectId,
        );
        if (ctrl.signal.aborted) return null;
        if (result.status === "needs_context") {
          onError(`More context needed: ${result.message}`);
          return null;
        }
        return result;
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
    [model, path, projectId],
  );

  const runAiEdit = useCallback(
    async (instruction: string) => {
      const view = viewRef.current;
      if (!view || aiBusy) return;
      const { from, to } = view.state.selection.main;
      const snapshot = view.state.doc;
      const selection = view.state.sliceDoc(from, to);
      setAiError(null);
      const res = await requestAssist(
        {
          mode: "edit", fileName: name, instruction, selection,
          preamble: extractPreamble(view.state.doc.toString()),
        },
        setAiError,
        snapshot.toString(),
      );
      if (!res || res.status !== "replacement") return;
      setAiPopover(null);
      startReview(from, to, snapshot, res.replacement, res.costUsd);
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
      const res = await requestAssist(payload, showSyncNotice, doc);
      if (!res || res.status !== "replacement") return;
      const { from, to } = lineRangeToOffsets(
        doc, payload.context.startLine, payload.context.endLine,
      );
      startReview(from, to, snap.doc, res.replacement, res.costUsd);
    },
    [name, aiBusy, requestAssist, startReview, showSyncNotice],
  );
  const fixWithAiRef = useRef(fixWithAi);
  fixWithAiRef.current = fixWithAi;

  const openAiPopover = useCallback(() => {
    const view = viewRef.current;
    if (!view) return false;
    if (aiAbortRef.current || aiReviewRef.current || savePromiseRef.current || compilingRef.current) {
      showSyncNotice("Finish the current save, compilation, or AI review before starting another edit");
      return true;
    }
    const { from, to, head } = view.state.selection.main;
    setViewMode((mode) => mode === "pdf" ? "split" : mode);
    if (from === to) {
      showSyncNotice("Select some LaTeX source, then choose Edit with AI");
      view.focus();
      return true;
    }
    // coordsAtPos is null when the head is outside the rendered viewport
    // (e.g. after Cmd+A in a long doc) — fall back to a top-center anchor
    // instead of silently swallowing the keystroke.
    const coords = view.coordsAtPos(head);
    const rect = view.dom.getBoundingClientRect();
    setAiError(null);
    setAiPopover(
      coords
        ? { x: coords.left, y: coords.bottom }
        : { x: rect.width ? rect.left + rect.width / 2 - 160 : window.innerWidth / 2 - 160, y: rect.top + 40 },
    );
    return true;
  }, [showSyncNotice]);
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
  useEffect(() => {
    if (!dragging) localStorage.setItem(SPLIT_KEY, String(splitPct));
  }, [splitPct, dragging]);

  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

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
        onDiscard={() => {
          if (contentRef.current !== lastSavedRef.current || aiAbortRef.current || aiReviewRef.current) setConfirmClose(true);
          else onDiscard();
        }}
        errorCount={errorCount}
        warningCount={warningCount}
        hasPdf={pdfPath !== null}
        previewStale={previewStale}
        compileFailed={compileFailed}
        editingLocked={aiBusy || aiReview !== null}
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        onAiEdit={openAiPopover}
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
        syncAvailable={synctexOk && pdfPath !== null && !previewStale && !compiling}
        onJumpToPdf={jumpToPdf}
        onAskKady={askKady}
      />
      {confirmClose && (
        <div role="alertdialog" aria-label="Close LaTeX editor" className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <span className="flex-1">Close without saving? Unsaved edits and any AI review will be lost.</span>
          <button onClick={() => setConfirmClose(false)} className="rounded border px-2 py-1">Keep editing</button>
          <button onClick={onDiscard} className="rounded border px-2 py-1 text-red-600">Close without saving</button>
        </div>
      )}
      {syncNotice && <div role="status" className="shrink-0 border-b bg-blue-500/10 px-3 py-1 text-[11px] text-blue-700 dark:text-blue-300">{syncNotice}</div>}
      {logText !== null && <div className="shrink-0 truncate border-b px-3 py-1 text-[10px] text-muted-foreground" title={compileTarget}>Compile target: {compileTarget}</div>}

      <div className={cn("flex flex-1 min-h-0", dragging && "select-none")}>
        {outlineOpen && viewMode !== "pdf" && (
          <OutlinePanel items={outline} currentLine={cursorLine} onJump={jumpToLine} />
        )}

        <div className="flex min-w-0 flex-1">
          {/* Editor pane */}
          <div className={cn("min-w-0 flex-col overflow-hidden", viewMode === "pdf" ? "hidden" : "flex")} style={{ width: viewMode === "source" ? "100%" : `${splitPct}%` }}>
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
            {diskContent !== null && (
              <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1 text-[11px] text-amber-800 dark:text-amber-300">
                <AlertTriangleIcon className="size-3" />
                This file changed on disk while you were editing
                <span className="flex-1" />
                <button
                  onClick={() => applyDiskContent(diskContent)}
                  disabled={aiBusy || aiReview !== null}
                  className="rounded border px-2 py-0.5 hover:bg-muted"
                >
                  Load disk version
                </button>
                <button
                  onClick={keepEditorContent}
                  className="rounded border px-2 py-0.5 hover:bg-muted"
                >
                  Keep mine
                </button>
              </div>
            )}
            <div className="relative flex-1 min-h-0">
              <div className="absolute inset-0">
                <CodeMirror
                  value={openedContentRef.current}
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
          </div>

          {/* Resize divider */}
          {viewMode === "split" && (
            <div
              ref={dividerRef}
              role="separator"
              aria-label="Resize source and PDF panes"
              aria-orientation="vertical"
              aria-valuenow={Math.round(splitPct)}
              aria-valuemin={25}
              aria-valuemax={75}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setSplitPct((pct) => Math.max(25, Math.min(75, pct + (event.key === "ArrowLeft" ? -5 : 5))));
              }}
              className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border transition-colors hover:bg-blue-400 active:bg-blue-500"
              onMouseDown={() => setDragging(true)}
            >
              <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-blue-400" />
            </div>
          )}

          <div className={cn("min-w-0 flex-1 flex-col bg-muted/5", viewMode === "source" ? "hidden" : "flex")}>
            {pdfPath && (previewStale || compileFailed) && <div className="shrink-0 border-b bg-amber-500/10 px-3 py-1 text-[11px] text-amber-800 dark:text-amber-300">{compileFailed ? "Compilation failed. Preview is from the last successful build." : "Source has changed. Compile to update the PDF."}</div>}
            <LatexPdfPane
              pdfPath={pdfPath}
              reloadToken={reloadToken}
              syncHighlight={syncHighlight}
              onSyncClick={handleSyncClick}
              modKey={modKey}
            />
          </div>
        </div>
      </div>
      <LogPanel
        log={logText ?? ""}
        open={logOpen}
        onClose={closeLog}
        filter={logFilter}
        onFilterChange={setLogFilter}
        fileName={path}
        compileTarget={compileTarget}
        errors={compileErrors}
        stale={diagnosticsStale || compiling}
        onJump={jumpToLine}
        onFixError={aiBusy || aiReview ? undefined : fixWithAi}
      />

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
