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
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  BrainCircuitIcon,
  LayersIcon,
  BotIcon,
  PlugIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  LoaderCircleIcon,
  ExternalLinkIcon,
  CloudIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/projects";
import { notifyModalCredentialsChanged } from "@/lib/modal-jobs";
import {
  FUSION_DEFAULTS_VERSION,
  fusionJudgeModel,
  fusionPanelModels,
  loadFusionConfigs,
  type StoredFusionConfig,
} from "@/lib/fusion-presets";
import dynamic from "next/dynamic";
const panelLoading = () => <div className="p-4 text-xs text-muted-foreground" role="status">Loading settings…</div>;
const SkillsPanel = dynamic(() => import("./skills-panel").then((m) => m.SkillsPanel), { loading: panelLoading });
const SubagentsPanel = dynamic(() => import("./subagents-panel").then((m) => m.SubagentsPanel), { loading: panelLoading });
const ConnectorsPanel = dynamic(() => import("./connectors-panel").then((m) => m.ConnectorsPanel), { loading: panelLoading });
const ProviderAuthPanel = dynamic(() => import("./provider-auth-panel").then((m) => m.ProviderAuthPanel), { loading: panelLoading });
import { notifyProviderAuthChanged } from "@/lib/use-provider-auth";

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
    id: "nvidia",
    bodyField: "nvidiaApiKey",
    label: "NVIDIA API key (optional)",
    placeholder: "nvapi-…",
    keysUrl: "https://build.nvidia.com/settings/api-keys",
    hint: "Direct access to NVIDIA NIM models (Nemotron, Llama, GPT-OSS, …). Usage draws on your NVIDIA API credits, which Kady cannot meter.",
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
        // NVIDIA keys also gate a model-picker section, so both re-probe it.
        if (def.id === "openrouter" || def.id === "nvidia") notifyProviderAuthChanged();
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

type ModalConnectionState = "idle" | "testing" | "connected" | "error";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorDetail(value: unknown): string | null {
  const record = recordValue(value);
  if (!record) return typeof value === "string" ? value : null;
  for (const candidate of [
    record.detail,
    record.error,
    record.message,
    record.reason,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    const nested = recordValue(candidate);
    if (nested) {
      const message = nested.message ?? nested.detail;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return null;
}

function credentialStatusFromResponse(value: unknown): CredentialStatus | null {
  const record = recordValue(value);
  if (!record) return null;
  const credentials = recordValue(record.credentials) ?? record;
  return recordValue(credentials.modalTokenId) || recordValue(credentials.modalTokenSecret)
    ? (credentials as CredentialStatus)
    : null;
}

function modalConnectionFromResponse(value: unknown): {
  status: string | null;
  detail: string | null;
} {
  const record = recordValue(value);
  if (!record) return { status: null, detail: null };
  const connection =
    recordValue(record.modal) ??
    recordValue(record.modalConnection) ??
    recordValue(record.validation);
  const status =
    (typeof connection?.status === "string" ? connection.status : null) ??
    (typeof record.modalStatus === "string" ? record.modalStatus : null) ??
    (record.modalConfigured === true ? "connected" : null);
  return {
    status,
    detail: errorDetail(connection) ?? errorDetail(record),
  };
}

function ModalCredentialPair({
  status,
  onStatus,
}: {
  status: CredentialStatus | null;
  onStatus: (status: CredentialStatus) => void;
}) {
  const tokenIdStatus = status?.modalTokenId;
  const tokenSecretStatus = status?.modalTokenSecret;
  const existingConnected = Boolean(tokenIdStatus?.set && tokenSecretStatus?.set);
  const existingPartial = Boolean(tokenIdStatus?.set) !== Boolean(tokenSecretStatus?.set);
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [connectionState, setConnectionState] = useState<ModalConnectionState>(
    existingConnected ? "connected" : existingPartial ? "error" : "idle",
  );
  const [error, setError] = useState<string | null>(
    existingPartial ? "Both Modal token fields must be set together." : null,
  );

  useEffect(() => {
    if (tokenIdStatus?.set && tokenSecretStatus?.set) {
      setConnectionState("connected");
      setError(null);
    } else if (Boolean(tokenIdStatus?.set) !== Boolean(tokenSecretStatus?.set)) {
      setConnectionState("error");
      setError("Both Modal token fields must be set together.");
    }
  }, [
    tokenIdStatus?.set,
    tokenSecretStatus?.set,
  ]);

  const savePair = useCallback(
    async (clear = false) => {
      if (!clear && (!tokenId.trim() || !tokenSecret.trim())) {
        setConnectionState("error");
        setError("Enter both the Modal token ID and token secret.");
        return;
      }
      setConnectionState("testing");
      setError(null);
      try {
        const response = await apiFetch("/credentials", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modalTokenId: clear ? null : tokenId.trim(),
            modalTokenSecret: clear ? null : tokenSecret.trim(),
          }),
        });
        const body = await response.json().catch(() => null);
        const connection = modalConnectionFromResponse(body);
        if (
          !response.ok ||
          connection.status === "error" ||
          connection.status === "invalid" ||
          connection.status === "disconnected"
        ) {
          throw new Error(
            connection.detail ??
              errorDetail(body) ??
              (response.ok
                ? "Modal rejected this token pair."
                : `Modal connection failed (${response.status})`),
          );
        }
        const nextStatus = credentialStatusFromResponse(body);
        if (nextStatus) onStatus(nextStatus);
        setTokenId("");
        setTokenSecret("");
        setConnectionState(clear ? "idle" : "connected");
        notifyModalCredentialsChanged();
      } catch (cause) {
        setConnectionState("error");
        setError(cause instanceof Error ? cause.message : "Modal connection failed");
      }
    },
    [onStatus, tokenId, tokenSecret],
  );

  return (
    <fieldset className="rounded-xl border p-3.5">
      <legend className="px-1 text-xs font-medium">
        <a
          href="https://modal.com/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:underline"
        >
          Modal compute
          <ExternalLinkIcon className="size-3" />
        </a>
      </legend>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Save and validate the token ID and secret as one pair. The pair enables durable CPU and
        GPU jobs without restarting Kady.
      </p>

      <div
        role={connectionState === "error" ? "alert" : "status"}
        className={cn(
          "mb-3 flex items-center gap-2 rounded-md border px-2.5 py-2 text-[11px]",
          connectionState === "testing" &&
            "border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300",
          connectionState === "connected" &&
            "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
          connectionState === "error" &&
            "border-destructive/30 bg-destructive/5 text-destructive",
          connectionState === "idle" && "bg-muted/20 text-muted-foreground",
        )}
      >
        {connectionState === "testing" ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : connectionState === "connected" ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : connectionState === "error" ? (
          <AlertCircleIcon className="size-3.5" />
        ) : (
          <span className="size-2 rounded-full bg-muted-foreground/40" />
        )}
        <span className="min-w-0 flex-1">
          {connectionState === "testing"
            ? "Testing Modal connection…"
            : connectionState === "connected"
              ? "Connected — Modal compute is ready."
              : connectionState === "error"
                ? error ?? "Modal connection failed."
                : "Not connected"}
        </span>
        {(tokenIdStatus?.set || tokenSecretStatus?.set) && connectionState !== "testing" ? (
          <span className="hidden shrink-0 font-mono text-[10px] sm:inline">
            {tokenIdStatus?.masked ?? "ID missing"} · {tokenSecretStatus?.masked ?? "secret missing"}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-[11px] font-medium">
          <span>Token ID</span>
          <Input
            type="password"
            value={tokenId}
            autoComplete="off"
            placeholder={tokenIdStatus?.set ? "Replace ak-…" : "ak-…"}
            className="h-8 font-mono text-xs"
            onChange={(event) => {
              setTokenId(event.target.value);
              if (connectionState === "error") {
                setConnectionState(existingConnected ? "connected" : "idle");
                setError(null);
              }
            }}
          />
        </label>
        <label className="space-y-1.5 text-[11px] font-medium">
          <span>Token Secret</span>
          <Input
            type="password"
            value={tokenSecret}
            autoComplete="off"
            placeholder={tokenSecretStatus?.set ? "Replace as-…" : "as-…"}
            className="h-8 font-mono text-xs"
            onChange={(event) => {
              setTokenSecret(event.target.value);
              if (connectionState === "error") {
                setConnectionState(existingConnected ? "connected" : "idle");
                setError(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && tokenId.trim() && tokenSecret.trim()) {
                void savePair();
              }
            }}
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {(tokenIdStatus?.set || tokenSecretStatus?.set) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={connectionState === "testing"}
            onClick={() => void savePair(true)}
            className="text-xs text-destructive hover:text-destructive"
          >
            Clear pair
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={
            connectionState === "testing" || !tokenId.trim() || !tokenSecret.trim()
          }
          onClick={() => void savePair()}
          className="text-xs"
        >
          {connectionState === "testing" ? "Testing…" : "Save & test"}
        </Button>
      </div>
    </fieldset>
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
          <ModalCredentialPair status={statusState} onStatus={setStatusState} />
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
            className="w-44 shrink-0 overflow-y-auto border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="model-providers"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <CloudIcon className="size-3.5" />
              Model providers
            </TabsTrigger>
            <TabsTrigger
              value="api-keys"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <KeyIcon className="size-3.5" />
              API keys
            </TabsTrigger>
            <TabsTrigger
              value="skills"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <LayersIcon className="size-3.5" />
              Skills
            </TabsTrigger>
            <TabsTrigger
              value="specialists"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <BotIcon className="size-3.5" />
              Specialists
            </TabsTrigger>
            <TabsTrigger
              value="connectors"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PlugIcon className="size-3.5" />
              Connectors
            </TabsTrigger>
            <TabsTrigger
              value="fusion"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <BrainCircuitIcon className="size-3.5" />
              Fusion
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PaletteIcon className="size-3.5" />
              Appearance
            </TabsTrigger>
          </TabsList>

          <TabsContent value="model-providers" className="flex-1 min-h-0 p-5">
            <ProviderAuthPanel />
          </TabsContent>
          <TabsContent value="api-keys" className="flex-1 min-h-0 p-5">
            <ApiKeysPanel />
          </TabsContent>
          <TabsContent value="skills" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SkillsPanel />
          </TabsContent>
          <TabsContent value="specialists" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SubagentsPanel />
          </TabsContent>
          <TabsContent value="connectors" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <ConnectorsPanel />
          </TabsContent>
          <TabsContent value="appearance" className="flex-1 min-h-0 p-5">
            <AppearancePanel />
          </TabsContent>
          <TabsContent value="fusion" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <FusionPanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Fusion configs panel (stored in localStorage, auto-populates model list)
// ---------------------------------------------------------------------------
const FUSION_SKELETON = JSON.stringify(
  {
    model: "openrouter/fusion",
    reasoning_effort: "high",
    plugins: [
      {
        id: "fusion",
        preset: "general-high",
        analysis_models: [],
        model: "",
        max_tool_calls: 8,
      },
    ],
  },
  null,
  2,
);

function FusionPanel() {
  const [configs, setConfigs] = useState<StoredFusionConfig[]>(() => loadFusionConfigs());
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState(FUSION_SKELETON);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const save = (next: StoredFusionConfig[]) => {
    setConfigs(next);
    localStorage.setItem("fusionConfigs", JSON.stringify(next));
    window.dispatchEvent(new Event("fusion-configs-changed"));
  };

  // `configs` is initialised from loadFusionConfigs(), which already merges in
  // new built-in presets when the stored defaults version is behind. Persist that
  // seed/migration once (no setState here, so no cascading renders).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("fusionConfigs");
      const storedVersion = Number(localStorage.getItem("fusionConfigsVersion") || "0");
      if (!raw || storedVersion < FUSION_DEFAULTS_VERSION) {
        localStorage.setItem("fusionConfigs", JSON.stringify(configs));
        localStorage.setItem("fusionConfigsVersion", String(FUSION_DEFAULTS_VERSION));
        window.dispatchEvent(new Event("fusion-configs-changed"));
      }
    } catch {}
  }, [configs]);

  const add = () => {
    if (!newName.trim()) return;
    const entry = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      config: newConfig,
    };
    save([...configs, entry]);
    setNewName("");
    setNewConfig(FUSION_SKELETON);
    setShowAdd(false);
  };

  const remove = (id: string) => {
    if (editingId === id) { setEditingId(null); setEditConfig(""); }
    save(configs.filter((c) => c.id !== id));
  };

  const startEdit = (c: { id: string; config: string }) => {
    setEditingId(c.id);
    setEditConfig(c.config);
  };
  const cancelEdit = () => { setEditingId(null); setEditConfig(""); };
  const saveEdit = () => {
    if (!editingId) return;
    const next = configs.map((c) => (c.id === editingId ? { ...c, config: editConfig } : c));
    save(next);
    cancelEdit();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium">Fusion Configurations</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Create named OpenRouter Fusion setups. They appear at the top of the model selector.
          Paste the full Fusion request body (see OpenRouter Fusion docs).
        </p>
      </div>

      <div className="pt-2">
        <Button
          variant="outline"
          size="sm"
          className="text-sm"
          onClick={() => setShowAdd((v) => !v)}
        >
          Add Fusion config +
        </Button>
        {showAdd && (
          <div className="mt-2">
            <Input
              placeholder="Config name (e.g. Research Fusion)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mb-2"
            />
            <Textarea
              value={newConfig}
              onChange={(e) => setNewConfig(e.target.value)}
              className="font-mono text-xs h-32"
            />
            <Button onClick={add} className="mt-2" size="sm">
              <PlusIcon className="size-3.5 mr-1" /> Add
            </Button>
            <a
              href="https://openrouter.ai/docs/guides/features/plugins/fusion"
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-3 text-[11px] text-muted-foreground hover:underline"
            >
              OpenRouter Fusion API docs →
            </a>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {configs.length === 0 && (
          <p className="text-xs text-muted-foreground">No Fusion configs yet.</p>
        )}
        {configs.map((c) => {
          const isEditing = editingId === c.id;
          let summary = null;
          if (!isEditing) {
            try {
              const p = JSON.parse(c.config);
              const panel = fusionPanelModels(p).join(", ");
              const judge = fusionJudgeModel(p) ?? "-";
              const r = p.reasoning_effort || "-";
              const t = p.temperature ?? "default";
              summary = (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  <div>Panel: {panel}</div>
                  <div>Judge: {judge}</div>
                  <div>Reasoning: {r} • Temp: {t}</div>
                </div>
              );
            } catch {
              summary = <div className="mt-1 text-[10px] text-muted-foreground">Invalid config</div>;
            }
          }
          return (
            <div key={c.id} className="rounded border p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium">{c.name}</div>
                <div className="flex gap-1">
                  {!isEditing && (
                    <Button variant="ghost" size="icon" onClick={() => startEdit(c)}>
                      <PencilIcon className="size-3.5" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => remove(c.id)}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
              {isEditing ? (
                <>
                  <Textarea
                    value={editConfig}
                    onChange={(e) => setEditConfig(e.target.value)}
                    className="font-mono text-xs h-32 mt-2"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" onClick={saveEdit}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit}>Cancel</Button>
                  </div>
                </>
              ) : (
                summary
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
