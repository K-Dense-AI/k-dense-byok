"use client";

/**
 * Settings → Prompt templates.
 *
 * Markdown files that expand from `/name args` in the composer. Two scopes,
 * like skills: this project's sandbox or the user-level dir shared by every
 * project (a project template of the same name wins).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplateSource,
  listPromptTemplates,
  restoreDefaultPromptTemplates,
  savePromptTemplateSource,
  type PromptScope,
  type PromptTemplateInfo,
} from "@/lib/capabilities";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";

type Pane = "none" | "create" | "edit";

export function PromptsPanel() {
  const { activeProjectId } = useProjects();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [scope, setScope] = useState<PromptScope>("project");
  const [rows, setRows] = useState<PromptTemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>("none");

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newHint, setNewHint] = useState("");

  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const load = useCallback(async (nextScope: PromptScope, showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setRows(await listPromptTemplates(nextScope));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load prompt templates");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope, activeProjectId]);

  const run = useCallback(
    async (key: string, work: () => Promise<string | void>) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const message = await work();
        if (message) setNotice(message);
        await load(scope, false);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Operation failed");
      } finally {
        setBusy(null);
      }
    },
    [load, scope],
  );

  const closePanes = useCallback(() => {
    setPane("none");
    setEditing(null);
    setEditContent("");
  }, []);

  const openEditor = useCallback(
    async (name: string) => {
      setPane("edit");
      setEditing(name);
      setEditLoading(true);
      try {
        setEditContent((await getPromptTemplateSource(name, scope)).content);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Failed to load template");
      } finally {
        setEditLoading(false);
      }
    },
    [scope],
  );

  const saveEditor = useCallback(async () => {
    if (!editing) return;
    await run("save", async () => {
      await savePromptTemplateSource(editing, scope, editContent);
      closePanes();
      return `Saved /${editing}.`;
    });
  }, [closePanes, editContent, editing, run, scope]);

  const doCreate = useCallback(async () => {
    const name = newName.trim().toLowerCase();
    if (!name) return;
    await run("create", async () => {
      const created = await createPromptTemplate(scope, {
        name,
        description: newDescription.trim() || undefined,
        argumentHint: newHint.trim() || undefined,
      });
      setNewName("");
      setNewDescription("");
      setNewHint("");
      setPane("edit");
      setEditing(created.name);
      setEditContent(created.content);
      return `Created /${created.name}. Edit the body below.`;
    });
  }, [newDescription, newHint, newName, run, scope]);

  const doRemove = useCallback(
    async (row: PromptTemplateInfo) => {
      const confirmed = await confirm({
        title: `Delete /${row.name}?`,
        description: row.seeded
          ? "This is one of Kady's shipped templates; Restore defaults brings it back."
          : "The template file is removed from disk.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
      await run(`remove:${row.name}`, async () => {
        await deletePromptTemplate(row.name, scope);
        if (editing === row.name) closePanes();
        return `Deleted /${row.name}.`;
      });
    },
    [closePanes, confirm, editing, run, scope],
  );

  const doRestore = useCallback(async () => {
    await run("restore", async () => {
      const restored = await restoreDefaultPromptTemplates();
      return `Restored ${restored} shipped template${restored === 1 ? "" : "s"}.`;
    });
  }, [run]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return rows;
    return rows.filter((r) => r.name.includes(q) || r.description.toLowerCase().includes(q));
  }, [query, rows]);

  return (
    <div className="flex flex-col gap-3">
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Template scope">
          {(["project", "global"] as PromptScope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className={cn(
                "rounded px-2 py-1",
                scope === s ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setScope(s);
                closePanes();
              }}
            >
              {s === "project" ? "This project" : "All projects"}
            </button>
          ))}
        </div>
        <Input
          value={query}
          placeholder="Filter templates…"
          className="h-8 w-48 text-xs"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter templates"
        />
        <div className="ml-auto flex items-center gap-1.5">
          {scope === "project" && (
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={busy === "restore"} onClick={() => void doRestore()}>
              {busy === "restore" ? <Loader2Icon className="size-3.5 animate-spin" /> : <RotateCcwIcon className="size-3.5" />}
              Restore defaults
            </Button>
          )}
          <Button type="button" size="sm" className="h-8 text-xs" onClick={() => setPane(pane === "create" ? "none" : "create")}>
            <PlusIcon className="size-3.5" />
            New template
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Type <code>/</code> in the chat to pick one; add arguments after the name (<code>/qc user_data/a.csv</code>).
        Use <code>$1</code>, <code>$2</code>… or <code>$ARGUMENTS</code> in the body.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      {pane === "create" && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="text-xs font-medium">New template ({scope === "project" ? "this project" : "all projects"})</div>
          <div className="flex flex-wrap gap-2">
            <Input value={newName} placeholder="name (lowercase, e.g. lit-scan)" className="h-8 w-48 font-mono text-xs" onChange={(e) => setNewName(e.target.value)} aria-label="Template name" />
            <Input value={newHint} placeholder="argument hint, e.g. <topic> [years]" className="h-8 w-56 font-mono text-xs" onChange={(e) => setNewHint(e.target.value)} aria-label="Argument hint" />
            <Input value={newDescription} placeholder="Short description shown in the menu" className="h-8 flex-1 text-xs" onChange={(e) => setNewDescription(e.target.value)} aria-label="Template description" />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" disabled={!newName.trim() || busy === "create"} onClick={() => void doCreate()}>
              {busy === "create" && <Loader2Icon className="size-3.5 animate-spin" />}
              Create and edit
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={closePanes}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {pane === "edit" && editing && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="text-xs font-medium">Editing /{editing}</div>
          {editLoading ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : (
            <Textarea
              value={editContent}
              spellCheck={false}
              className="min-h-56 font-mono text-[11px]"
              aria-label={`Template source for ${editing}`}
              onChange={(e) => setEditContent(e.target.value)}
            />
          )}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" disabled={busy === "save" || editLoading} onClick={() => void saveEditor()}>
              {busy === "save" && <Loader2Icon className="size-3.5 animate-spin" />}
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={closePanes}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {rows.length === 0
            ? scope === "global"
              ? "No templates for all projects yet."
              : "No templates in this project."
            : "No templates match."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((r) => (
            <div key={r.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                  <span className="font-mono">/{r.name}</span>
                  {r.argumentHint && <span className="font-mono text-[11px] text-muted-foreground">{r.argumentHint}</span>}
                  {r.seeded && (
                    <Badge variant="secondary" className="h-5 text-[10px]">
                      K-Dense
                    </Badge>
                  )}
                  {r.shadowed && (
                    <Badge variant="outline" className="h-5 text-[10px]">
                      {scope === "global" ? "Shadowed by a project template" : "Also defined for all projects"}
                    </Badge>
                  )}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{r.description}</div>
              </div>
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Edit ${r.name}`} onClick={() => void openEditor(r.name)}>
                <PencilIcon className="size-3.5" />
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Delete ${r.name}`} disabled={busy === `remove:${r.name}`} onClick={() => void doRemove(r)}>
                {busy === `remove:${r.name}` ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
