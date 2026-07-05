"use client";

/**
 * Skills capability client for the Customize hub. Skills are per active project
 * (apiFetch scopes by X-Project-Id); enabling/disabling relocates the skill on
 * disk server-side so it (dis)appears from agent discovery on the next session.
 */
import { apiFetch } from "@/lib/projects";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

export interface SkillsListing {
  enabled: SkillInfo[];
  disabled: SkillInfo[];
}

export async function getAllSkills(): Promise<SkillsListing> {
  const res = await apiFetch("/skills/all");
  if (!res.ok) throw new Error(`getAllSkills ${res.status}`);
  const data = (await res.json()) as Partial<SkillsListing>;
  return { enabled: data.enabled ?? [], disabled: data.disabled ?? [] };
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await apiFetch(`/skills/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `setSkillEnabled ${res.status}`);
  }
}

export async function getSkillSource(name: string): Promise<string> {
  const res = await apiFetch(`/skills/${encodeURIComponent(name)}/source`);
  if (!res.ok) throw new Error(`getSkillSource ${res.status}`);
  const data = (await res.json()) as { content: string };
  return data.content;
}
