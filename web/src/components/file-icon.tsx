import { fileCategory } from "@/lib/use-sandbox";
import {
  ActivityIcon,
  AlignJustifyIcon,
  BookOpenIcon,
  BoxesIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileVideoIcon,
  GitForkIcon,
  Grid3x3Icon,
  HexagonIcon,
  TableIcon,
  WavesIcon,
} from "lucide-react";

export function KadyFileIcon({
  name,
  className = "size-4",
}: {
  name: string;
  className?: string;
}) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cat = fileCategory(name);
  const lower = name.toLowerCase();
  const codeExts = [
    "py",
    "ts",
    "tsx",
    "js",
    "jsx",
    "rs",
    "go",
    "java",
    "c",
    "cpp",
    "h",
    "rb",
    "css",
    "scss",
    "html",
    "xml",
    "yaml",
    "yml",
    "toml",
    "graphql",
    "sql",
  ];
  const shellExts = ["sh", "bash", "zsh", "fish", "ps1", "cmd", "bat"];
  const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "heic"];
  const videoExts = ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"];
  const audioExts = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "wma"];
  const archiveExts = ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz"];

  if (lower.endsWith(".h5ad") || lower.endsWith(".h5ad.gz")) {
    return <DatabaseIcon className={`${className} text-indigo-500`} />;
  }
  if (ext === "json" || ext === "jsonl") {
    return <FileJsonIcon className={`${className} text-amber-600`} />;
  }
  if (ext === "pdf") return <FileTextIcon className={`${className} text-red-500`} />;
  if (cat === "notebook") return <BookOpenIcon className={`${className} text-orange-500`} />;
  if (cat === "fasta") return <ActivityIcon className={`${className} text-cyan-600`} />;
  if (cat === "biotable") return <TableIcon className={`${className} text-indigo-500`} />;
  if (cat === "molecule2d") return <HexagonIcon className={`${className} text-fuchsia-500`} />;
  if (cat === "structure3d") return <BoxesIcon className={`${className} text-sky-500`} />;
  if (cat === "massspec") return <WavesIcon className={`${className} text-teal-500`} />;
  if (cat === "arraydata") return <Grid3x3Icon className={`${className} text-cyan-600`} />;
  if (cat === "phylo") return <GitForkIcon className={`${className} text-lime-600`} />;
  if (cat === "alignment") return <AlignJustifyIcon className={`${className} text-violet-600`} />;
  if (cat === "image" || imageExts.includes(ext)) {
    return <FileImageIcon className={`${className} text-rose-500`} />;
  }
  if (cat === "markdown") return <FileTextIcon className={`${className} text-emerald-600`} />;
  if (cat === "latex" || ext === "bib") return <FileCodeIcon className={`${className} text-teal-500`} />;
  if (codeExts.includes(ext)) return <FileCodeIcon className={`${className} text-violet-500`} />;
  if (shellExts.includes(ext)) return <FileTerminalIcon className={`${className} text-slate-500`} />;
  if (videoExts.includes(ext)) return <FileVideoIcon className={`${className} text-blue-500`} />;
  if (audioExts.includes(ext)) return <FileAudioIcon className={`${className} text-purple-500`} />;
  if (archiveExts.includes(ext)) return <FileArchiveIcon className={`${className} text-orange-500`} />;
  if (["csv", "xlsx", "xls", "ods"].includes(ext)) {
    return <FileSpreadsheetIcon className={`${className} text-emerald-600`} />;
  }
  return <FileIcon className={`${className} text-muted-foreground`} />;
}
