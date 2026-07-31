"use client";

/**
 * Skills capability client for the Settings hub.
 *
 * Two dimensions of scoping. Project scope is implicit — `apiFetch` sends
 * `X-Project-Id`. Skill scope is explicit: `project` (this project's sandbox) or
 * `global` (the user-level Pi agent dir, shared by every project and inherited
 * by subagent child processes). Enabling/disabling relocates the skill on disk
 * server-side so it (dis)appears from agent discovery on the next session.
 */
import { apiFetch } from "@/lib/projects";

export type SkillScope = "project" | "global";

/** Where a skill came from, which decides what "update" means for it. */
export type SkillOrigin = "catalogue" | "registry" | "local";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  origin?: SkillOrigin;
  /** Recorded source for a skill installed from somewhere other than the catalogue. */
  source?: string;
  ref?: string;
}

/**
 * A SKILL.md the loader complained about. `loaded: false` means it is installed
 * but unparseable, so it appears in neither list here nor to the agent.
 */
export interface SkillProblem {
  name: string;
  state: "enabled" | "disabled";
  loaded: boolean;
  message: string;
}

export interface SkillSyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  preserved: number;
  archived: number;
}

export interface SkillSyncStatus {
  repo: string;
  branch: string;
  upstreamCommit: string | null;
  catalogueDigest: string | null;
  lastCheckedAt: string | null;
  updatesAvailable: string[];
  customized: string[];
  orphaned: string[];
  archived: string[];
  removed: string[];
  lastResult: SkillSyncCounts | null;
  syncing: boolean;
}

export interface SkillsListing {
  scope: SkillScope;
  enabled: SkillInfo[];
  disabled: SkillInfo[];
  problems: SkillProblem[];
  /**
   * Names also installed in the other scope. Pi resolves project skills first
   * and skill-name collisions are first-wins, so a project skill wins over a
   * global one — worth saying out loud, since the loser is simply inert.
   */
  shadowed: string[];
  sync?: SkillSyncStatus;
}

export const EMPTY_SKILL_SYNC_STATUS: SkillSyncStatus = {
  repo: "K-Dense-AI/scientific-agent-skills",
  branch: "main",
  upstreamCommit: null,
  catalogueDigest: null,
  lastCheckedAt: null,
  updatesAvailable: [],
  customized: [],
  orphaned: [],
  archived: [],
  removed: [],
  lastResult: null,
  syncing: false,
};

function scopeQuery(scope: SkillScope | undefined, separator = "?"): string {
  return scope === "global" ? `${separator}scope=global` : "";
}

/** Read `detail` from an error response, falling back to a status message. */
async function failure(res: Response, label: string): Promise<Error> {
  const data = (await res.json().catch(() => null)) as { detail?: string } | null;
  return new Error(data?.detail || `${label} ${res.status}`);
}

export async function getAllSkills(scope?: SkillScope): Promise<SkillsListing> {
  const res = await apiFetch(`/skills/all${scopeQuery(scope)}`);
  if (!res.ok) throw new Error(`getAllSkills ${res.status}`);
  const data = (await res.json()) as Partial<SkillsListing>;
  return {
    scope: data.scope ?? scope ?? "project",
    enabled: data.enabled ?? [],
    disabled: data.disabled ?? [],
    problems: data.problems ?? [],
    shadowed: data.shadowed ?? [],
    sync: data.sync ?? EMPTY_SKILL_SYNC_STATUS,
  };
}

export async function syncSkills(): Promise<void> {
  const res = await apiFetch("/skills/sync", { method: "POST" });
  if (!res.ok) throw await failure(res, "syncSkills");
}

export async function updateSkillFromUpstream(
  name: string,
  scope?: SkillScope,
): Promise<void> {
  const res = await apiFetch(
    `/skills/${encodeURIComponent(name)}/update${scopeQuery(scope)}`,
    { method: "POST" },
  );
  if (!res.ok) throw await failure(res, "updateSkillFromUpstream");
}

export interface SkillUpdateCheck {
  name: string;
  updateAvailable: boolean;
}

export async function checkSkillUpdate(
  name: string,
  scope?: SkillScope,
): Promise<SkillUpdateCheck> {
  const res = await apiFetch(
    `/skills/${encodeURIComponent(name)}/check-update${scopeQuery(scope)}`,
    { method: "POST" },
  );
  if (!res.ok) throw await failure(res, "checkSkillUpdate");
  return (await res.json()) as SkillUpdateCheck;
}

export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  scope?: SkillScope,
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(
    `/skills/${encodeURIComponent(name)}/${action}${scopeQuery(scope)}`,
    { method: "POST" },
  );
  if (!res.ok) throw await failure(res, "setSkillEnabled");
}

export async function getSkillSource(name: string, scope?: SkillScope): Promise<string> {
  const res = await apiFetch(
    `/skills/${encodeURIComponent(name)}/source${scopeQuery(scope)}`,
  );
  if (!res.ok) throw new Error(`getSkillSource ${res.status}`);
  const data = (await res.json()) as { content: string };
  return data.content;
}

export async function saveSkillSource(
  name: string,
  content: string,
  scope?: SkillScope,
): Promise<void> {
  const res = await apiFetch(
    `/skills/${encodeURIComponent(name)}/source${scopeQuery(scope)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) throw await failure(res, "saveSkillSource");
}

export interface SkillRemoval {
  name: string;
  disposition: "archived" | "deleted";
}

export async function removeSkill(
  name: string,
  scope?: SkillScope,
): Promise<SkillRemoval> {
  const res = await apiFetch(`/skills/${encodeURIComponent(name)}${scopeQuery(scope)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await failure(res, "removeSkill");
  return (await res.json()) as SkillRemoval;
}

export async function createSkill(input: {
  name: string;
  description?: string;
  scope?: SkillScope;
}): Promise<{ name: string }> {
  const res = await apiFetch("/skills/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "createSkill");
  return (await res.json()) as { name: string };
}

export interface PreviewedSkill {
  name: string;
  description: string;
  files: number;
  source?: string;
  installed: boolean;
  conflictsWith?: SkillScope;
}

export interface SkillSourcePreview {
  source: string;
  ref?: string;
  stagingKey: string;
  /** Echoed back on install so the user gets exactly the skills they reviewed. */
  stagingToken: string;
  skills: PreviewedSkill[];
  problems: { name: string; message: string }[];
}

export async function previewSkillSource(input: {
  source: string;
  ref?: string;
  scope?: SkillScope;
}): Promise<SkillSourcePreview> {
  const res = await apiFetch("/skills/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "previewSkillSource");
  return (await res.json()) as SkillSourcePreview;
}

export async function installSkills(input: {
  source: string;
  ref?: string;
  names: string[];
  scope?: SkillScope;
  stagingToken?: string;
  replace?: boolean;
  /** Required: the server rejects an install that has not been acknowledged. */
  acknowledged: boolean;
}): Promise<{ installed: string[]; conflicts: string[] }> {
  const res = await apiFetch("/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "installSkills");
  return (await res.json()) as { installed: string[]; conflicts: string[] };
}
