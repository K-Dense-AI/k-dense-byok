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
 * Full YAML parsing preserves nested objects, arrays, booleans and numbers in
 * unknown fields via `extra`. The UI edits modeled fields without flattening
 * external runners, permission rules, or future plugin settings.
 */
import fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import { seedSubagentResources } from "./subagent-resources.ts";
import { SUBAGENT_TYPES } from "./subagents.ts";
import { piSettingsPath, readPiSettings, writePiSettings, type ToggleResult } from "./capability-state.ts";

const require_ = createRequire(import.meta.url);

/**
 * Root directory of the installed pi-subagents package. The package's exports
 * map no longer exposes ./package.json (0.42+), so locate the root by walking
 * up from the resolved main entry.
 */
export function subagentsPackageDir(): string {
  const entry = require_.resolve("pi-subagents");
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("pi-subagents package.json not found");
    dir = parent;
  }
  return dir;
}

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Names taken by static `/agents/<name>` routes (`GET/PUT /agents/defaults`). */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["defaults"]);
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
  /**
   * pi-subagents per-agent persistent memory: `<project>/.pi/agent-memory/<path>/MEMORY.md`
   * (scope project) or `~/.kady/pi-agent/agent-memory/<path>/MEMORY.md` (scope user),
   * injected into the child's system prompt and appendable by agents with write tools.
   */
  memory?: AgentMemory;
  /** Frontmatter keys we don't model, preserved verbatim on round-trip. */
  extra?: Record<string, unknown>;
  systemPrompt: string;
}

export interface AgentMemory {
  scope: "project" | "user";
  /** Directory name under agent-memory/; usually the agent name. */
  path: string;
}

/** Editable fields accepted from the API (everything but name/source). */
export type AgentFilePatch = Omit<AgentFile, "name" | "source">;

export const MEMORY_PATH_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Accept either YAML form without flattening nested frontmatter. */
export function parseAgentMemory(value: unknown): AgentMemory | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try { value = parseYaml(value, { maxAliasCount: 50 }); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { scope, path: memoryPath } = value as Record<string, unknown>;
  if ((scope !== "project" && scope !== "user") || typeof memoryPath !== "string" || !MEMORY_PATH_RE.test(memoryPath)) return undefined;
  return { scope, path: memoryPath };
}

export function serializeAgentMemory(memory: AgentMemory): string {
  return `{ scope: ${memory.scope}, path: ${memory.path} }`;
}

/** Absolute MEMORY.md path for an agent's memory scope. */
export function agentMemoryFile(paths: ProjectPaths, memory: AgentMemory): string {
  const root =
    memory.scope === "user"
      ? path.join(KADY_PI_AGENT_DIR, "agent-memory")
      : path.join(paths.sandbox, ".pi", "agent-memory");
  return path.join(root, memory.path, "MEMORY.md");
}

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

/**
 * Models pinned in `.pi/settings.json` under `subagents`, which frontmatter
 * alone does not reveal. pi-subagents resolves a child model strongest-first:
 * per-run override → `agentOverrides.<name>.model` (applied over the
 * definition) → agent frontmatter → `subagents.defaultModel` → the parent
 * session model. Anything we send as a
 * per-run override therefore outranks all of these, so the caller needs to see
 * them before deciding to pin one.
 */
export function settingsPinnedModels(paths: ProjectPaths): {
  defaultModel?: string;
  byAgent: Map<string, string>;
} {
  const sub = (readPiSettings(paths).subagents ?? {}) as Record<string, unknown>;
  const overrides =
    sub.agentOverrides && typeof sub.agentOverrides === "object" && !Array.isArray(sub.agentOverrides)
      ? (sub.agentOverrides as Record<string, { model?: unknown }>)
      : {};
  const byAgent = new Map<string, string>();
  for (const [name, override] of Object.entries(overrides)) {
    if (typeof override?.model === "string" && override.model.trim()) {
      byAgent.set(name, override.model.trim());
    }
  }
  const fallback = typeof sub.defaultModel === "string" ? sub.defaultModel.trim() : "";
  return { ...(fallback ? { defaultModel: fallback } : {}), byAgent };
}

/**
 * Set or clear `subagents.defaultModel` — the model every specialist without
 * its own frontmatter or `agentOverrides` model runs on — preserving all other
 * settings keys. `null` or an empty value deletes the key, since pi-subagents
 * rejects an empty string. Returns false, leaving the file untouched, when
 * settings.json is malformed: rewriting it from `{}` would destroy it.
 * Callers validate the ref (`invalidModelRef`).
 */
export function setSubagentDefaultModel(paths: ProjectPaths, model: string | null): boolean {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    settings = parsed as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
    settings = {};
  }
  const sub =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
      ? { ...(settings.subagents as Record<string, unknown>) }
      : {};
  const next = model?.trim() ?? "";
  if (next) sub.defaultModel = next;
  else if ("defaultModel" in sub) delete sub.defaultModel;
  else return true; // nothing to clear; don't create the file just to say so
  writePiSettings(paths, { ...settings, subagents: sub });
  return true;
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

/** Roster names already offered to this project, so later additions seed once. */
function seededNamesPath(paths: ProjectPaths): string {
  return path.join(agentsDir(paths), ".seeded-names.json");
}

/**
 * The roster a `.seeded` marker without a names file stands for: everything
 * shipped before per-name tracking. Never extend this list; new specialists
 * are seeded into existing projects because they are missing from it.
 */
const LEGACY_SEEDED_ROSTER: readonly string[] = [
  "code-reviewer", "statistical-reviewer", "math-checker", "ml-auditor", "data-validator",
  "reproducibility-auditor", "pipeline-engineer", "data-visualizer", "simulation-reviewer",
  "literature-researcher", "citation-checker", "fact-checker", "methodology-reviewer",
  "peer-reviewer", "hypothesis-generator", "experiment-designer", "protocol-writer",
  "results-interpreter", "manuscript-editor", "abstract-writer", "ethics-reviewer",
];

function readSeededNames(paths: ProjectPaths): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(seededNamesPath(paths), "utf-8"));
    if (Array.isArray(parsed)) return new Set(parsed.filter((name): name is string => typeof name === "string"));
  } catch {
    /* missing or malformed: the legacy roster */
  }
  return new Set(LEGACY_SEEDED_ROSTER);
}

function writeSeededNames(paths: ProjectPaths, names: Iterable<string>): void {
  fs.writeFileSync(seededNamesPath(paths), JSON.stringify([...new Set(names)].sort()) + "\n", "utf-8");
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
  "memory",
]);

export function parseAgentMarkdown(
  text: string,
  fallbackName: string,
  source: AgentFile["source"],
): AgentFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const parsed: unknown = m ? parseYaml(m[1], { maxAliasCount: 50 }) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent frontmatter must be a mapping");
  const fm = parsed as Record<string, unknown>;
  const body = m ? m[2] : text;
  const scalar = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
  const bool = (v: unknown) => typeof v === "boolean" ? v : undefined;
  const extra = Object.fromEntries(Object.entries(fm).filter(([k]) => !KNOWN_KEYS.has(k)));
  const mode = fm.systemPromptMode;
  return {
    name: scalar(fm.name) || fallbackName,
    description: scalar(fm.description) ?? "",
    source,
    model: scalar(fm.model),
    thinking: scalar(fm.thinking),
    tools: Array.isArray(fm.tools) ? fm.tools.join(", ") : scalar(fm.tools),
    systemPromptMode: mode === "append" || mode === "replace" ? mode : undefined,
    inheritProjectContext: bool(fm.inheritProjectContext),
    inheritSkills: bool(fm.inheritSkills),
    memory: parseAgentMemory(fm.memory),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    systemPrompt: body.trim(),
  };
}

export function serializeAgentMarkdown(agent: Omit<AgentFile, "source">): string {
  const fm: Record<string, unknown> = { ...agent.extra, name: agent.name, description: agent.description };
  for (const key of KNOWN_KEYS) {
    if (key === "name" || key === "description") continue;
    const value = agent[key as keyof typeof agent];
    if (value !== undefined && value !== "") fm[key] = value;
    else delete fm[key];
  }
  return `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n\n${agent.systemPrompt.trim()}\n`;

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

/**
 * True for a builtin that drives an external coding CLI (Claude Code, Codex,
 * Cursor Agent; pi-subagents ≥0.57) instead of a Pi session. Its frontmatter
 * carries a nested `runner:` block whose `type` is `external-cli`; our YAML
 * subset flattens that block, so both keys land in `extra`.
 */
export function isExternalCliAgent(agent: Pick<AgentFile, "extra">): boolean {
  const runner = agent.extra?.runner;
  return Boolean(runner && typeof runner === "object" && (runner as Record<string, unknown>).type === "external-cli");
}

/** Agents bundled inside the pi-subagents package (read-only). */
export function listBuiltinAgents(): AgentFile[] {
  try {
    const dir = path.join(subagentsPackageDir(), "agents");
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
  if (RESERVED_AGENT_NAMES.has(name)) {
    throw new Error(`"${name}" is reserved; choose another agent name`);
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
 * Seed the scientific roster into a project: everything on first use, and a
 * specialist added to the roster later exactly once (tracked by name). Agents
 * the user deleted in the UI stay deleted, and an existing or disabled file of
 * the same name is never overwritten. Returns the number of files written.
 */
export function seedAgentFiles(paths: ProjectPaths): number {
  seedSubagentResources(paths);
  const dir = agentsDir(paths);
  const initial = !fs.existsSync(seedMarkerPath(paths));
  const offered = initial ? new Set<string>() : readSeededNames(paths);
  const pending = SUBAGENT_TYPES.filter((type) => !offered.has(type.name));
  if (!initial && pending.length === 0) return 0;
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const type of pending) {
    const file = path.join(dir, `${type.name}.md`);
    if (fs.existsSync(file) || (!initial && fs.existsSync(path.join(agentsDisabledDir(paths), `${type.name}.md`)))) continue;
    fs.writeFileSync(file, rosterMarkdown(type), "utf-8");
    written++;
  }
  if (initial) fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  writeSeededNames(paths, [...offered, ...SUBAGENT_TYPES.map((type) => type.name)]);
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
    const enabledCopy = path.join(dir, `${type.name}.md`);
    // Persistent memory is the user's choice, not part of the shipped prompt:
    // carry it over when the roster text is rewritten.
    const existing =
      readAgentFile(enabledCopy, "project") ??
      (fs.existsSync(disabledCopy) ? readAgentFile(disabledCopy, "project") : null);
    if (fs.existsSync(disabledCopy)) fs.rmSync(disabledCopy);
    const markdown = existing?.memory
      ? serializeAgentMarkdown({ ...parseAgentMarkdown(rosterMarkdown(type), type.name, "project"), memory: existing.memory })
      : rosterMarkdown(type);
    fs.writeFileSync(enabledCopy, markdown, "utf-8");
  }
  fs.writeFileSync(seedMarkerPath(paths), new Date().toISOString() + "\n", "utf-8");
  writeSeededNames(paths, [...readSeededNames(paths), ...SUBAGENT_TYPES.map((t) => t.name)]);
  return SUBAGENT_TYPES.map((t) => t.name);
}
