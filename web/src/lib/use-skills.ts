"use client";

import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/api-base";

export interface Skill {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  compatibility: string;
}

export function useSkills(): { skills: Skill[]; loading: boolean } {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBaseUrl()}/skills`)
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
  }, []);

  return { skills, loading };
}
