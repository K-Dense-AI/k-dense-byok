"use client";

import { useCallback, useEffect, useState } from "react";

import { listPromptTemplates, type PromptTemplateInfo } from "@/lib/capabilities";
import { useProjectScopeId } from "@/lib/projects";

/** Merged prompt templates (project wins) for the composer's `/` menu. */
export function usePromptTemplates(projectId?: string): {
  templates: PromptTemplateInfo[];
  loading: boolean;
  refresh: () => void;
} {
  const contextProjectId = useProjectScopeId();
  const scopedProjectId = projectId ?? contextProjectId;
  const [templates, setTemplates] = useState<PromptTemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPromptTemplates()
      .then((data) => {
        if (!cancelled) setTemplates(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopedProjectId, revision]);

  return { templates, loading, refresh };
}
