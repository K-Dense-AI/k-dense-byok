"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { LatexEditor } from "@/components/latex-editor";
import { cn } from "@/lib/utils";
import { fileCategory, rawFileUrl, type Tab, type LatexCompileResult } from "@/lib/use-sandbox";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs";
import { githubLight } from "@uiw/codemirror-theme-github";
import { keymap } from "@codemirror/view";
import {
  FileIcon,
  FileTextIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileArchiveIcon,
  FileVideoIcon,
  FileAudioIcon,
  FileImageIcon,
  FileTerminalIcon,
  FilesIcon,
  DownloadIcon,
  PencilIcon,
  BrushIcon,
  Undo2Icon,
  Trash2Icon,
  CheckIcon,
  XIcon,
  BookOpenIcon,
  DatabaseIcon,
  TableIcon,
  ActivityIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconForFile(name: string, iconSize = "size-4"): ReactNode {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = ["py","ts","tsx","js","jsx","rs","go","java","c","cpp","h","rb","css","scss","html","xml","yaml","yml","toml","graphql","sql"];
  const shellExts = ["sh","bash","zsh","fish","ps1","cmd","bat"];
  const imageExts = ["png","jpg","jpeg","gif","svg","webp","bmp","ico","tiff","heic"];
  const videoExts = ["mp4","mov","avi","mkv","webm","flv","wmv","m4v"];
  const audioExts = ["mp3","wav","ogg","flac","m4a","aac","opus","wma"];
  const archiveExts = ["zip","tar","gz","bz2","xz","7z","rar","tgz"];
  const spreadsheetExts = ["csv","xlsx","xls","ods"];
  const docExts = ["doc","docx","odt","rtf"];
  const fastaExts = ["fasta","fa","faa","fna","ffn","fastq","fq"];
  const biotableExts = ["vcf","bed","gff","gtf","gff3","sam","bcf","tsv"];

  if (ext === "json" || ext === "jsonl") return <FileJsonIcon className={`${iconSize} text-amber-600`} />;
  if (ext === "pdf") return <FileTextIcon className={`${iconSize} text-red-500`} />;
  if (ext === "ipynb") return <BookOpenIcon className={`${iconSize} text-orange-500`} />;
  if (ext === "tex" || ext === "latex" || ext === "bib") return <FileCodeIcon className={`${iconSize} text-teal-500`} />;
  if (codeExts.includes(ext)) return <FileCodeIcon className={`${iconSize} text-violet-500`} />;
  if (shellExts.includes(ext)) return <FileTerminalIcon className={`${iconSize} text-slate-500`} />;
  if (imageExts.includes(ext)) return <FileImageIcon className={`${iconSize} text-rose-500`} />;
  if (videoExts.includes(ext)) return <FileVideoIcon className={`${iconSize} text-blue-500`} />;
  if (audioExts.includes(ext)) return <FileAudioIcon className={`${iconSize} text-purple-500`} />;
  if (archiveExts.includes(ext)) return <FileArchiveIcon className={`${iconSize} text-orange-500`} />;
  if (spreadsheetExts.includes(ext)) return <FileSpreadsheetIcon className={`${iconSize} text-emerald-600`} />;
  if (fastaExts.includes(ext)) return <ActivityIcon className={`${iconSize} text-cyan-600`} />;
  if (biotableExts.includes(ext)) return <TableIcon className={`${iconSize} text-indigo-500`} />;
  if (["md","mdx","txt","log","rst"].includes(ext)) return <FileTextIcon className={`${iconSize} text-emerald-600`} />;
  if (docExts.includes(ext)) return <FileTextIcon className={`${iconSize} text-blue-600`} />;
  return <FileIcon className={`${iconSize} text-muted-foreground`} />;
}

function langForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py:"python",ts:"typescript",tsx:"tsx",js:"javascript",jsx:"jsx",json:"json",jsonl:"json",
    md:"markdown",yaml:"yaml",yml:"yaml",toml:"toml",sh:"bash",bash:"bash",css:"css",html:"html",
    xml:"xml",rs:"rust",go:"go",java:"java",c:"c",cpp:"cpp",rb:"ruby",sql:"sql",csv:"csv",txt:"text",
  };
  return map[ext] ?? (ext || "text");
}

function categoryLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cat = fileCategory(name);
  if (cat === "image") return "image";
  if (cat === "pdf") return "pdf";
  if (cat === "markdown") return "markdown";
  if (cat === "csv") return "csv";
  if (cat === "notebook") return "jupyter";
  if (cat === "latex") return "latex";
  if (cat === "fasta") return ext === "fastq" || ext === "fq" ? "fastq" : "fasta";
  if (cat === "biotable") return ext;
  return langForFile(name);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(current); current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

type PanelMode = "view" | "edit" | "annotate";

function TabBar({
  tabs,
  activeTabPath,
  tabModes,
  onSelect,
  onClose,
}: {
  tabs: Tab[];
  activeTabPath: string | null;
  tabModes: Record<string, PanelMode>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (!scrollRef.current || !activeTabPath) return;
    const activeEl = scrollRef.current.querySelector<HTMLElement>('[data-active="true"]');
    activeEl?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeTabPath]);

  const uniqueTabs = useMemo(() => {
    const seen = new Set<string>();
    return tabs.filter((t) => {
      if (seen.has(t.path)) return false;
      seen.add(t.path);
      return true;
    });
  }, [tabs]);

  if (uniqueTabs.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="flex overflow-x-auto border-b bg-muted/20 shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {uniqueTabs.map((tab) => {
        const name = tab.path.split("/").pop() ?? tab.path;
        const isActive = tab.path === activeTabPath;
        const mode = tabModes[tab.path] ?? "view";
        const isEditing = mode === "edit" || mode === "annotate";

        return (
          <div
            key={tab.path}
            data-active={isActive}
            onClick={() => onSelect(tab.path)}
            title={tab.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-kady-filepath", tab.path);
              e.dataTransfer.effectAllowed = "copy";
              const ghost = document.createElement("div");
              ghost.textContent = name;
              ghost.style.cssText =
                "position:absolute;top:-1000px;background:#6366f1;color:white;padding:3px 8px;border-radius:4px;font-size:11px;font-family:monospace;box-shadow:0 2px 8px rgba(0,0,0,0.2)";
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 0, 0);
              setTimeout(() => ghost.remove(), 0);
            }}
            className={cn(
              "group relative flex min-w-0 max-w-[200px] shrink-0 cursor-pointer select-none",
              "items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors",
              isActive
                ? "bg-background text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            {/* File icon */}
            <span className="shrink-0">
              {tab.loading ? (
                <div className="size-3.5 animate-spin rounded-full border border-muted-foreground/30 border-t-muted-foreground" />
              ) : (
                iconForFile(name, "size-3.5")
              )}
            </span>

            {/* Filename */}
            <span className="truncate">{name}</span>

            {/* Unsaved / annotating indicator */}
            {isEditing && (
              <div className="size-1.5 shrink-0 rounded-full bg-amber-500" title="In edit mode" />
            )}

            {/* Close button */}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}
              className={cn(
                "ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-all",
                "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-muted-foreground/20",
                isActive && "opacity-40"
              )}
              title="Close tab"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View-mode renderers
// ---------------------------------------------------------------------------

function CsvViewer({ content }: { content: string }) {
  const rows = useMemo(() => parseCsv(content), [content]);
  if (rows.length === 0) return null;
  const header = rows[0];
  const body = rows.slice(1);
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>{header.map((c, i) => <th key={i} className="sticky top-0 border-b bg-muted px-3 py-1.5 text-left font-semibold">{c}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-b border-muted/50 hover:bg-muted/30">
              {row.map((c, ci) => <td key={ci} className="px-3 py-1 text-muted-foreground whitespace-nowrap">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Language detection for CodeMirror
// ---------------------------------------------------------------------------

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

function ReadOnlyCodeView({
  content,
  name,
  className,
}: {
  content: string;
  name: string;
  className?: string;
}) {
  const extensions = useMemo(() => {
    const lang = langExtension(name);
    return [
      ...(lang ? [lang] : []),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ];
  }, [name]);

  return (
    <CodeMirror
      value={content}
      extensions={extensions}
      theme={githubLight}
      editable={false}
      readOnly
      height="100%"
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

function resolveMarkdownImageUrls(content: string, filePath: string): string {
  const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1) || "";
  const isAbsolute = (u: string) =>
    /^https?:\/\//.test(u) || u.startsWith("data:") || u.startsWith("blob:");
  const resolve = (u: string) =>
    rawFileUrl(u.startsWith("/") ? u : dir + u);

  let out = content.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt, url) => (isAbsolute(url) ? m : `![${alt}](${resolve(url)})`),
  );
  out = out.replace(
    /(<img\s[^>]*?)src=(["'])([^"']+)\2/gi,
    (m, before, q, url) => (isAbsolute(url) ? m : `${before}src=${q}${resolve(url)}${q}`),
  );
  return out;
}

function FileViewer({
  path, name, content, loading,
}: {
  path: string; name: string | null; content: string | null; loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }
  const cat = name ? fileCategory(name) : "text";
  if (cat === "image") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={rawFileUrl(path)} alt={name ?? ""} className="max-h-full max-w-full rounded object-contain shadow-sm" />
      </div>
    );
  }
  if (cat === "pdf") {
    return <iframe src={rawFileUrl(path)} title={name ?? "PDF"} className="h-full w-full" />;
  }
  if (content === null) return null;
  if (cat === "markdown") {
    return (
      <div className="h-full overflow-auto p-6 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <MessageResponse>{resolveMarkdownImageUrls(content, path)}</MessageResponse>
      </div>
    );
  }
  if (cat === "csv") return <CsvViewer content={content} />;
  if (cat === "notebook") return <NotebookViewer content={content} />;
  if (cat === "fasta") {
    const ext = name?.split(".").pop()?.toLowerCase() ?? "";
    return <FastaViewer content={content} isQ={ext === "fastq" || ext === "fq"} />;
  }
  if (cat === "biotable") {
    const ext = name?.split(".").pop()?.toLowerCase() ?? "";
    return <BioTableViewer content={content} ext={ext} />;
  }
  return (
    <ReadOnlyCodeView content={content} name={name ?? "text"} className="h-full" />
  );
}

// ---------------------------------------------------------------------------
// Jupyter Notebook viewer
// ---------------------------------------------------------------------------

interface NbOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
}

interface NbCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NbOutput[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NbCell[];
  metadata?: {
    kernelspec?: { display_name?: string; language?: string };
    language_info?: { name?: string };
  };
}

function nbText(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v.join("") : v;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
}

function NotebookOutput({ out }: { out: NbOutput }) {
  if (out.output_type === "stream") {
    const text = nbText(out.text);
    return (
      <div className={cn("px-4 py-2 text-xs font-mono whitespace-pre-wrap border-t",
        out.name === "stderr" ? "bg-red-50 text-red-700" : "text-foreground/75 bg-muted/20"
      )}>
        {text}
      </div>
    );
  }
  if (out.output_type === "execute_result" || out.output_type === "display_data") {
    const data = out.data ?? {};
    if (data["image/png"]) {
      const src = typeof data["image/png"] === "string"
        ? data["image/png"]
        : (data["image/png"] as string[]).join("");
      return (
        <div className="border-t px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${src}`} alt="cell output" className="max-w-full" />
        </div>
      );
    }
    if (data["image/svg+xml"]) {
      const svg = nbText(data["image/svg+xml"] as string | string[]);
      return (
        <div className="border-t px-4 py-3 overflow-x-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }} />
      );
    }
    if (data["text/html"]) {
      const html = nbText(data["text/html"] as string | string[]);
      return (
        <div className="border-t px-4 py-2 text-xs overflow-x-auto [&_table]:text-xs [&_td]:px-2 [&_th]:px-2"
          dangerouslySetInnerHTML={{ __html: html }} />
      );
    }
    const plain = nbText(data["text/plain"] as string | string[] | undefined);
    if (!plain) return null;
    return (
      <div className="flex items-start gap-2 border-t px-4 py-2">
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50 mt-0.5">
          Out [{out.execution_count ?? " "}]:
        </span>
        <pre className="text-xs font-mono text-foreground/75 whitespace-pre-wrap">{plain}</pre>
      </div>
    );
  }
  if (out.output_type === "error") {
    const tb = stripAnsi((out.traceback ?? []).join("\n"));
    return (
      <div className="border-t bg-red-50/70 px-4 py-2">
        <p className="text-xs font-mono font-semibold text-red-600">{out.ename}: {out.evalue}</p>
        {tb && <pre className="mt-1 text-[11px] font-mono text-red-500/80 whitespace-pre-wrap overflow-x-auto">{tb}</pre>}
      </div>
    );
  }
  return null;
}

function NotebookCell({ cell, index, lang }: { cell: NbCell; index: number; lang: string }) {
  const source = nbText(cell.source);
  const [collapsed, setCollapsed] = useState(false);

  if (cell.cell_type === "markdown") {
    return (
      <div className="px-1 py-1 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <MessageResponse>{source}</MessageResponse>
      </div>
    );
  }

  if (cell.cell_type === "code") {
    const execCount = cell.execution_count;
    const outputs = cell.outputs ?? [];
    return (
      <div className="rounded-md border overflow-hidden bg-background">
        {/* Cell header */}
        <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1">
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60 w-12">
            In [{execCount ?? " "}]:
          </span>
          <span className="flex-1" />
          {outputs.length > 0 && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title={collapsed ? "Show outputs" : "Collapse outputs"}
            >
              {collapsed ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
              {outputs.length} output{outputs.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
        {/* Source */}
        <ReadOnlyCodeView content={source} name={`cell.${lang === "python" ? "py" : lang}`} />
        {/* Outputs */}
        {!collapsed && outputs.map((out, i) => <NotebookOutput key={i} out={out} />)}
      </div>
    );
  }

  // raw cell
  return (
    <pre className="rounded border bg-muted/10 p-3 text-xs font-mono text-muted-foreground">{source}</pre>
  );
}

function NotebookViewer({ content }: { content: string }) {
  const nb = useMemo<Notebook | null>(() => {
    try { return JSON.parse(content) as Notebook; } catch { return null; }
  }, [content]);

  if (!nb) return (
    <div className="flex h-full items-center justify-center text-sm text-red-500">
      Could not parse notebook JSON
    </div>
  );

  const cells = nb.cells ?? [];
  const lang = nb.metadata?.language_info?.name
    ?? nb.metadata?.kernelspec?.language
    ?? "python";
  const kernelName = nb.metadata?.kernelspec?.display_name ?? lang;

  const codeCells = cells.filter(c => c.cell_type === "code").length;
  const mdCells = cells.filter(c => c.cell_type === "markdown").length;

  return (
    <div className="h-full overflow-auto">
      {/* Notebook meta bar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <BookOpenIcon className="size-4 text-orange-500 shrink-0" />
        <span className="text-sm font-semibold">{kernelName}</span>
        <span className="text-xs text-muted-foreground">
          {cells.length} cells · {codeCells} code · {mdCells} markdown
        </span>
      </div>

      {/* Cells */}
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-4">
        {cells.slice(0, 300).map((cell, i) => (
          <NotebookCell key={i} cell={cell} index={i} lang={lang} />
        ))}
        {cells.length > 300 && (
          <p className="text-center text-xs text-muted-foreground py-2">
            … {cells.length - 300} more cells not shown
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FASTA / FASTQ sequence viewer
// ---------------------------------------------------------------------------

interface FastaRecord {
  id: string;
  description: string;
  sequence: string;
  quality?: string; // FASTQ only
}

function parseFasta(text: string): FastaRecord[] {
  const records: FastaRecord[] = [];
  let cur: FastaRecord | null = null;
  let phase: "seq" | "plus" | "qual" = "seq";

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (line.startsWith(">") || line.startsWith("@")) {
      if (cur) records.push(cur);
      const header = line.slice(1);
      const sp = header.indexOf(" ");
      cur = {
        id: sp === -1 ? header : header.slice(0, sp),
        description: sp === -1 ? "" : header.slice(sp + 1),
        sequence: "",
      };
      phase = "seq";
    } else if (line.startsWith("+") && cur && !cur.quality) {
      phase = "qual";
    } else if (phase === "seq" && cur) {
      cur.sequence += line.toUpperCase();
    } else if (phase === "qual" && cur) {
      cur.quality = (cur.quality ?? "") + line;
    }
  }
  if (cur) records.push(cur);
  return records;
}

function detectSeqType(seq: string): "dna" | "rna" | "protein" {
  const s = seq.slice(0, 200).replace(/[NXBZ-]/g, "");
  if (/^[ACGT]+$/i.test(s)) return "dna";
  if (/^[ACGU]+$/i.test(s)) return "rna";
  return "protein";
}

function gcContent(seq: string): number {
  const gc = [...seq].filter(c => c === "G" || c === "C").length;
  return (gc / seq.length) * 100;
}

const DNA_COLOR: Record<string, string> = {
  A: "text-emerald-600",
  T: "text-rose-500",
  C: "text-blue-500",
  G: "text-amber-500",
  U: "text-purple-500",
  N: "text-muted-foreground",
  "-": "text-muted-foreground/30",
};

const AA_COLOR: Record<string, string> = {
  // Hydrophobic
  A: "text-amber-600", V: "text-amber-600", I: "text-amber-600", L: "text-amber-600",
  M: "text-amber-600", F: "text-orange-600", W: "text-orange-600", P: "text-amber-500",
  // Polar uncharged
  S: "text-emerald-600", T: "text-emerald-600", C: "text-yellow-600",
  Y: "text-emerald-700", N: "text-emerald-600", Q: "text-emerald-600", G: "text-slate-400",
  // Negative
  D: "text-red-500", E: "text-red-500",
  // Positive
  K: "text-blue-500", R: "text-blue-600", H: "text-blue-400",
  "*": "text-muted-foreground/40",
};

function ColoredSeq({ seq, type, limit = 600 }: { seq: string; type: "dna" | "rna" | "protein"; limit?: number }) {
  const colors = type === "protein" ? AA_COLOR : DNA_COLOR;
  const display = seq.slice(0, limit);
  return (
    <span className="font-mono text-xs leading-relaxed break-all">
      {display.split("").map((ch, i) => (
        <span key={i} className={colors[ch] ?? "text-foreground"}>{ch}</span>
      ))}
      {seq.length > limit && (
        <span className="text-muted-foreground/60"> …+{(seq.length - limit).toLocaleString()} more</span>
      )}
    </span>
  );
}

function QualBar({ quality, limit = 150 }: { quality: string; limit?: number }) {
  const display = quality.slice(0, limit);
  return (
    <div className="mt-1 flex gap-px flex-wrap">
      {display.split("").map((ch, i) => {
        const q = ch.charCodeAt(0) - 33;
        const pct = Math.min(100, (q / 40) * 100);
        const color = q >= 30 ? "bg-emerald-500" : q >= 20 ? "bg-amber-400" : "bg-red-400";
        return (
          <div key={i} title={`Q${q}`} className={cn("w-1.5 rounded-sm", color)}
            style={{ height: `${Math.max(4, pct * 0.16)}px` }} />
        );
      })}
      {quality.length > limit && (
        <span className="text-[10px] text-muted-foreground/60 ml-1">+{quality.length - limit} more</span>
      )}
    </div>
  );
}

function FastaViewer({ content, isQ }: { content: string; isQ?: boolean }) {
  const records = useMemo(() => parseFasta(content), [content]);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? records : records.slice(0, 20);

  const totalLen = records.reduce((s, r) => s + r.sequence.length, 0);

  return (
    <div className="h-full overflow-auto">
      {/* Summary */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur text-xs">
        <ActivityIcon className="size-3.5 text-cyan-600 shrink-0" />
        <span className="font-semibold">{records.length.toLocaleString()} sequence{records.length !== 1 ? "s" : ""}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{totalLen.toLocaleString()} total residues</span>
        {isQ && <span className="rounded bg-cyan-50 px-1.5 py-0.5 font-semibold text-cyan-700 text-[10px] uppercase">FASTQ</span>}
      </div>

      <div className="space-y-3 p-4">
        {visible.map((rec, i) => {
          const type = detectSeqType(rec.sequence);
          const gc = (type === "dna" || type === "rna") ? gcContent(rec.sequence) : null;
          return (
            <div key={i} className="rounded-md border overflow-hidden">
              {/* Header */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/20 px-3 py-1.5">
                <span className="font-mono font-semibold text-xs">{rec.id}</span>
                {rec.description && (
                  <span className="flex-1 truncate text-xs text-muted-foreground">{rec.description}</span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">{type}</span>
                  <span className="text-[10px] text-muted-foreground">{rec.sequence.length.toLocaleString()} bp</span>
                  {gc !== null && (
                    <span className="text-[10px] text-muted-foreground">GC {gc.toFixed(1)}%</span>
                  )}
                </div>
              </div>
              {/* Sequence */}
              <div className="bg-muted/5 p-3">
                <ColoredSeq seq={rec.sequence} type={type} />
                {rec.quality && <QualBar quality={rec.quality} />}
              </div>
            </div>
          );
        })}

        {!showAll && records.length > 20 && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full rounded-md border py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
          >
            Show {records.length - 20} more sequences
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bioinformatics table viewer (VCF, BED, GFF/GTF, SAM, TSV)
// ---------------------------------------------------------------------------

const BIO_FORMAT_DEFAULTS: Record<string, string[]> = {
  bed: ["chrom","chromStart","chromEnd","name","score","strand","thickStart","thickEnd","itemRgb","blockCount","blockSizes","blockStarts"],
  sam: ["QNAME","FLAG","RNAME","POS","MAPQ","CIGAR","RNEXT","PNEXT","TLEN","SEQ","QUAL"],
  gff: ["seqname","source","feature","start","end","score","strand","frame","attribute"],
  gtf: ["seqname","source","feature","start","end","score","strand","frame","attribute"],
  gff3: ["seqname","source","feature","start","end","score","strand","frame","attribute"],
};

function parseBioTable(content: string, ext: string): { headers: string[]; rows: string[][]; metaLines: string[] } {
  const lines = content.split("\n");
  const metaLines: string[] = [];
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("##")) metaLines.push(line);
    else if (line.trim()) dataLines.push(line);
  }

  if (dataLines.length === 0) return { headers: [], rows: [], metaLines };

  let headers: string[] = [];
  let startIdx = 0;

  if (dataLines[0].startsWith("#")) {
    headers = dataLines[0].slice(1).split("\t").map(h => h.trim());
    startIdx = 1;
  } else {
    headers = BIO_FORMAT_DEFAULTS[ext] ?? [];
  }

  const rows = dataLines.slice(startIdx, startIdx + 1000).map(l => l.split("\t"));
  return { headers, rows, metaLines };
}

function BioTableViewer({ content, ext }: { content: string; ext: string }) {
  const { headers, rows, metaLines } = useMemo(() => parseBioTable(content, ext), [content, ext]);
  const [showMeta, setShowMeta] = useState(false);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No data rows found
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-3 border-b bg-background/95 px-4 py-2 text-xs">
        <TableIcon className="size-3.5 text-indigo-500 shrink-0" />
        <span className="font-semibold">{rows.length.toLocaleString()}{rows.length >= 1000 ? "+" : ""} rows</span>
        {headers.length > 0 && (
          <><span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{headers.length} columns</span></>
        )}
        {metaLines.length > 0 && (
          <button
            onClick={() => setShowMeta(v => !v)}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          >
            {showMeta ? "Hide" : "Show"} {metaLines.length} metadata lines
          </button>
        )}
      </div>

      {/* Metadata */}
      {showMeta && (
        <pre className="shrink-0 max-h-40 overflow-auto border-b bg-muted/10 px-4 py-2 text-[11px] font-mono text-muted-foreground">
          {metaLines.join("\n")}
        </pre>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          {headers.length > 0 && (
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th key={i} className="sticky top-0 border-b bg-muted px-3 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-muted/50 hover:bg-muted/20">
                {row.map((cell, ci) => (
                  <td key={ci} className="max-w-[280px] truncate px-3 py-1 text-muted-foreground" title={cell}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TextEditor (with CodeMirror syntax highlighting)
// ---------------------------------------------------------------------------

function TextEditor({
  name,
  initialContent,
  onSave,
  onDiscard,
}: {
  name: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onDiscard: () => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const isDirty = content !== initialContent;

  // Use a ref so the keymap closure never goes stale
  const handleSaveRef = useRef<() => void>(() => {});

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await onSave(content);
    setSaving(false);
    if (ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
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
        <span className="ml-auto text-[10px] text-muted-foreground/50 font-mono">⌘S to save</span>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImageAnnotator
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

function ImageAnnotator({
  path,
  onSave,
  onDiscard,
}: {
  path: string;
  onSave: (blob: Blob) => Promise<boolean>;
  onDiscard: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const currentStrokeRef = useRef<Point[]>([]);
  const isDrawingRef = useRef(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const brushWidth = useCallback(() => {
    if (!canvasRef.current) return 4;
    return Math.max(3, Math.min(canvasRef.current.width, canvasRef.current.height) * 0.007);
  }, []);

  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = brushWidth();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
      ctx.stroke();
    }
  }, [brushWidth]);

  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.src = `${rawFileUrl(path)}&_t=${Date.now()}`;
    img.onload = () => {
      imgRef.current = img;
      if (canvasRef.current) {
        canvasRef.current.width = img.naturalWidth;
        canvasRef.current.height = img.naturalHeight;
        redrawAll();
      }
      setLoaded(true);
    };
  }, [path, redrawAll]);

  const getPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    isDrawingRef.current = true;
    const pos = getPos(e);
    currentStrokeRef.current = [pos];
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, brushWidth() / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [getPos, brushWidth]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const pos = getPos(e);
    const prev = currentStrokeRef.current[currentStrokeRef.current.length - 1];
    currentStrokeRef.current.push(pos);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && prev) {
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = brushWidth();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  }, [getPos, brushWidth]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (currentStrokeRef.current.length > 0) {
      strokesRef.current = [...strokesRef.current, currentStrokeRef.current];
      currentStrokeRef.current = [];
      setStrokeCount(strokesRef.current.length);
    }
  }, []);

  const handleUndo = useCallback(() => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    redrawAll();
  }, [redrawAll]);

  const handleClear = useCallback(() => {
    strokesRef.current = [];
    setStrokeCount(0);
    redrawAll();
  }, [redrawAll]);

  const handleSave = useCallback(() => {
    setSaving(true);
    canvasRef.current?.toBlob(async (blob) => {
      if (blob) {
        const ok = await onSave(blob);
        if (ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
      }
      setSaving(false);
    }, "image/png");
  }, [onSave]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-red-50/80 px-3 py-1.5">
        <div className="size-2 rounded-full bg-red-500" />
        <span className="text-xs font-medium text-red-700">Red marker</span>
        <span className="text-xs text-muted-foreground/60">
          {strokeCount} stroke{strokeCount !== 1 ? "s" : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={handleUndo} disabled={strokeCount === 0}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            title="Undo last stroke"
          >
            <Undo2Icon className="size-3" /> Undo
          </button>
          <button onClick={handleClear} disabled={strokeCount === 0}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            title="Clear all annotations"
          >
            <Trash2Icon className="size-3" /> Clear
          </button>
          <button onClick={onDiscard}
            className="rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button onClick={handleSave} disabled={strokeCount === 0 || saving}
            className="flex items-center gap-1.5 rounded bg-red-500 px-2.5 py-1 text-xs text-white transition-opacity disabled:opacity-40"
          >
            {saved ? <CheckIcon className="size-3" /> : null}
            {saving ? "Saving…" : saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(#f0f0f0_0%_25%,white_0%_50%)] bg-[length:20px_20px] p-4">
        {!loaded && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            Loading…
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={cn("cursor-crosshair touch-none select-none shadow-lg rounded", !loaded && "hidden")}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilePreviewPanel (exported)
// ---------------------------------------------------------------------------

export interface FilePreviewPanelProps {
  tabs: Tab[];
  activeTabPath: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
  onDownload: (path: string) => void;
  onSaveText: (path: string, content: string) => Promise<boolean>;
  onSaveImageBlob: (path: string, blob: Blob) => Promise<boolean>;
  onCompileLatex?: (path: string, engine?: string) => Promise<LatexCompileResult>;
}

export function FilePreviewPanel({
  tabs,
  activeTabPath,
  onTabSelect,
  onTabClose,
  onDownload,
  onSaveText,
  onSaveImageBlob,
  onCompileLatex,
}: FilePreviewPanelProps) {
  // Per-tab mode tracking
  const [tabModes, setTabModes] = useState<Record<string, PanelMode>>({});

  const setMode = useCallback((path: string, mode: PanelMode) => {
    setTabModes((prev) => ({ ...prev, [path]: mode }));
  }, []);

  // Derive active tab state
  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;
  const selectedPath = activeTab?.path ?? null;
  const fileContent = activeTab?.content ?? null;
  const loadingFile = activeTab?.loading ?? false;
  const mode = selectedPath ? (tabModes[selectedPath] ?? "view") : "view";

  const selectedName = selectedPath?.split("/").pop() ?? null;
  const cat = selectedName ? fileCategory(selectedName) : "text";
  // All text-based formats can be edited as source
  const canEdit = cat !== "image" && cat !== "pdf";
  const canAnnotate = cat === "image";

  const header = selectedPath && (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
      {selectedName && iconForFile(selectedName)}
      <span className="flex-1 truncate font-mono text-xs text-foreground/70" title={selectedPath}>
        {selectedPath}
      </span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {categoryLabel(selectedName ?? "")}
      </span>
      {canEdit && mode === "view" && (
        <button
          onClick={() => setMode(selectedPath, "edit")}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Edit file"
        >
          <PencilIcon className="size-3" /> Edit
        </button>
      )}
      {canAnnotate && mode === "view" && (
        <button
          onClick={() => setMode(selectedPath, "annotate")}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Annotate with red marker"
        >
          <BrushIcon className="size-3" /> Annotate
        </button>
      )}
      <button
        onClick={() => onDownload(selectedPath)}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Download"
      >
        <DownloadIcon className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col border-r">
      {/* Tab bar */}
      <TabBar
        tabs={tabs}
        activeTabPath={activeTabPath}
        tabModes={tabModes}
        onSelect={onTabSelect}
        onClose={onTabClose}
      />

      {/* Empty state — no tabs open */}
      {!selectedPath && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
            <FilesIcon className="size-6 text-muted-foreground/30" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">No file selected</p>
            <p className="text-xs text-muted-foreground/60">Click a file in the sidebar to open it</p>
          </div>
        </div>
      )}

      {/* Edit mode — LaTeX gets the split-pane editor */}
      {selectedPath && mode === "edit" && cat === "latex" && onCompileLatex && (
        <>
          {header}
          <div className="flex-1 min-h-0">
            <LatexEditor
              key={selectedPath}
              path={selectedPath}
              name={selectedName ?? ""}
              initialContent={fileContent ?? ""}
              onSave={(content) => onSaveText(selectedPath, content)}
              onCompile={onCompileLatex}
              onDiscard={() => setMode(selectedPath, "view")}
            />
          </div>
        </>
      )}

      {/* Edit mode — standard text editor */}
      {selectedPath && mode === "edit" && (cat !== "latex" || !onCompileLatex) && (
        <>
          {header}
          <div className="flex-1 min-h-0">
            <TextEditor
              key={selectedPath}
              name={selectedName ?? ""}
              initialContent={fileContent ?? ""}
              onSave={(content) => onSaveText(selectedPath, content)}
              onDiscard={() => setMode(selectedPath, "view")}
            />
          </div>
        </>
      )}

      {/* Annotate mode */}
      {selectedPath && mode === "annotate" && (
        <>
          {header}
          <div className="flex-1 min-h-0">
            <ImageAnnotator
              path={selectedPath}
              onSave={(blob) => onSaveImageBlob(selectedPath, blob)}
              onDiscard={() => setMode(selectedPath, "view")}
            />
          </div>
        </>
      )}

      {/* View mode */}
      {selectedPath && mode === "view" && (
        <>
          {header}
          <div className={cn(
            "flex-1 min-h-0",
            // These viewers manage their own scroll internally
            cat === "pdf" || cat === "notebook" || cat === "fasta" || cat === "biotable"
              ? ""
              : "overflow-auto bg-muted/10"
          )}>
            <FileViewer
              path={selectedPath}
              name={selectedName}
              content={fileContent}
              loading={loadingFile}
            />
          </div>
        </>
      )}
    </div>
  );
}
