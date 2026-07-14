"use client";

import { useEffect, useState } from "react";

import { apiFetch, useProjectScopeId } from "@/lib/projects";

export interface Skill {
  id: string;
  name: string;
  description: string;
  // Optional: the backend's /skills response only includes id/name/description.
  author?: string;
  license?: string;
  compatibility?: string;
}

export function useSkills(projectId?: string): { skills: Skill[]; loading: boolean } {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/skills`, {}, scopedProjectId)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) {
          setSkills(data);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopedProjectId]);

  return { skills, loading };
}
