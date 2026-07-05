"use client";

/**
 * Sub-agent settings API client. Agents are per active project (apiFetch
 * scopes by X-Project-Id) and live in the project's sandbox/.pi/agents/*.md.
 * "builtin" agents ship inside the pi-subagents package and are read-only;
 * saving a project agent with the same name customizes (shadows) the builtin.
 */

import { apiFetch } from "@/lib/projects";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface AgentFile {
  name: string;
  description: string;
  source: "project" | "builtin";
  enabled?: boolean;
  model?: string;
  thinking?: string;
  tools?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  /** Frontmatter keys the UI doesn't model; preserved on save. */
  extra?: Record<string, string>;
  systemPrompt: string;
}

export type AgentPatch = Omit<AgentFile, "name" | "source">;

export async function getAgents(): Promise<AgentFile[]> {
  const res = await apiFetch("/agents");
  if (!res.ok) throw new Error(`getAgents ${res.status}`);
  const data = (await res.json()) as { agents?: AgentFile[] };
  return data.agents ?? [];
}

export async function saveAgent(name: string, patch: AgentPatch): Promise<AgentFile> {
  const res = await apiFetch(`/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => null)) as
    | { agent?: AgentFile; detail?: string }
    | null;
  if (!res.ok || !data?.agent) {
    throw new Error(data?.detail || `saveAgent ${res.status}`);
  }
  return data.agent;
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await apiFetch(`/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `deleteAgent ${res.status}`);
  }
}

export async function restoreDefaultAgents(): Promise<string[]> {
  const res = await apiFetch("/agents/restore-defaults", { method: "POST" });
  const data = (await res.json().catch(() => null)) as
    | { restored?: string[]; detail?: string }
    | null;
  if (!res.ok) throw new Error(data?.detail || `restoreDefaultAgents ${res.status}`);
  return data?.restored ?? [];
}

export async function setAgentEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/agents/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setAgentEnabled ${res.status}`);
  }
}
