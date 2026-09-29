"use client";

// Fusion configs panel (stored in localStorage, auto-populates model list).

import { useEffect, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  FUSION_DEFAULTS_VERSION,
  fusionJudgeModel,
  fusionPanelModels,
  loadFusionConfigs,
  type StoredFusionConfig,
} from "@/lib/fusion-presets";
import { SettingsError, SettingsHeader } from "./primitives";

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

/** A config must at least be a JSON object for the picker to price it. */
function configError(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? null
      : "The config must be a JSON object.";
  } catch (cause) {
    return `Invalid JSON: ${cause instanceof Error ? cause.message : "parse error"}`;
  }
}

export function FusionPanel() {
  const [configs, setConfigs] = useState<StoredFusionConfig[]>(() => loadFusionConfigs());
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState(FUSION_SKELETON);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

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
    const invalid = configError(newConfig);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
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

  const remove = async (config: StoredFusionConfig) => {
    const ok = await confirm({
      title: `Delete “${config.name}”?`,
      description: "It disappears from the model picker. Chats already using it keep their history.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    if (editingId === config.id) {
      setEditingId(null);
      setEditConfig("");
    }
    save(configs.filter((c) => c.id !== config.id));
  };

  const startEdit = (c: { id: string; config: string }) => {
    setError(null);
    setEditingId(c.id);
    setEditConfig(c.config);
  };
  const cancelEdit = () => {
    setError(null);
    setEditingId(null);
    setEditConfig("");
  };
  const saveEdit = () => {
    if (!editingId) return;
    const invalid = configError(editConfig);
    if (invalid) {
      setError(invalid);
      return;
    }
    const next = configs.map((c) => (c.id === editingId ? { ...c, config: editConfig } : c));
    save(next);
    cancelEdit();
  };

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <SettingsHeader
        title="Fusion configurations"
        description={
          <>
            Named OpenRouter Fusion setups appear at the top of the model picker. Paste the full
            Fusion request body (see the{" "}
            <a
              href="https://openrouter.ai/docs/guides/features/plugins/fusion"
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              OpenRouter Fusion docs
            </a>
            ). Fusion needs OpenRouter access and is saved in this browser only.
          </>
        }
      />

      <SettingsError>{error}</SettingsError>

      <div>
        <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowAdd((v) => !v)}>
          <PlusIcon className="size-3.5" /> Add Fusion config
        </Button>
        {showAdd && (
          <div className="mt-2">
            <Input
              placeholder="Config name (e.g. Research Fusion)"
              aria-label="Fusion config name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mb-2"
            />
            <Textarea
              value={newConfig}
              aria-label="Fusion config JSON"
              onChange={(e) => setNewConfig(e.target.value)}
              className="font-mono text-xs h-32"
            />
            <Button onClick={add} className="mt-2" size="sm" disabled={!newName.trim()}>
              <PlusIcon className="size-3.5 mr-1" /> Add
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {configs.length === 0 && <p className="text-xs text-muted-foreground">No Fusion configs yet.</p>}
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
                  <div>
                    Reasoning: {r} • Temp: {t}
                  </div>
                </div>
              );
            } catch {
              summary = <div className="mt-1 text-[10px] text-destructive">Invalid config</div>;
            }
          }
          return (
            <div key={c.id} className="rounded-lg border p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium">{c.name}</div>
                <div className="flex gap-1">
                  {!isEditing && (
                    <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => startEdit(c)}>
                      <PencilIcon className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => void remove(c)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
              {isEditing ? (
                <>
                  <Textarea
                    value={editConfig}
                    aria-label={`${c.name} config JSON`}
                    onChange={(e) => setEditConfig(e.target.value)}
                    className="font-mono text-xs h-32 mt-2"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" onClick={saveEdit}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit}>
                      Cancel
                    </Button>
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
