"use client";

import { useEffect, useState } from "react";

import { apiFetch, onProjectChange } from "@/lib/projects";

export interface Skill {
  id: string;
  name: string;
  description: string;
  // Optional: the backend's /skills response only includes id/name/description.
  author?: string;
  license?: string;
  compatibility?: string;
}

export function useSkills(): { skills: Skill[]; loading: boolean } {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => onProjectChange(() => setReloadKey((v) => v + 1)), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/skills`)
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
  }, [reloadKey]);

  return { skills, loading };
}
