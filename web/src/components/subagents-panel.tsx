"use client";

/**
 * Settings → "Sub-agents" panel.
 *
 * Lists the agents available to the `subagent` delegation tool (pi-subagents):
 * project agents from sandbox/.pi/agents/*.md (editable) and the package's
 * builtin agents (read-only — "Customize" copies one into the project, where
 * it shadows the builtin by name). Mirrors the MCP servers panel's
 * list + inline-form interaction style.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  BotIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useProjects } from "@/lib/use-projects";
import {
  deleteAgent,
  getAgents,
  restoreDefaultAgents,
  saveAgent,
  setAgentEnabled,
  THINKING_LEVELS,
  type AgentFile,
} from "@/lib/agents";

interface AgentFormState {
  /** Name being edited, or null when creating a new agent. */
  originalName: string | null;
  name: string;
  description: string;
  model: string;
  thinking: string;
  tools: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  extra?: Record<string, string>;
  systemPrompt: string;
}

const EMPTY_FORM: AgentFormState = {
  originalName: null,
  name: "",
  description: "",
  model: "",
  thinking: "",
  tools: "",
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: true,
  systemPrompt: "",
};

function formFromAgent(agent: AgentFile, asCopy: boolean): AgentFormState {
  return {
    originalName: asCopy ? null : agent.name,
    name: agent.name,
    description: agent.description,
    model: agent.model ?? "",
    thinking: agent.thinking ?? "",
    tools: agent.tools ?? "",
    systemPromptMode: agent.systemPromptMode ?? "append",
    inheritProjectContext: agent.inheritProjectContext ?? true,
    inheritSkills: agent.inheritSkills ?? true,
    extra: agent.extra,
    systemPrompt: agent.systemPrompt,
  };
}

export function SubagentsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<AgentFile | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setAgents(await getAgents());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load agents");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setForm(null);
    setViewing(null);
    getAgents()
      .then((a) => {
        if (!cancelled) setAgents(a);
      })
      .catch((exc) => {
        if (!cancelled) {
          setError(exc instanceof Error ? exc.message : "Failed to load agents");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const toggleEnabled = useCallback(
    async (name: string, next: boolean) => {
      setAgents((list) => list.map((a) => (a.name === name ? { ...a, enabled: next } : a)));
      try {
        await setAgentEnabled(name, next);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Toggle failed");
        void refresh(); // reconcile on failure
      }
    },
    [refresh],
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    const name = form.name.trim().toLowerCase();
    if (!name) {
      setError("Agent name is required");
      return;
    }
    if (!form.systemPrompt.trim()) {
      setError("System prompt must not be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveAgent(name, {
        description: form.description.trim(),
        model: form.model.trim() || undefined,
        thinking: form.thinking || undefined,
        tools: form.tools.trim() || undefined,
        systemPromptMode: form.systemPromptMode,
        inheritProjectContext: form.inheritProjectContext,
        inheritSkills: form.inheritSkills,
        extra: form.extra,
        systemPrompt: form.systemPrompt,
      });
      // Renaming creates a new file; remove the old one so it doesn't linger.
      if (form.originalName && form.originalName !== name) {
        await deleteAgent(form.originalName).catch(() => {});
      }
      setForm(null);
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [form, refresh]);

  const handleDelete = useCallback(
    async (name: string) => {
      setSaving(true);
      setError(null);
      try {
        await deleteAgent(name);
        await refresh();
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Delete failed");
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const handleRestore = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await restoreDefaultAgents();
      setForm(null);
      setViewing(null);
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Restore failed");
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const project = agents.filter((a) => a.source === "project");
  const builtins = agents.filter((a) => a.source === "builtin");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Sub-agents</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Specialist agents the assistant can delegate to with the{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">subagent</code>{" "}
          tool. Agents are configured per project (current:{" "}
          <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>
          ) as markdown files in{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.pi/agents/</code>.
          Changes apply to new chat tabs.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : form ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs font-medium">Name</label>
              <Input
                value={form.name}
                placeholder="e.g. code-reviewer"
                className="h-8 text-xs font-mono"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs font-medium">
                Model{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                value={form.model}
                placeholder="inherit from defaults"
                className="h-8 text-xs font-mono"
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">Description</label>
            <Input
              value={form.description}
              placeholder="One line shown to the main agent when it picks a specialist"
              className="h-8 text-xs"
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">
              Thinking level{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <div className="flex flex-wrap gap-1">
              {["", ...THINKING_LEVELS].map((level) => (
                <Button
                  key={level || "default"}
                  variant={form.thinking === level ? "default" : "outline"}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setForm({ ...form, thinking: level })}
                >
                  {level || "default"}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">
              Tools{" "}
              <span className="font-normal text-muted-foreground">
                (comma-separated allowlist; empty = all tools)
              </span>
            </label>
            <Input
              value={form.tools}
              placeholder="read, grep, find, ls, bash"
              className="h-8 text-xs font-mono"
              onChange={(e) => setForm({ ...form, tools: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={form.inheritProjectContext}
                onCheckedChange={(v) => setForm({ ...form, inheritProjectContext: v })}
              />
              Inherit project context (AGENTS.md)
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={form.inheritSkills}
                onCheckedChange={(v) => setForm({ ...form, inheritSkills: v })}
              />
              Inherit skills
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={form.systemPromptMode === "replace"}
                onCheckedChange={(v) =>
                  setForm({ ...form, systemPromptMode: v ? "replace" : "append" })
                }
              />
              Replace base system prompt
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">System prompt</label>
            <Textarea
              value={form.systemPrompt}
              placeholder="You are a …"
              className="min-h-44 text-xs font-mono leading-relaxed"
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="text-xs"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : form.originalName ? "Save changes" : "Add agent"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-xs"
              onClick={() => setForm(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {project.map((agent) => (
              <div key={agent.name} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium font-mono">{agent.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {agent.description || "(no description)"}
                  </div>
                </div>
                {agent.model && (
                  <Badge variant="outline" className="hidden sm:inline-flex text-[10px] font-mono">
                    {agent.model}
                  </Badge>
                )}
                <Switch
                  aria-label={`Toggle ${agent.name}`}
                  checked={agent.enabled !== false}
                  onCheckedChange={(v) => void toggleEnabled(agent.name, v)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={`Edit ${agent.name}`}
                  onClick={() => setForm(formFromAgent(agent, false))}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-destructive hover:text-destructive"
                  aria-label={`Delete ${agent.name}`}
                  disabled={saving}
                  onClick={() => void handleDelete(agent.name)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
            {project.length === 0 && (
              <div className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
                No project agents yet. Add one, or restore the default scientific
                roster below.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => setForm({ ...EMPTY_FORM })}
            >
              <PlusIcon className="size-3.5" />
              Add agent
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground"
              disabled={saving}
              onClick={() => void handleRestore()}
              title="Re-seed the 21 default scientific agents (overwrites same-named project agents; custom agents are untouched)"
            >
              <RotateCcwIcon className="size-3.5" />
              Restore defaults
            </Button>
          </div>

          {builtins.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h4 className="mt-1 text-xs font-medium text-muted-foreground">
                Built-in agents{" "}
                <span className="font-normal">
                  (from pi-subagents — customize to override)
                </span>
              </h4>
              {builtins.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2"
                >
                  <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium font-mono">{agent.name}</div>
                    <div
                      className={cn(
                        "text-[11px] text-muted-foreground",
                        viewing?.name === agent.name ? "" : "truncate",
                      )}
                    >
                      {agent.description || "(no description)"}
                    </div>
                    {viewing?.name === agent.name && (
                      <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted p-2 text-[10px] leading-relaxed">
                        {agent.systemPrompt}
                      </pre>
                    )}
                  </div>
                  <Switch
                    aria-label={`Toggle ${agent.name}`}
                    checked={agent.enabled !== false}
                    onCheckedChange={(v) => void toggleEnabled(agent.name, v)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() =>
                      setViewing(viewing?.name === agent.name ? null : agent)
                    }
                  >
                    {viewing?.name === agent.name ? "Hide" : "View"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => setForm(formFromAgent(agent, true))}
                  >
                    Customize
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
