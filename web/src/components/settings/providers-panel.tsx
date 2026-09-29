"use client";

/**
 * Settings → Models → Providers: every way to reach a model in one place.
 * One row per provider (sign-in and API key merged — see lib/provider-rows),
 * then local servers (Ollama / OpenAI-compatible base URLs) and custom
 * model servers (Pi's models.json).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CustomModelsCard } from "@/components/custom-models-card";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { apiFetch } from "@/lib/projects";
import {
  mergeProviderRows,
  providerStatusLabel,
  type DirectProviderField,
  type DirectProviderStatus,
  type ProviderRow,
} from "@/lib/provider-rows";
import { useModels } from "@/lib/use-models";
import {
  PROVIDER_AUTH_CHANGED_EVENT,
  useProviderAuth,
  type ModelProviderStatus,
} from "@/lib/use-provider-auth";
import { cn } from "@/lib/utils";
import { KeyRow, useCredentialStatus, type CredentialStatus, type KeyDef } from "./key-row";
import {
  SettingsCard,
  SettingsError,
  SettingsHeader,
  SettingsSearch,
  matchesQuery,
} from "./primitives";

const OPENROUTER_KEY: KeyDef = {
  id: "openrouter",
  bodyField: "openrouterApiKey",
  label: "OpenRouter API key",
  placeholder: "sk-or-v1-…",
  keysUrl: "https://openrouter.ai/keys",
  hint: "One pay-as-you-go account for hundreds of hosted models, plus OpenRouter Fusion and server-side speech.",
  notifyProviders: true,
};

function fieldKeyDef(provider: DirectProviderStatus, field: DirectProviderField): KeyDef {
  return {
    id: field.credentialId,
    bodyField: field.bodyField,
    label: field.label,
    placeholder: field.placeholder ?? (field.secret ? "…" : ""),
    keysUrl: field.isKey ? provider.keysUrl : undefined,
    hint: field.hint ? `${field.hint} Stored as ${field.envVar} in .env.` : `Stored as ${field.envVar} in .env.`,
    secret: field.secret,
    notifyProviders: true,
  };
}

type MethodFilter = "all" | "sign-in" | "api-key";

/** `section` values the first-run card and model picker deep-link to. */
const SECTION_FILTER: Record<string, MethodFilter> = {
  subscriptions: "sign-in",
  "api-keys": "api-key",
};

function billingBadge(provider: ModelProviderStatus): string {
  return provider.billingMode === "metered_oauth"
    ? "Metered extra usage"
    : provider.billingMode === "payg"
      ? "Pay-as-you-go"
      : "Subscription";
}

function StatusBadge({ row }: { row: ProviderRow }) {
  if (row.status === "none") {
    return (
      <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">Not connected</span>
    );
  }
  if (row.status === "reauth") {
    return <Badge variant="destructive">Reconnect required</Badge>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      <CheckCircle2Icon className="size-3" aria-hidden />
      {providerStatusLabel(row)}
    </span>
  );
}

function ProviderRowCard({
  row,
  open,
  onToggle,
  credentials,
  onCredentials,
  onSignIn,
  onDisconnect,
  disconnecting,
}: {
  row: ProviderRow;
  open: boolean;
  onToggle: () => void;
  credentials: CredentialStatus | null;
  onCredentials: (status: CredentialStatus) => void;
  onSignIn: (provider: ModelProviderStatus) => void;
  onDisconnect: (provider: ModelProviderStatus) => void;
  disconnecting: boolean;
}) {
  const methods = [row.oauth ? "Sign in" : null, row.direct || row.openrouterKey ? "API key" : null]
    .filter(Boolean)
    .join(" · ");
  const keyDefs: KeyDef[] = row.openrouterKey
    ? [OPENROUTER_KEY]
    : (row.direct?.fields ?? []).map((field) => fieldKeyDef(row.direct!, field));

  return (
    <div className="rounded-lg border" data-testid={`provider-row-${row.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <span className="font-medium">{row.name}</span>
        <StatusBadge row={row} />
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {row.connected
            ? row.modelCount > 0
              ? `${row.modelCount} model${row.modelCount === 1 ? "" : "s"}`
              : row.openrouterKey
                ? "Full catalogue"
                : ""
            : methods}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t px-3 py-3">
          {row.oauth ? (
            <div className="flex items-start gap-3" data-testid={`provider-signin-${row.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{row.oauth.accountLabel}</span>
                  <Badge variant="outline">{billingBadge(row.oauth)}</Badge>
                </div>
                <p
                  className={cn(
                    "mt-1 text-[11px] leading-relaxed",
                    row.oauth.billingMode === "metered_oauth"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {row.oauth.billingNote}
                </p>
              </div>
              {row.oauth.connected ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={disconnecting}
                  onClick={() => onDisconnect(row.oauth!)}
                  aria-label={`Disconnect ${row.oauth.accountLabel}`}
                >
                  {disconnecting ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <LogOutIcon className="size-3.5" aria-hidden />
                  )}
                  Disconnect
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onSignIn(row.oauth!)}
                  aria-label={`${row.oauth.needsReauth ? "Reconnect" : "Connect"} ${row.oauth.accountLabel}`}
                >
                  <LogInIcon className="size-3.5" aria-hidden />
                  {row.oauth.needsReauth ? "Reconnect" : "Sign in"}
                </Button>
              )}
            </div>
          ) : null}

          {row.oauth && keyDefs.length > 0 ? (
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or use an API key
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null}

          {row.direct?.hint ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{row.direct.hint}</p>
          ) : null}
          {keyDefs.map((def) => (
            <KeyRow key={def.id} def={def} current={credentials?.[def.id]} onStatus={onCredentials} />
          ))}
          {row.direct?.billingNote ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">{row.direct.billingNote}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LocalServerCard({
  id,
  title,
  envVar,
  bodyField,
  defaultUrl,
  hint,
  credentials,
  onCredentials,
  available,
  modelCount,
}: {
  id: string;
  title: string;
  envVar: string;
  bodyField: string;
  defaultUrl: string;
  hint: string;
  credentials: CredentialStatus | null;
  onCredentials: (status: CredentialStatus) => void;
  available: boolean;
  modelCount: number;
}) {
  const url = credentials?.[bodyField]?.set ? credentials[bodyField]?.masked : null;
  return (
    <div className="rounded-lg border p-3" data-testid={`local-server-${id}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{title}</span>
        {available ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2Icon className="size-3" aria-hidden />
            Running · {modelCount} model{modelCount === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            Not reachable
          </span>
        )}
        <code className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{url ?? defaultUrl}</code>
      </div>
      <KeyRow
        def={{
          id: bodyField,
          bodyField,
          label: "Base URL",
          placeholder: defaultUrl,
          hint: `${hint} Leave unset to use ${defaultUrl}. Stored as ${envVar} in .env.`,
          secret: false,
          notifyProviders: true,
        }}
        current={credentials?.[bodyField]}
        onStatus={onCredentials}
      />
    </div>
  );
}

export function ProvidersPanel({ section }: { section?: string }) {
  const auth = useProviderAuth();
  const credentials = useCredentialStatus();
  const models = useModels();
  const [direct, setDirect] = useState<DirectProviderStatus[] | null>(null);
  const [directError, setDirectError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MethodFilter>(() => SECTION_FILTER[section ?? ""] ?? "all");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [signInId, setSignInId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    const next = SECTION_FILTER[section ?? ""];
    if (next) setFilter(next);
  }, [section]);

  const loadDirect = useCallback(async () => {
    try {
      const res = await apiFetch("/providers");
      if (!res.ok) throw new Error(`Failed to load providers (${res.status})`);
      const data = (await res.json()) as { providers?: DirectProviderStatus[] };
      setDirect(Array.isArray(data.providers) ? data.providers : []);
      setDirectError(null);
    } catch (exc) {
      setDirectError(exc instanceof Error ? exc.message : "Failed to load providers");
    }
  }, []);

  const { refresh: refreshAuth } = auth;
  useEffect(() => {
    void loadDirect();
    const onChanged = () => {
      void loadDirect();
      void refreshAuth();
    };
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChanged);
  }, [loadDirect, refreshAuth]);

  const rows = useMemo(
    () => mergeProviderRows(auth.providers, direct ?? [], credentials.status),
    [auth.providers, direct, credentials.status],
  );
  const connected = rows.filter((row) => row.connected || row.status === "reauth");
  const available = rows.filter((row) => !row.connected && row.status !== "reauth");
  const q = query.trim();
  const filtered = available.filter((row) => {
    if (filter === "sign-in" && !row.oauth) return false;
    if (filter === "api-key" && !row.direct && !row.openrouterKey) return false;
    if (q) {
      return matchesQuery(
        q,
        row.name,
        row.id,
        row.oauth?.accountLabel,
        ...(row.direct?.fields.map((field) => field.envVar) ?? []),
      );
    }
    return showAll || filter !== "all" || row.popular;
  });
  const hiddenCount = available.length - filtered.length;
  const signInProvider = auth.providers.find((provider) => provider.id === signInId) ?? null;
  const loading = (auth.loading && auth.providers.length === 0) || direct === null || credentials.loading;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const disconnect = async (provider: ModelProviderStatus) => {
    const ok = await confirm({
      title: `Disconnect ${provider.accountLabel}?`,
      description:
        "Existing chats remain on disk, but new requests through this sign-in will stop working until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setDisconnecting(provider.id);
    setActionError(null);
    try {
      await auth.logout(provider.id);
      await auth.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Disconnect failed");
    } finally {
      setDisconnecting(null);
    }
  };

  const rowProps = (row: ProviderRow) => ({
    row,
    open: expanded.has(row.id),
    onToggle: () => toggle(row.id),
    credentials: credentials.status,
    onCredentials: credentials.setStatus,
    onSignIn: (provider: ModelProviderStatus) => {
      setActionError(null);
      setSignInId(provider.id);
    },
    onDisconnect: (provider: ModelProviderStatus) => void disconnect(provider),
    disconnecting: disconnecting === row.id,
  });

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <SettingsHeader
        title="Model providers"
        description={
          <>
            Kady is bring-your-own-model: sign in with a subscription you already have, paste an
            API key, or point it at a local server. Credentials stay on this machine (keys in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env</code>, sign-ins in
            Kady&apos;s Pi credential store) — nothing is sent to K-Dense.
          </>
        }
        appliesTo="immediately"
      />

      <SettingsError>{actionError ?? auth.error ?? directError ?? credentials.error}</SettingsError>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Loading providers…
        </div>
      ) : (
        <>
          <SettingsCard id="connected" title={`Connected (${connected.length})`}>
            {connected.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No model provider is connected yet. Pick one below, or run a local model server.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {connected.map((row) => (
                  <ProviderRowCard key={row.id} {...rowProps(row)} />
                ))}
              </div>
            )}
          </SettingsCard>

          <SettingsCard
            id="add-provider"
            title="Add a provider"
            description="Subscriptions (ChatGPT, Claude Pro/Max, Copilot, …) sign in through the provider; everything else takes an API key or cloud credential. A connected provider gets its own section in the model picker."
          >
            {/* Deep-link anchors: the first-run card's "subscription" / "API key" actions. */}
            <span id="subscriptions" className="block scroll-mt-4" aria-hidden />
            <span id="api-keys" className="block scroll-mt-4" aria-hidden />
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SettingsSearch
                value={query}
                onChange={setQuery}
                placeholder="Search providers (name or env var)…"
                label="Search model providers"
                className="min-w-48 flex-1"
              />
              <div className="flex items-center gap-1 rounded-lg border p-1 text-xs" role="group" aria-label="Connection method">
                {(
                  [
                    ["all", "All"],
                    ["sign-in", "Sign in"],
                    ["api-key", "API key"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "rounded-md px-2 py-1",
                      filter === value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {q ? "No provider matches." : "Every provider of this kind is already connected."}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((row) => (
                  <ProviderRowCard key={row.id} {...rowProps(row)} />
                ))}
              </div>
            )}
            {!q && filter === "all" && (hiddenCount > 0 || showAll) ? (
              <div className="mt-3 flex justify-end">
                <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show popular only" : `Show all ${available.length} providers`}
                </Button>
              </div>
            ) : null}
          </SettingsCard>

          <SettingsCard
            id="local-servers"
            title="Local model servers"
            description="Free, private models running on this machine or your network. Kady probes each server and lists its models in the picker while it is reachable."
          >
            <div className="flex flex-col gap-3">
              <LocalServerCard
                id="ollama"
                title="Ollama"
                envVar="OLLAMA_BASE_URL"
                bodyField="ollamaBaseUrl"
                defaultUrl="http://localhost:11434"
                hint="Run `ollama serve` and pull a model."
                credentials={credentials.status}
                onCredentials={credentials.setStatus}
                available={models.ollamaAvailable}
                modelCount={models.ollamaModels.length}
              />
              <LocalServerCard
                id="openai-compatible"
                title="OpenAI-compatible server"
                envVar="OPENAI_COMPATIBLE_BASE_URL"
                bodyField="openaiCompatibleBaseUrl"
                defaultUrl="http://localhost:1234"
                hint="LM Studio, vLLM, llama.cpp server, text-generation-webui — anything serving /v1/models. vLLM's default port (8000) collides with Kady's backend, so move one of them."
                credentials={credentials.status}
                onCredentials={credentials.setStatus}
                available={models.openaiCompatibleAvailable}
                modelCount={models.openaiCompatibleModels.length}
              />
            </div>
          </SettingsCard>

          <div id="custom-servers" className="scroll-mt-4">
            <CustomModelsCard />
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Provider subscriptions have their own quotas and overage rules. Except for
            Anthropic&apos;s documented metered extra usage, Kady records tokens but does not treat
            provider-managed subscription usage as project spend.
          </p>
        </>
      )}

      <OAuthLoginDialog
        provider={signInProvider}
        open={signInId !== null}
        onOpenChange={(next) => {
          if (!next) setSignInId(null);
        }}
        start={auth.start}
        poll={auth.poll}
        respond={auth.respond}
        cancel={auth.cancel}
        onConnected={() => void auth.refresh()}
      />
    </div>
  );
}
