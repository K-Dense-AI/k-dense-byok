"use client";

/**
 * Settings → Model providers → Custom model servers.
 *
 * Edits Pi's models.json through the backend: one card per provider, a table
 * of models with pricing. Hand-written providers (not created here) are shown
 * read-only so a models.json shared with a standalone Pi is never clobbered.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  CUSTOM_MODEL_APIS,
  getCustomProviders,
  saveCustomProviders,
  type CustomModelApi,
  type CustomModelDefinition,
  type CustomProvider,
  type CustomProviderListing,
} from "@/lib/custom-models";

interface ModelRow {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  image: boolean;
  costInput: string;
  costOutput: string;
}

interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomModelApi;
  apiKey: string;
  models: ModelRow[];
}

const emptyModel = (): ModelRow => ({
  id: "",
  name: "",
  contextWindow: "",
  maxTokens: "",
  reasoning: false,
  image: false,
  costInput: "0",
  costOutput: "0",
});

const emptyProvider = (): ProviderDraft => ({
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  models: [emptyModel()],
});

function draftFrom(p: CustomProviderListing): ProviderDraft {
  return {
    id: p.id,
    name: p.name ?? "",
    baseUrl: p.baseUrl,
    api: p.api,
    apiKey: p.apiKey && p.apiKey !== "none" ? p.apiKey : "",
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name ?? "",
      contextWindow: m.contextWindow ? String(m.contextWindow) : "",
      maxTokens: m.maxTokens ? String(m.maxTokens) : "",
      reasoning: m.reasoning ?? false,
      image: m.input?.includes("image") ?? false,
      costInput: String(m.cost?.input ?? 0),
      costOutput: String(m.cost?.output ?? 0),
    })),
  };
}

/** Pure: turn drafts into the wire shape, or return the first problem. */
export function providersFromDrafts(drafts: ProviderDraft[]): CustomProvider[] | string {
  const out: CustomProvider[] = [];
  for (const d of drafts) {
    const id = d.id.trim().toLowerCase();
    if (!id) return "Every server needs an id";
    if (!d.baseUrl.trim()) return `Server "${id}" needs a base URL`;
    const models: CustomModelDefinition[] = [];
    for (const m of d.models) {
      const modelId = m.id.trim();
      if (!modelId) continue;
      const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
      const cw = num(m.contextWindow);
      const mt = num(m.maxTokens);
      const ci = Number(m.costInput || 0);
      const co = Number(m.costOutput || 0);
      if ([cw, mt, ci, co].some((n) => n !== undefined && !Number.isFinite(n))) {
        return `Model "${modelId}" has a non-numeric field`;
      }
      const def: CustomModelDefinition = {
        id: modelId,
        ...(m.name.trim() ? { name: m.name.trim() } : {}),
        reasoning: m.reasoning,
        input: m.image ? ["text", "image"] : ["text"],
        ...(cw !== undefined ? { contextWindow: cw } : {}),
        ...(mt !== undefined ? { maxTokens: mt } : {}),
        cost: { input: ci, output: co, cacheRead: 0, cacheWrite: 0 },
      };
      models.push(def);
    }
    if (models.length === 0) return `Server "${id}" needs at least one model id`;
    out.push({
      id,
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      baseUrl: d.baseUrl.trim(),
      api: d.api,
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      models,
    });
  }
  return out;
}

export function CustomModelsCard() {
  const [foreign, setForeign] = useState<CustomProviderListing[]>([]);
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const providers = await getCustomProviders();
      setForeign(providers.filter((p) => !p.managed));
      setDrafts(providers.filter((p) => p.managed).map(draftFrom));
      setDirty(false);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load custom model servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback((index: number, patch: Partial<ProviderDraft>) => {
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
    setDirty(true);
  }, []);
  const editModel = useCallback((pi: number, mi: number, patch: Partial<ModelRow>) => {
    setDrafts((ds) =>
      ds.map((d, i) =>
        i === pi ? { ...d, models: d.models.map((m, j) => (j === mi ? { ...m, ...patch } : m)) } : d,
      ),
    );
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    const providers = providersFromDrafts(drafts);
    if (typeof providers === "string") {
      setError(providers);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveCustomProviders(providers);
      setDrafts(result.providers.filter((p) => p.managed).map(draftFrom));
      setForeign(result.providers.filter((p) => !p.managed));
      setConfigured(result.configured);
      setDirty(false);
      const unreachable = Object.entries(result.configured).filter(([, ok]) => !ok).map(([id]) => id);
      setNotice(
        unreachable.length
          ? `Saved. Pi could not resolve credentials for: ${unreachable.join(", ")} — check the API key.`
          : "Saved. The servers are available in the model picker now.",
      );
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [drafts]);

  const canSave = useMemo(() => dirty && !saving, [dirty, saving]);

  return (
    <section className="rounded-lg border p-3" aria-label="Custom model servers" data-testid="custom-models-card">
      <div className="flex items-start gap-2">
        <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Custom model servers</div>
          <p className="text-[11px] text-muted-foreground">
            Any OpenAI- or Anthropic-compatible endpoint (a lab vLLM box, an institutional gateway) with
            its own pricing and context metadata. References become <code>server-id/model-id</code>;
            usage is billed at the cost you declare and counts toward the spend cap.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={() => {
            setDrafts((ds) => [...ds, emptyProvider()]);
            setDirty(true);
          }}
        >
          <PlusIcon className="size-3.5" />
          Add server
        </Button>
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
      {loading && <p className="mt-2 text-xs text-muted-foreground">Loading…</p>}

      {foreign.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          Defined by hand in models.json (read-only here):
          {foreign.map((p) => (
            <Badge key={p.id} variant="outline" className="h-5 font-mono text-[10px]">
              {p.id}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {drafts.map((d, pi) => (
          <div key={pi} className="rounded-md border p-3" data-testid={`custom-provider-${pi}`}>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted-foreground">
                Server id (becomes the model prefix)
                <Input
                  value={d.id}
                  placeholder="hpc-vllm"
                  className="mt-1 h-8 font-mono text-xs"
                  aria-label={`Server ${pi + 1} id`}
                  onChange={(e) => edit(pi, { id: e.target.value })}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                Display name
                <Input
                  value={d.name}
                  placeholder="Lab vLLM"
                  className="mt-1 h-8 text-xs"
                  aria-label={`Server ${pi + 1} name`}
                  onChange={(e) => edit(pi, { name: e.target.value })}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                Base URL
                <Input
                  value={d.baseUrl}
                  placeholder="http://gpu-node:8000/v1"
                  className="mt-1 h-8 font-mono text-xs"
                  aria-label={`Server ${pi + 1} base URL`}
                  onChange={(e) => edit(pi, { baseUrl: e.target.value })}
                />
              </label>
              <label className="text-[11px] text-muted-foreground">
                API
                <select
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
                  aria-label={`Server ${pi + 1} API`}
                  value={d.api}
                  onChange={(e) => edit(pi, { api: e.target.value as CustomModelApi })}
                >
                  {CUSTOM_MODEL_APIS.map((api) => (
                    <option key={api} value={api}>
                      {api}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-muted-foreground sm:col-span-2">
                API key (literal, <code>$ENV_VAR</code>, or empty for a keyless server)
                <Input
                  value={d.apiKey}
                  placeholder="$LAB_VLLM_KEY"
                  className="mt-1 h-8 font-mono text-xs"
                  aria-label={`Server ${pi + 1} API key`}
                  onChange={(e) => edit(pi, { apiKey: e.target.value })}
                />
              </label>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="pb-1 pr-2 font-medium">Model id</th>
                    <th className="pb-1 pr-2 font-medium">Name</th>
                    <th className="pb-1 pr-2 font-medium">Context</th>
                    <th className="pb-1 pr-2 font-medium">Max out</th>
                    <th className="pb-1 pr-2 font-medium">$/M in</th>
                    <th className="pb-1 pr-2 font-medium">$/M out</th>
                    <th className="pb-1 pr-2 font-medium">Reasons</th>
                    <th className="pb-1 pr-2 font-medium">Images</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {d.models.map((m, mi) => (
                    <tr key={mi}>
                      <td className="pr-2 py-0.5">
                        <Input value={m.id} placeholder="llama-3.3-70b" className="h-7 font-mono text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} id`} onChange={(e) => editModel(pi, mi, { id: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Input value={m.name} className="h-7 text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} name`} onChange={(e) => editModel(pi, mi, { name: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Input value={m.contextWindow} inputMode="numeric" placeholder="128000" className="h-7 w-20 text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} context`} onChange={(e) => editModel(pi, mi, { contextWindow: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Input value={m.maxTokens} inputMode="numeric" placeholder="16384" className="h-7 w-20 text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} max tokens`} onChange={(e) => editModel(pi, mi, { maxTokens: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Input value={m.costInput} inputMode="decimal" className="h-7 w-16 text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} input cost`} onChange={(e) => editModel(pi, mi, { costInput: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Input value={m.costOutput} inputMode="decimal" className="h-7 w-16 text-[11px]" aria-label={`Server ${pi + 1} model ${mi + 1} output cost`} onChange={(e) => editModel(pi, mi, { costOutput: e.target.value })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Switch checked={m.reasoning} aria-label={`Server ${pi + 1} model ${mi + 1} reasoning`} onCheckedChange={(v) => editModel(pi, mi, { reasoning: v })} />
                      </td>
                      <td className="pr-2 py-0.5">
                        <Switch checked={m.image} aria-label={`Server ${pi + 1} model ${mi + 1} images`} onCheckedChange={(v) => editModel(pi, mi, { image: v })} />
                      </td>
                      <td className="py-0.5">
                        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Remove server ${pi + 1} model ${mi + 1}`} onClick={() => edit(pi, { models: d.models.filter((_, j) => j !== mi) })}>
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => edit(pi, { models: [...d.models, emptyModel()] })}>
                <PlusIcon className="size-3.5" />
                Add model
              </Button>
              {configured[d.id] === false && (
                <Badge variant="outline" className="h-5 text-[10px] text-amber-600">
                  credentials unresolved
                </Badge>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-7 text-[11px] text-destructive"
                aria-label={`Remove server ${pi + 1}`}
                onClick={() => {
                  setDrafts((ds) => ds.filter((_, i) => i !== pi));
                  setDirty(true);
                }}
              >
                <Trash2Icon className="size-3.5" />
                Remove server
              </Button>
            </div>
          </div>
        ))}
      </div>

      {(drafts.length > 0 || dirty) && (
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" className="h-8 text-xs" disabled={!canSave} onClick={() => void save()}>
            {saving && <Loader2Icon className="size-3.5 animate-spin" />}
            Save servers
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={saving} onClick={() => void load()}>
            Discard changes
          </Button>
        </div>
      )}
    </section>
  );
}
