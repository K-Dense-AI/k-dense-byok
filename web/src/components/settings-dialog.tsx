"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  KeyIcon,
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ServerIcon,
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  GlobeIcon,
  TerminalIcon,
  BotIcon,
} from "lucide-react";
import { SubagentsPanel } from "@/components/subagents-panel";
import { useProjects } from "@/lib/use-projects";
import { apiFetch } from "@/lib/projects";
import {
  getMcpServers,
  saveMcpServers,
  testMcpServer,
  isHttpConfig,
  type McpServers,
  type McpServerConfig,
} from "@/lib/mcp";

type CredentialStatus = Record<string, { set: boolean; masked: string | null }>;

interface KeyDef {
  id: string;
  bodyField: string;
  label: string;
  placeholder: string;
  keysUrl: string;
  hint: string;
}

const KEY_DEFS: KeyDef[] = [
  {
    id: "openrouter",
    bodyField: "openrouterApiKey",
    label: "OpenRouter API key",
    placeholder: "sk-or-v1-…",
    keysUrl: "https://openrouter.ai/keys",
    hint: "Used for every model call. Required unless you run everything locally through Ollama.",
  },
  {
    id: "exa",
    bodyField: "exaApiKey",
    label: "Exa API key (optional)",
    placeholder: "exa-…",
    keysUrl: "https://dashboard.exa.ai/api-keys",
    hint: "Direct Exa web + code search. Without it, web search still works via a free Exa fallback.",
  },
  {
    id: "perplexity",
    bodyField: "perplexityApiKey",
    label: "Perplexity API key (optional)",
    placeholder: "pplx-…",
    keysUrl: "https://www.perplexity.ai/settings/api",
    hint: "Synthesized web answers with citations as an alternative search provider.",
  },
  {
    id: "gemini",
    bodyField: "geminiApiKey",
    label: "Gemini API key (optional)",
    placeholder: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
    hint: "Search fallback plus YouTube and video understanding for fetched links.",
  },
];

function KeyRow({
  def,
  current,
  onStatus,
}: {
  def: KeyDef;
  current: { set: boolean; masked: string | null } | undefined;
  onStatus: (status: CredentialStatus) => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = useCallback(
    async (value: string | null) => {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const res = await apiFetch("/credentials", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [def.bodyField]: value }),
        });
        const data = (await res.json().catch(() => null)) as
          | (CredentialStatus & { detail?: string })
          | null;
        if (!res.ok) throw new Error(data?.detail || `Save failed (${res.status})`);
        if (data) onStatus(data as CredentialStatus);
        setKeyInput("");
        setSaved(true);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [def.bodyField, onStatus],
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium">
        <a
          href={def.keysUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          {def.label}
        </a>
      </label>
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {current?.set && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <span>
            Key set — <code className="font-mono">{current.masked}</code>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-[11px] text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => void submit(null)}
          >
            Clear
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={keyInput}
          autoComplete="off"
          placeholder={current?.set ? `Replace key (${def.placeholder})` : def.placeholder}
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setKeyInput(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyInput.trim()) void submit(keyInput.trim());
          }}
        />
        <Button
          size="sm"
          className="text-xs"
          disabled={saving || !keyInput.trim()}
          onClick={() => void submit(keyInput.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {saved && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          Saved. New runs use it immediately — no restart needed.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground leading-relaxed">{def.hint}</p>
    </div>
  );
}

function ApiKeysPanel() {
  const [statusState, setStatusState] = useState<CredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/credentials");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      setStatusState((await res.json()) as CredentialStatus);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">API keys</h3>
        <p className="text-xs text-muted-foreground mt-1">
          K-Dense BYOK is bring-your-own-key. Keys stay on this machine (saved
          to <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env</code>)
          — nothing is sent to K-Dense. The search keys are optional: web
          search, page fetching, and GitHub reading work without any of them.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          {KEY_DEFS.map((def) => (
            <KeyRow
              key={def.id}
              def={def}
              current={statusState?.[def.id]}
              onStatus={setStatusState}
            />
          ))}
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Other keys (e.g.{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              OLLAMA_BASE_URL
            </code>
            ,{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
              GITHUB_TOKEN
            </code>
            ) are still read from{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">.env</code>{" "}
            at startup.
          </p>
        </div>
      )}
    </div>
  );
}

function AppearancePanel() {
  const { theme, setTheme } = useTheme();

  const options: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Appearance</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Choose how K-Dense BYOK looks. System follows your operating
          system&apos;s theme.
        </p>
      </div>

      <div className="flex gap-2">
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = theme === opt.value;
          return (
            <Button
              key={opt.value}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(opt.value)}
              className={cn("flex-1 gap-1.5 text-xs")}
            >
              <Icon className="size-3.5" />
              {opt.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

interface McpFormState {
  /** Key being edited, or null when adding a new server. */
  originalName: string | null;
  name: string;
  type: "http" | "stdio";
  url: string;
  bearerToken: string;
  /** Non-Authorization headers preserved across edits (not shown in the form). */
  extraHeaders: Record<string, string>;
  command: string;
  args: string;
  env: string;
}

const EMPTY_MCP_FORM: McpFormState = {
  originalName: null,
  name: "",
  type: "http",
  url: "",
  bearerToken: "",
  extraHeaders: {},
  command: "",
  args: "",
  env: "",
};

function formFromConfig(name: string, config: McpServerConfig): McpFormState {
  if (isHttpConfig(config)) {
    const { Authorization, ...extraHeaders } = config.headers ?? {};
    return {
      ...EMPTY_MCP_FORM,
      originalName: name,
      name,
      type: "http",
      url: config.url,
      bearerToken: (Authorization ?? "").replace(/^Bearer\s+/i, ""),
      extraHeaders,
    };
  }
  return {
    ...EMPTY_MCP_FORM,
    originalName: name,
    name,
    type: "stdio",
    command: config.command,
    args: (config.args ?? []).join(" "),
    env: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

function configFromForm(form: McpFormState): McpServerConfig {
  if (form.type === "http") {
    const headers: Record<string, string> = { ...form.extraHeaders };
    if (form.bearerToken.trim()) {
      headers.Authorization = `Bearer ${form.bearerToken.trim()}`;
    }
    return {
      url: form.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
  const env: Record<string, string> = {};
  for (const line of form.env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return {
    command: form.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function summarizeConfig(config: McpServerConfig): string {
  if (isHttpConfig(config)) return config.url;
  return [config.command, ...(config.args ?? [])].join(" ");
}

function McpServersPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [servers, setServers] = useState<McpServers>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForm(null);
    getMcpServers()
      .then((s) => {
        if (!cancelled) setServers(s);
      })
      .catch((exc) => {
        if (!cancelled) {
          setError(exc instanceof Error ? exc.message : "Failed to load MCP servers");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const persist = useCallback(async (next: McpServers) => {
    setSaving(true);
    setError(null);
    try {
      await saveMcpServers(next);
      setServers(next);
      setForm(null);
      setTestResult(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setError("Server name is required");
      return;
    }
    const next: McpServers = { ...servers };
    if (form.originalName && form.originalName !== name) {
      delete next[form.originalName];
    }
    next[name] = configFromForm(form);
    await persist(next);
  }, [form, servers, persist]);

  const handleDelete = useCallback(
    async (name: string) => {
      const next = { ...servers };
      delete next[name];
      await persist(next);
    },
    [servers, persist]
  );

  const handleTest = useCallback(async () => {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await testMcpServer(form.name.trim() || "server", configFromForm(form));
      setTestResult(
        result.ok
          ? `Connected — ${result.tools?.length ?? 0} tool${(result.tools?.length ?? 0) === 1 ? "" : "s"}: ${(result.tools ?? []).slice(0, 8).join(", ")}${(result.tools?.length ?? 0) > 8 ? ", …" : ""}`
          : `Connection failed: ${result.detail ?? "unknown error"}`
      );
    } catch (exc) {
      setTestResult(
        `Connection failed: ${exc instanceof Error ? exc.message : "unknown error"}`
      );
    } finally {
      setTesting(false);
    }
  }, [form]);

  const names = Object.keys(servers).sort();

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">MCP servers</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Connect Model Context Protocol servers to give the agent extra tools.
          Servers are configured per project (current:{" "}
          <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>
          ) and stored locally in the project sandbox. Changes apply to new chat
          tabs.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {names.length === 0 && !form && (
            <div className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
              No MCP servers configured for this project yet.
            </div>
          )}

          {names.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {names.map((name) => {
                const config = servers[name];
                const http = isHttpConfig(config);
                return (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    {http ? (
                      <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {summarizeConfig(config)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      aria-label={`Edit ${name}`}
                      onClick={() => {
                        setTestResult(null);
                        setForm(formFromConfig(name, config));
                      }}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0 text-destructive hover:text-destructive"
                      aria-label={`Remove ${name}`}
                      disabled={saving}
                      onClick={() => void handleDelete(name)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {form ? (
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Name</label>
                <Input
                  value={form.name}
                  placeholder="e.g. linear"
                  className="h-8 text-xs"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                {(
                  [
                    { value: "http", label: "Remote (HTTP)", icon: GlobeIcon },
                    { value: "stdio", label: "Local (command)", icon: TerminalIcon },
                  ] as const
                ).map((opt) => (
                  <Button
                    key={opt.value}
                    variant={form.type === opt.value ? "default" : "outline"}
                    size="sm"
                    className="flex-1 gap-1.5 text-xs"
                    onClick={() => setForm({ ...form, type: opt.value })}
                  >
                    <opt.icon className="size-3.5" />
                    {opt.label}
                  </Button>
                ))}
              </div>

              {form.type === "http" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Server URL</label>
                    <Input
                      value={form.url}
                      placeholder="https://mcp.example.com/mcp"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Bearer token{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <Input
                      type="password"
                      value={form.bearerToken}
                      placeholder="Sent as Authorization: Bearer …"
                      className="h-8 text-xs"
                      autoComplete="off"
                      onChange={(e) => setForm({ ...form, bearerToken: e.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Command</label>
                    <Input
                      value={form.command}
                      placeholder="npx"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Arguments{" "}
                      <span className="font-normal text-muted-foreground">
                        (space-separated)
                      </span>
                    </label>
                    <Input
                      value={form.args}
                      placeholder="-y @modelcontextprotocol/server-github"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, args: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Environment variables{" "}
                      <span className="font-normal text-muted-foreground">
                        (KEY=value, one per line)
                      </span>
                    </label>
                    <Textarea
                      value={form.env}
                      placeholder={"GITHUB_TOKEN=ghp_…"}
                      className="min-h-16 text-xs font-mono"
                      onChange={(e) => setForm({ ...form, env: e.target.value })}
                    />
                  </div>
                </>
              )}

              {testResult && (
                <div
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed",
                    testResult.startsWith("Connected")
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-destructive/50 bg-destructive/10 text-destructive"
                  )}
                >
                  {testResult}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="text-xs"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? "Saving…" : form.originalName ? "Save changes" : "Add server"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={testing}
                  onClick={() => void handleTest()}
                >
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-xs"
                  onClick={() => {
                    setForm(null);
                    setTestResult(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 self-start text-xs"
              onClick={() => {
                setTestResult(null);
                setForm({ ...EMPTY_MCP_FORM });
              }}
            >
              <PlusIcon className="size-3.5" />
              Add server
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-2xl h-[min(560px,80dvh)] flex flex-col gap-0 p-0 overflow-hidden"
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-xs">
            Configure your workspace preferences.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="api-keys"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="api-keys"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <KeyIcon className="size-3.5" />
              API keys
            </TabsTrigger>
            <TabsTrigger
              value="mcp"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <ServerIcon className="size-3.5" />
              MCP servers
            </TabsTrigger>
            <TabsTrigger
              value="agents"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <BotIcon className="size-3.5" />
              Sub-agents
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PaletteIcon className="size-3.5" />
              Appearance
            </TabsTrigger>
          </TabsList>

          <TabsContent value="api-keys" className="flex-1 min-h-0 p-5">
            <ApiKeysPanel />
          </TabsContent>
          <TabsContent value="mcp" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <McpServersPanel />
          </TabsContent>
          <TabsContent value="agents" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SubagentsPanel />
          </TabsContent>
          <TabsContent value="appearance" className="flex-1 min-h-0 p-5">
            <AppearancePanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
