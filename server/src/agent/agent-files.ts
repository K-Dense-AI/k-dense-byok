/**
 * Sub-agent definition files: parse, serialize, and CRUD.
 *
 * pi-subagents discovers project agents as markdown files with YAML-ish
 * frontmatter under `sandbox/.pi/agents/*.md`. This module is the single
 * owner of that directory:
 *   - the seeding path (scientific roster from subagents.ts, marker-gated so
 *     user deletions stick),
 *   - the settings API's list/save/delete/restore operations,
 *   - read-only access to the agents bundled inside the pi-subagents package.
 *
 * The frontmatter parser is a deliberate subset of YAML (flat `key: value`
 * lines, optional quotes, true/false booleans) matching how the package's own
 * agent files are authored. Unknown keys round-trip untouched via `extra` so
 * editing an agent in the UI never drops fields we don't model (defaultReads,
 * maxTokens, ...).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { SUBAGENT_TYPES } from "./subagents.ts";
import { readPiSettings, writePiSettings, type ToggleResult } from "./capability-state.ts";

const require_ = createRequire(import.meta.url);

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface AgentFile {
  name: string;
  description: string;
  /** Where the definition lives. Only "project" agents are editable. */
  source: "project" | "builtin";
  /** Whether this agent is active for new sessions (hub toggle). */
  enabled?: boolean;
  model?: string;
  thinking?: string;
  /** Comma-separated tool allowlist, as authored (e.g. "read, grep, bash"). */
  tools?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  /** Frontmatter keys we don't model, preserved verbatim on round-trip. */
  extra?: Record<string, string>;
  systemPrompt: string;
}

/** Editable fields accepted from the API (everything but name/source). */
export type AgentFilePatch = Omit<AgentFile, "name" | "source">;

function agentsDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "agents");
}

export function agentsDisabledDir(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "agents-disabled");
}

/** Project agents parked in the disabled store (source "project"). */
export function listDisabledProjectAgents(paths: ProjectPaths): AgentFile[] {
  const dir = agentsDisabledDir(paths);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => readAgentFile(path.join(dir, f), "project"))
    .filter((a): a is AgentFile => a !== null);
}

/** Builtin names that are disabled via .pi/settings.json (subagents.*). */
export function builtinDisabledNames(paths: ProjectPaths): Set<string> {
  const settings = readPiSettings(paths);
  const sub = (settings.subagents ?? {}) as Record<string, unknown>;
  const bulk = sub.disableBuiltins === true;
  const overrides = (sub.agentOverrides ?? {}) as Record<string, { disabled?: boolean }>;
  const out = new Set<string>();
  for (const b of listBuiltinAgents()) {
    const ov = overrides[b.name];
    const disabled = ov?.disabled === true || (bulk && ov?.disabled !== false);
    if (disabled) out.add(b.name);
  }
  return out;
}

/** Set/clear a builtin's disabled override, preserving all other settings keys. */
export function setBuiltinDisabled(paths: ProjectPaths, name: string, disabled: boolean): void {
  const settings = readPiSettings(paths);
  const sub =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
      ? { ...(settings.subagents as Record<string, unknown>) }
      : {};
  const overrides =
    sub.agentOverrides && typeof sub.agentOverrides === "object" && !Array.isArray(sub.agentOverrides)
      ? { ...(sub.agentOverrides as Record<string, unknown>) }
      : {};
  overrides[name] = { ...((overrides[name] as Record<string, unknown>) ?? {}), disabled };
  sub.agentOverrides = overrides;
  settings.subagents = sub;
  writePiSettings(paths, settings);
}

/** Marker that initial seeding ran; its presence makes user deletions stick. */
function seedMarkerPath(paths: ProjectPaths): string {
  return path.join(agentsDir(paths), ".seeded");
}

// --- frontmatter (YAML subset) --------------------------------------------

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "model",
  "thinking",
  "tools",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
]);

function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    try {
      if (v.startsWith('"')) return JSON.parse(v) as string;
    } catch {
      /* fall through to manual strip */
    }
    return v.slice(1, -1);
  }
  return v;
}

export function parseAgentMarkdown(
  text: string,
  fallbackName: string,
  source: AgentFile["source"],
): AgentFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fm: Record<string, string> = {};
  let body = text;
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) continue;
      fm[trimmed.slice(0, idx).trim()] = unquote(trimmed.slice(idx + 1));
    }
  }
  const bool = (v: string | undefined) => (v === undefined ? undefined : v === "true");
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }
  const mode = fm.systemPromptMode;
  return {
    name: fm.name || fallbackName,
    description: fm.description ?? "",
    source,
    model: fm.model || undefined,
    thinking: fm.thinking || undefined,
    tools: fm.tools || undefined,
    systemPromptMode: mode === "append" || mode === "replace" ? mode : undefined,
    inheritProjectContext: bool(fm.inheritProjectContext),
    inheritSkills: bool(fm.inheritSkills),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    systemPrompt: body.trim(),
  };
}

/** YAML-safe single-line scalar (descriptions often contain colons). */
function yamlQuote(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, " ").trim());
}

export function serializeAgentMarkdown(agent: Omit<AgentFile, "source">): string {
  const lines = ["---", `name: ${agent.name}`, `description: ${yamlQuote(agent.description)}`];
  if (agent.model) lines.push(`model: ${agent.model}`);
  if (agent.thinking) lines.push(`thinking: ${agent.thinking}`);
  if (agent.tools) lines.push(`tools: ${agent.tools}`);
  if (agent.systemPromptMode) lines.push(`systemPromptMode: ${agent.systemPromptMode}`);
  if (agent.inheritProjectContext !== undefined) {
    lines.push(`inheritProjectContext: ${agent.inheritProjectContext}`);
  }
  if (agent.inheritSkills !== undefined) lines.push(`inheritSkills: ${agent.inheritSkills}`);
  for (const [k, v] of Object.entries(agent.extra ?? {})) lines.push(`${k}: ${v}`);
  lines.push("---", "", agent.systemPrompt.trim(), "");
  return lines.join("\n");
}

// --- listing ---------------------------------------------------------------

function readAgentFile(file: string, source: AgentFile["source"]): AgentFile | null {
  try {
    const text = fs.readFileSync(file, "utf-8");
    return parseAgentMarkdown(text, path.basename(file, ".md"), source);
  } catch {
    return null;
  }
}

export function listProjectAgents(paths: ProjectPaths): AgentFile[] {
  const dir = agentsDir(paths);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => readAgentFile(path.join(dir, f), "project"))
    .filter((a): a is AgentFile => a !== null);
}

/** Agents bundled inside the pi-subagents package (read-only). */
export function listBuiltinAgents(): AgentFile[] {
  try {
    const pkgDir = path.dirname(require_.resolve("pi-subagents/package.json"));
    const dir = path.join(pkgDir, "agents");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readAgentFile(path.join(dir, f), "builtin"))
      .filter((a): a is AgentFile => a !== null);
  } catch {
    return [];
  }
}

/**
 * Full roster for the UI: project agents (enabled + disabled) plus builtins
 * that aren't shadowed by a project agent of the same name (project
 * definitions win in pi-subagents' discovery order). Every entry has
 * `enabled` set.
 */
export function listAgents(paths: ProjectPaths): AgentFile[] {
  const enabledProject = listProjectAgents(paths).map((a) => ({ ...a, enabled: true }));
  const enabledNames = new Set(enabledProject.map((a) => a.name));
  const disabledProject = listDisabledProjectAgents(paths)
    .filter((a) => !enabledNames.has(a.name))
    .map((a) => ({ ...a, enabled: false }));
  const projectNames = new Set([...enabledProject, ...disabledProject].map((a) => a.name));
  const disabledBuiltins = builtinDisabledNames(paths);
  const builtins = listBuiltinAgents()
    .filter((a) => !projectNames.has(a.name))
    .map((a) => ({ ...a, enabled: !disabledBuiltins.has(a.name) }));
  return [...enabledProject, ...disabledProject, ...builtins];
}

// --- mutations ---------------------------------------------------------------

export function writeProjectAgent(
  paths: ProjectPaths,
  name: string,
  patch: AgentFilePatch,
): AgentFile {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name "${name}" (lowercase letters, digits, - and _)`);
  }
  if (!patch.systemPrompt?.trim()) throw new Error("System prompt must not be empty");
  if (patch.thinking && !THINKING_LEVELS.includes(patch.thinking as never)) {
    throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const agent: AgentFile = { ...patch, name, source: "project" };
  const enabledFile = path.join(agentsDir(paths), `${name}.md`);
  const disabledFile = path.join(agentsDisabledDir(paths), `${name}.md`);
  // Preserve disabled state when editing an agent that currently lives in the
  // disabled store; otherwise (new agent, or an enabled one) write to agents/.
  const target =
    !fs.existsSync(enabledFile) && fs.existsSync(disabledFile) ? disabledFile : enabledFile;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeAgentMarkdown(agent), "utf-8");
  return agent;
}

export function deleteProjectAgent(paths: ProjectPaths, name: string): boolean {
  if (!AGENT_NAME_RE.test(name)) return false;
  let removed = false;
  for (const f of [
    path.join(agentsDir(paths), `${name}.md`),
    path.join(agentsDisabledDir(paths), `${name}.md`),
  ]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      removed = true;
    }
  }
  return removed;
}

/**
 * Enable/disable a specialist for new sessions.
 *  - Project agent: relocate its .md between agents/ and agents-disabled/.
 *  - Builtin (pi-subagents package): set subagents.agentOverrides.<name>.disabled.
 * A name that shadows a builtin sets both, so runtime discovery stays consistent.
 */
export function setSpecialistEnabled(
  paths: ProjectPaths,
  name: string,
  enabled: boolean,
): ToggleResult {
  if (!AGENT_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: `Invalid agent name "${name}"` };
  }
  const projFile = path.join(agentsDir(paths), `${name}.md`);
  const disFile = path.join(agentsDisabledDir(paths), `${name}.md`);
  const isProject = fs.existsSync(projFile) || fs.existsSync(disFile);
  const isBuiltin = listBuiltinAgents().some((b) => b.name === name);
  if (!isProject && !isBuiltin) {
    return { ok: false, status: 404, detail: `No such specialist: ${name}` };
  }

  if (enabled) {
    if (fs.existsSync(disFile)) {
      if (fs.existsSync(projFile)) {
        return { ok: false, status: 409, detail: `"${name}" already has an enabled definition` };
      }
      fs.mkdirSync(agentsDir(paths), { recursive: true });
      fs.renameSync(disFile, projFile);
    }
    if (isBuiltin) setBuiltinDisabled(paths, name, false);
  } else {
    if (fs.existsSync(projFile)) {
      if (fs.existsSync(disFile)) {
        return { ok: false, status: 409, detail: `"${name}" already has a disabled definition` };
      }
      fs.mkdirSync(agentsDisabledDir(paths), { recursive: true });
      fs.renameSync(projFile, disFile);
    }
    if (isBuiltin) setBuiltinDisabled(paths, name, true);
  }
  return { ok: true };
}

// --- seeding ------------------------------------------------------------------

function rosterMarkdown(type: (typeof SUBAGENT_TYPES)[number]): string {
  return serializeAgentMarkdown({
    name: type.name,
    description: type.summary,
    systemPromptMode: "append",
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: type.systemPrompt,
  });
}

/**
 * One-time seeding of the scientific roster into a project. Gated by a marker
 * file so agents the user deleted in the UI stay deleted. Returns the number
 * of files written.
 */
export function seedAgentFiles(paths: ProjectPaths): number {
  const dir = agentsDir(paths);
  if (fs.existsSync(seedMarkerPath(paths))) return 0;
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const type of SUBAGENT_TYPES) {
    const file = path.join(dir, `${type.name}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, rosterMarkdown(type), "utf-8");
    written++;
  }
  fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  return written;
}

/**
 * Restore the default scientific agents, overwriting same-named files (the
 * Settings panel's "Restore defaults" action). User-created agents with other
 * names are untouched. Returns the restored names.
 */
export function restoreDefaultAgents(paths: ProjectPaths): string[] {
  const dir = agentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  for (const type of SUBAGENT_TYPES) {
    const disabledCopy = path.join(agentsDisabledDir(paths), `${type.name}.md`);
    if (fs.existsSync(disabledCopy)) fs.rmSync(disabledCopy);
    fs.writeFileSync(path.join(dir, `${type.name}.md`), rosterMarkdown(type), "utf-8");
  }
  fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  return SUBAGENT_TYPES.map((t) => t.name);
}
