/**
 * Make the child-only kady-pdf-annotations package available to pi-subagents
 * and extend package-owned builtin specialist tool allowlists.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { MODAL_TOOL_NAMES } from "./modal-tool.ts";
import { PDF_ANNOTATION_TOOL_NAMES } from "./pdf-annotation-tool.ts";

const require_ = createRequire(import.meta.url);

export function kadyPdfAnnotationPackageDir(): string {
  return path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "pi-packages",
    "kady-pdf-annotations",
  );
}

function isPdfAnnotationSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]kady-pdf-annotations$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

export function seedPdfAnnotationPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const packageDir = kadyPdfAnnotationPackageDir();
  const packages = Array.isArray(settings.packages)
    ? [...settings.packages]
    : [];
  const kept = packages.filter(
    (entry) => !isPdfAnnotationSource(entry) || entry === packageDir,
  );
  if (kept.includes(packageDir) && kept.length === packages.length) {
    return false;
  }
  if (!kept.includes(packageDir)) kept.push(packageDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8",
  );
  return true;
}

function builtinAgentsDir(): string | null {
  try {
    const packageJson = require_.resolve("pi-subagents/package.json");
    return path.join(path.dirname(packageJson), "agents");
  } catch {
    return null;
  }
}

function parseFrontmatter(
  file: string,
): { name?: string; tools?: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const value: { name?: string; tools?: string[] } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) value.name = name[1];
    const tools = /^tools:\s*(.+?)\s*$/.exec(line);
    if (tools) {
      value.tools = tools[1]
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
    }
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

/**
 * Notebook and Modal bridges run first. Only extend their known generated
 * shapes; any other existing override is user-owned and remains authoritative.
 */
export function seedBuiltinAgentPdfAnnotationTools(
  paths: ProjectPaths,
): boolean {
  const agentsDir = builtinAgentsDir();
  if (!agentsDir) return false;
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
  } catch {
    return false;
  }

  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const subagents =
    settings.subagents &&
    typeof settings.subagents === "object" &&
    !Array.isArray(settings.subagents)
      ? (settings.subagents as Record<string, unknown>)
      : {};
  const overrides =
    subagents.agentOverrides &&
    typeof subagents.agentOverrides === "object" &&
    !Array.isArray(subagents.agentOverrides)
      ? (subagents.agentOverrides as Record<string, unknown>)
      : {};

  let changed = false;
  for (const file of files) {
    const builtin = parseFrontmatter(path.join(agentsDir, file));
    if (!builtin.name || !builtin.tools?.length) continue;
    const existing = overrides[builtin.name];
    if (
      existing !== undefined &&
      (typeof existing !== "object" ||
        existing === null ||
        Array.isArray(existing))
    ) {
      continue;
    }
    const override = (existing ?? {}) as Record<string, unknown>;
    if ("tools" in override) {
      if (
        !Array.isArray(override.tools) ||
        override.tools.some((tool) => typeof tool !== "string")
      ) {
        continue;
      }
      const existingTools = override.tools as string[];
      const base = builtin.tools;
      const notebook = unique([...base, "notebook"]);
      const modal = unique([...base, ...MODAL_TOOL_NAMES]);
      const notebookModal = unique([...notebook, ...MODAL_TOOL_NAMES]);
      const generated = [base, notebook, modal, notebookModal].flatMap(
        (tools) => [
          tools,
          unique([...tools, ...PDF_ANNOTATION_TOOL_NAMES]),
        ],
      );
      if (!generated.some((tools) => sameSet(existingTools, tools))) continue;

      const next = unique([
        ...existingTools,
        ...PDF_ANNOTATION_TOOL_NAMES,
      ]);
      if (next.length === existingTools.length) continue;
      overrides[builtin.name] = { ...override, tools: next };
      changed = true;
      continue;
    }
    overrides[builtin.name] = {
      ...override,
      tools: [...builtin.tools, ...PDF_ANNOTATION_TOOL_NAMES],
    };
    changed = true;
  }

  if (!changed) return false;
  subagents.agentOverrides = overrides;
  settings.subagents = subagents;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8",
  );
  return true;
}
