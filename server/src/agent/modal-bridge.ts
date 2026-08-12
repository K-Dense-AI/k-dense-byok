import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { modalJobManager } from "../modal/manager.ts";
import { subagentsPackageDir } from "./agent-files.ts";
import { MODAL_TOOL_NAMES } from "./modal-tool.ts";
import { PDF_ANNOTATION_TOOL_NAMES } from "./pdf-annotation-tool.ts";
import { reconcileBuiltinTools } from "./builtin-tool-overrides.ts";

export function kadyModalPackageDir(): string {
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "kady-modal");
}

function isModalSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]kady-modal$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

export function seedModalPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const packageDir = kadyModalPackageDir();
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const kept = packages.filter((entry) => !isModalSource(entry) || entry === packageDir);
  if (kept.includes(packageDir) && kept.length === packages.length) return false;
  if (!kept.includes(packageDir)) kept.push(packageDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

function builtinAgentsDir(): string | null {
  try {
    return path.join(subagentsPackageDir(), "agents");
  } catch {
    return null;
  }
}

function parseFrontmatter(file: string): { name?: string; tools?: string[] } {
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
      value.tools = tools[1].split(",").map((tool) => tool.trim()).filter(Boolean);
    }
  }
  return value;
}


/**
 * Extend package-owned builtin allowlists while preserving user-pinned lists.
 *
 * notebook-bridge runs first and seeds `builtin tools + notebook`. We recognize
 * only that generated shape (or our own already-generated shape); any other
 * existing `tools` override is treated as user-owned and left unchanged.
 */
export function seedBuiltinAgentModalTools(paths: ProjectPaths): boolean {
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
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const subagents =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
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
      (typeof existing !== "object" || existing === null || Array.isArray(existing))
    ) {
      continue;
    }
    const override = (existing ?? {}) as Record<string, unknown>;
    if ("tools" in override) {
      if (!Array.isArray(override.tools) || override.tools.some((tool) => typeof tool !== "string")) {
        continue;
      }
      const existingTools = override.tools as string[];
      const generatedNotebook = [...builtin.tools, "notebook"];
      const generatedModal = [...generatedNotebook, ...MODAL_TOOL_NAMES];
      const generatedModalWithPdf = [
        ...generatedModal,
        ...PDF_ANNOTATION_TOOL_NAMES,
      ];
      // Reconciled, not only extended: an override seeded before an upstream
      // release narrowed this builtin still carries the tools it removed.
      const next = reconcileBuiltinTools({
        existing: existingTools,
        declared: builtin.tools,
        add: MODAL_TOOL_NAMES,
        shapes: [generatedNotebook, generatedModal, generatedModalWithPdf],
      });
      if (!next) continue;
      overrides[builtin.name] = { ...override, tools: next };
      changed = true;
      continue;
    }
    overrides[builtin.name] = {
      ...override,
      tools: [...builtin.tools, ...MODAL_TOOL_NAMES],
    };
    changed = true;
  }
  if (!changed) return false;
  subagents.agentOverrides = overrides;
  settings.subagents = subagents;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

/**
 * Correlate child-owned Modal jobs back to the parent chat once pi-subagents
 * reports the child run id. Async jobs are normally still active here; short
 * blocking jobs have their already-written compute row moved atomically.
 */
export function makeSubagentModalExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory {
  const reconcile = (value: unknown) => {
    const parentSessionId = getSessionId();
    if (!parentSessionId || !value || typeof value !== "object") return;
    const payload = value as {
      id?: string | null;
      runId?: string | null;
      results?: Array<{ runId?: string; id?: string }>;
    };
    const ids = new Set<string>();
    if (payload.id) ids.add(payload.id);
    if (payload.runId) ids.add(payload.runId);
    for (const result of payload.results ?? []) {
      if (result.runId) ids.add(result.runId);
      if (result.id) ids.add(result.id);
    }
    for (const id of ids) {
      modalJobManager.reattributeSubagentJobs(projectId, id, parentSessionId);
    }
  };
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (event.toolName === "subagent") reconcile(event.details);
    });
    pi.events.on("subagent:async-complete", reconcile);
  };
}
