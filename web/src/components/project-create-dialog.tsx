"use client";

/**
 * "New project" dialog shared by the project switcher and the Projects view.
 * Editing an existing project happens in Settings → Project instead.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Project } from "@/lib/projects";
import { useProjects } from "@/lib/use-projects";

interface FormState {
  name: string;
  description: string;
  tags: string;
  /** Empty string = no limit. */
  spendLimit: string;
}

const EMPTY: FormState = { name: "", description: "", tags: "", spendLimit: "" };

export function ProjectCreateDialog({
  open,
  onOpenChange,
  initialName = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  onCreated: (project: Project) => void;
}) {
  const { create } = useProjects();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, name: initialName });
      setError(null);
    }
  }, [initialName, open]);

  const close = () => {
    if (!submitting) onOpenChange(false);
  };

  const submit = async () => {
    setError(null);
    const name = form.name.trim();
    if (!name) {
      setError("Name is required");
      return;
    }
    const trimmedLimit = form.spendLimit.trim();
    let spendLimitUsd: number | null = null;
    if (trimmedLimit !== "") {
      const parsed = Number(trimmedLimit);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Spend limit must be a non-negative number (or empty)");
        return;
      }
      spendLimitUsd = parsed;
    }
    setSubmitting(true);
    try {
      const project = await create({
        name,
        description: form.description.trim(),
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        spendLimitUsd,
      });
      onOpenChange(false);
      onCreated(project);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Each project has its own sandbox, chat history and settings. You can change everything
            later in Settings → Project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Name
            <Input
              autoFocus
              aria-invalid={Boolean(error && !form.name.trim())}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="RNA-seq pilot"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Description
            <Textarea
              rows={3}
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="Optional one-line summary."
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Tags <span className="opacity-60">(comma separated)</span>
            <Input
              value={form.tags}
              onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))}
              placeholder="genomics, proteomics"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Spend limit <span className="opacity-60">(USD, optional)</span>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={form.spendLimit}
              onChange={(event) => setForm((current) => ({ ...current, spendLimit: event.target.value }))}
              placeholder="Leave empty for no limit"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Spinner data-icon="inline-start" />}
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
