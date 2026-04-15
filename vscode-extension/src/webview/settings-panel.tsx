import { useEffect, useState } from "react";
import type { SidebarSettingsState } from "../shared/sidebar-persistence";

export type SettingsUpdateRequest = {
  globalSettings?: SidebarSettingsState;
  workspaceSettings?: SidebarSettingsState | null;
  globalOpenRouterApiKey?: string;
  workspaceOpenRouterApiKey?: string | null;
  globalParallelApiKey?: string;
  workspaceParallelApiKey?: string | null;
  globalModalTokenId?: string;
  workspaceModalTokenId?: string | null;
  globalModalTokenSecret?: string;
  workspaceModalTokenSecret?: string | null;
};

function cloneSettings(settings: SidebarSettingsState): SidebarSettingsState {
  return {
    showReasoning: settings.showReasoning,
    showProvenance: settings.showProvenance,
    defaultModelId: settings.defaultModelId,
    defaultComputeId: settings.defaultComputeId,
  };
}

function SettingsFields({
  prefix,
  settings,
  modelOptions,
  computeOptions,
  disabled,
  onChange,
}: {
  prefix: string;
  settings: SidebarSettingsState;
  modelOptions: Array<{ id: string; label: string }>;
  computeOptions: Array<{ id: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  onChange: (settings: SidebarSettingsState) => void;
}) {
  return (
    <div className="settings-fields">
      <label className="settings-toggle">
        <input
          checked={settings.showReasoning}
          data-settings-field={`${prefix}-show-reasoning`}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...settings, showReasoning: event.currentTarget.checked })
          }
          type="checkbox"
        />
        <span>Show reasoning by default</span>
      </label>
      <label className="settings-toggle">
        <input
          checked={settings.showProvenance}
          data-settings-field={`${prefix}-show-provenance`}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...settings, showProvenance: event.currentTarget.checked })
          }
          type="checkbox"
        />
        <span>Show provenance by default</span>
      </label>
      <label className="settings-field">
        <span className="settings-field__label">Default model</span>
        <select
          className="settings-field__select"
          data-settings-field={`${prefix}-default-model`}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...settings, defaultModelId: event.currentTarget.value })
          }
          value={settings.defaultModelId}
        >
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-field">
        <span className="settings-field__label">Default compute</span>
        <select
          className="settings-field__select"
          data-settings-field={`${prefix}-default-compute`}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...settings, defaultComputeId: event.currentTarget.value })
          }
          value={settings.defaultComputeId}
        >
          {computeOptions.map((compute) => (
            <option disabled={compute.disabled} key={compute.id} value={compute.id}>
              {compute.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function SectionHeader({ title, copy }: { title: string; copy: string }) {
  return (
    <header className="settings-section__header">
      <h3 className="settings-section__title">{title}</h3>
      <p className="settings-section__copy">{copy}</p>
    </header>
  );
}

function SecretStatus({ text }: { text: string }) {
  return <span className="settings-secret-status">{text}</span>;
}

export function SettingsPanel({
  backendState,
  globalSettings,
  workspaceSettings,
  secretMetadata,
  modalConfigured,
  modelOptions,
  computeOptions,
  pendingBackendAction,
  onBackendAction,
  onSave,
}: {
  backendState: {
    status: string;
    statusLabel: string;
    detail: string;
    requiresInitialization?: boolean;
  };
  globalSettings: SidebarSettingsState;
  workspaceSettings?: SidebarSettingsState;
  secretMetadata: {
    hasGlobalOpenRouterApiKey: boolean;
    hasWorkspaceOpenRouterApiKey: boolean;
    effectiveOpenRouterApiKeyScope: "workspace" | "global" | null;
    hasGlobalParallelApiKey: boolean;
    hasWorkspaceParallelApiKey: boolean;
    effectiveParallelApiKeyScope: "workspace" | "global" | null;
    hasGlobalModalTokenId: boolean;
    hasWorkspaceModalTokenId: boolean;
    effectiveModalTokenIdScope: "workspace" | "global" | null;
    hasGlobalModalTokenSecret: boolean;
    hasWorkspaceModalTokenSecret: boolean;
    effectiveModalTokenSecretScope: "workspace" | "global" | null;
  };
  modalConfigured: boolean;
  modelOptions: Array<{ id: string; label: string }>;
  computeOptions: Array<{ id: string; label: string; disabled?: boolean }>;
  pendingBackendAction: "refresh" | "start" | "initialize" | null;
  onBackendAction: (action: "refresh" | "start" | "initialize") => void;
  onSave: (request: SettingsUpdateRequest) => void;
}) {
  const [globalDraft, setGlobalDraft] = useState(cloneSettings(globalSettings));
  const [workspaceOverrideEnabled, setWorkspaceOverrideEnabled] = useState(Boolean(workspaceSettings));
  const [workspaceDraft, setWorkspaceDraft] = useState(cloneSettings(workspaceSettings ?? globalSettings));
  const [globalOpenRouterDraft, setGlobalOpenRouterDraft] = useState("");
  const [workspaceOpenRouterDraft, setWorkspaceOpenRouterDraft] = useState("");
  const [globalParallelDraft, setGlobalParallelDraft] = useState("");
  const [workspaceParallelDraft, setWorkspaceParallelDraft] = useState("");
  const [globalModalTokenIdDraft, setGlobalModalTokenIdDraft] = useState("");
  const [workspaceModalTokenIdDraft, setWorkspaceModalTokenIdDraft] = useState("");
  const [globalModalTokenSecretDraft, setGlobalModalTokenSecretDraft] = useState("");
  const [workspaceModalTokenSecretDraft, setWorkspaceModalTokenSecretDraft] = useState("");

  useEffect(() => {
    setGlobalDraft(cloneSettings(globalSettings));
  }, [globalSettings]);

  useEffect(() => {
    setWorkspaceOverrideEnabled(Boolean(workspaceSettings));
    setWorkspaceDraft(cloneSettings(workspaceSettings ?? globalSettings));
  }, [globalSettings, workspaceSettings]);

  const startAction = backendState.requiresInitialization ? "initialize" : "start";

  return (
    <section aria-label="Settings panel" className="settings-panel">
      <section className="settings-section">
        <SectionHeader
          copy="Defaults and secrets applied everywhere unless the current project overrides them."
          title="Global"
        />
        <div className="settings-section__grid">
          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Primary defaults</h3>
                <p className="settings-card__copy">Base model, compute, and display defaults for every workspace.</p>
              </div>
              <button
                className="button"
                data-settings-save="global"
                onClick={() => onSave({ globalSettings: globalDraft })}
                type="button"
              >
                Save globals
              </button>
            </div>
            <SettingsFields
              computeOptions={computeOptions}
              modelOptions={modelOptions}
              onChange={setGlobalDraft}
              prefix="global"
              settings={globalDraft}
            />
          </div>

          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Primary provider secret</h3>
                <p className="settings-card__copy">Global OpenRouter key stored securely for all projects.</p>
              </div>
              <SecretStatus
                text={
                  secretMetadata.hasGlobalOpenRouterApiKey ? "Global key active" : "No key stored"
                }
              />
            </div>
            <div className="settings-fields">
              <label className="settings-field">
                <span className="settings-field__label">Global OpenRouter API key</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="global-openrouter"
                  onChange={(event) => setGlobalOpenRouterDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasGlobalOpenRouterApiKey ? "•••••••• stored" : "sk-or-v1-..."}
                  type="password"
                  value={globalOpenRouterDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="global-secret"
                  onClick={() => {
                    onSave({ globalOpenRouterApiKey: globalOpenRouterDraft });
                    setGlobalOpenRouterDraft("");
                  }}
                  type="button"
                >
                  Save global key
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Advanced provider secrets</h3>
                <p className="settings-card__copy">Global Parallel and Modal credentials used across workspaces.</p>
              </div>
              <SecretStatus
                text={
                  secretMetadata.effectiveParallelApiKeyScope === "global" ||
                  secretMetadata.effectiveModalTokenIdScope === "global" ||
                  secretMetadata.effectiveModalTokenSecretScope === "global"
                    ? "Global advanced secrets active"
                    : "No global advanced secrets"
                }
              />
            </div>
            <div className="settings-fields">
              <h4 className="settings-subsection__title">Parallel</h4>
              <label className="settings-field">
                <span className="settings-field__label">Global Parallel API key</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="global-parallel"
                  onChange={(event) => setGlobalParallelDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasGlobalParallelApiKey ? "•••••••• stored" : "parallel-..."}
                  type="password"
                  value={globalParallelDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="global-parallel"
                  onClick={() => {
                    onSave({ globalParallelApiKey: globalParallelDraft });
                    setGlobalParallelDraft("");
                  }}
                  type="button"
                >
                  Save global Parallel key
                </button>
              </div>

              <h4 className="settings-subsection__title">Modal</h4>
              <label className="settings-field">
                <span className="settings-field__label">Global Modal token ID</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="global-modal-id"
                  onChange={(event) => setGlobalModalTokenIdDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasGlobalModalTokenId ? "•••••••• stored" : "modal-id"}
                  type="password"
                  value={globalModalTokenIdDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="global-modal-id"
                  onClick={() => {
                    onSave({ globalModalTokenId: globalModalTokenIdDraft });
                    setGlobalModalTokenIdDraft("");
                  }}
                  type="button"
                >
                  Save global Modal ID
                </button>
              </div>

              <label className="settings-field">
                <span className="settings-field__label">Global Modal token secret</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="global-modal-secret"
                  onChange={(event) => setGlobalModalTokenSecretDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasGlobalModalTokenSecret ? "•••••••• stored" : "modal-secret"}
                  type="password"
                  value={globalModalTokenSecretDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="global-modal-secret"
                  onClick={() => {
                    onSave({ globalModalTokenSecret: globalModalTokenSecretDraft });
                    setGlobalModalTokenSecretDraft("");
                  }}
                  type="button"
                >
                  Save global Modal secret
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <SectionHeader
          copy="Workspace-specific defaults and credentials that override globals only in this project."
          title="Project"
        />
        <div className="settings-section__grid">
          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Primary overrides</h3>
                <p className="settings-card__copy">Enable project-specific model, compute, and display defaults.</p>
              </div>
              <label className="settings-toggle settings-toggle--inline">
                <input
                  checked={workspaceOverrideEnabled}
                  data-settings-workspace-enabled
                  onChange={(event) => setWorkspaceOverrideEnabled(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>Enable override</span>
              </label>
            </div>
            <SettingsFields
              computeOptions={computeOptions}
              disabled={!workspaceOverrideEnabled}
              modelOptions={modelOptions}
              onChange={setWorkspaceDraft}
              prefix="workspace"
              settings={workspaceDraft}
            />
            <div className="settings-card__actions">
              <button
                className="button"
                data-settings-save="workspace"
                onClick={() => onSave({ workspaceSettings: workspaceOverrideEnabled ? workspaceDraft : null })}
                type="button"
              >
                Save project override
              </button>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Primary provider secret</h3>
                <p className="settings-card__copy">Optional project-specific OpenRouter override.</p>
              </div>
              <SecretStatus
                text={
                  secretMetadata.hasWorkspaceOpenRouterApiKey
                    ? "Project key active"
                    : "No project key stored"
                }
              />
            </div>
            <div className="settings-fields">
              <label className="settings-toggle settings-toggle--inline">
                <input
                  checked={secretMetadata.hasWorkspaceOpenRouterApiKey || workspaceOpenRouterDraft.length > 0}
                  data-settings-workspace-secret-enabled
                  onChange={(event) => {
                    if (!event.currentTarget.checked) {
                      setWorkspaceOpenRouterDraft("");
                      onSave({ workspaceOpenRouterApiKey: null });
                    }
                  }}
                  type="checkbox"
                />
                <span>Enable project-specific OpenRouter key</span>
              </label>
              <label className="settings-field">
                <span className="settings-field__label">Project OpenRouter API key</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="workspace-openrouter"
                  onChange={(event) => setWorkspaceOpenRouterDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasWorkspaceOpenRouterApiKey ? "•••••••• stored" : "Optional workspace override"}
                  type="password"
                  value={workspaceOpenRouterDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="workspace-secret"
                  onClick={() => {
                    onSave({ workspaceOpenRouterApiKey: workspaceOpenRouterDraft || null });
                    setWorkspaceOpenRouterDraft("");
                  }}
                  type="button"
                >
                  Save project key
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card__header">
              <div>
                <h3 className="settings-card__title">Advanced provider secrets</h3>
                <p className="settings-card__copy">Optional project-specific Parallel and Modal overrides.</p>
              </div>
              <SecretStatus
                text={
                  secretMetadata.effectiveParallelApiKeyScope === "workspace" ||
                  secretMetadata.effectiveModalTokenIdScope === "workspace" ||
                  secretMetadata.effectiveModalTokenSecretScope === "workspace"
                    ? "Project advanced secrets active"
                    : "No project advanced secrets"
                }
              />
            </div>
            <div className="settings-fields">
              <h4 className="settings-subsection__title">Parallel</h4>
              <label className="settings-field">
                <span className="settings-field__label">Project Parallel API key</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="workspace-parallel"
                  onChange={(event) => setWorkspaceParallelDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasWorkspaceParallelApiKey ? "•••••••• stored" : "Optional workspace override"}
                  type="password"
                  value={workspaceParallelDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="workspace-parallel"
                  onClick={() => {
                    onSave({ workspaceParallelApiKey: workspaceParallelDraft || null });
                    setWorkspaceParallelDraft("");
                  }}
                  type="button"
                >
                  Save project Parallel key
                </button>
              </div>

              <h4 className="settings-subsection__title">Modal</h4>
              <label className="settings-field">
                <span className="settings-field__label">Project Modal token ID</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="workspace-modal-id"
                  onChange={(event) => setWorkspaceModalTokenIdDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasWorkspaceModalTokenId ? "•••••••• stored" : "Optional workspace override"}
                  type="password"
                  value={workspaceModalTokenIdDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="workspace-modal-id"
                  onClick={() => {
                    onSave({ workspaceModalTokenId: workspaceModalTokenIdDraft || null });
                    setWorkspaceModalTokenIdDraft("");
                  }}
                  type="button"
                >
                  Save project Modal ID
                </button>
              </div>

              <label className="settings-field">
                <span className="settings-field__label">Project Modal token secret</span>
                <input
                  className="settings-field__input"
                  data-settings-secret="workspace-modal-secret"
                  onChange={(event) => setWorkspaceModalTokenSecretDraft(event.currentTarget.value)}
                  placeholder={secretMetadata.hasWorkspaceModalTokenSecret ? "•••••••• stored" : "Optional workspace override"}
                  type="password"
                  value={workspaceModalTokenSecretDraft}
                />
              </label>
              <div className="settings-card__actions">
                <button
                  className="button"
                  data-settings-save="workspace-modal-secret"
                  onClick={() => {
                    onSave({ workspaceModalTokenSecret: workspaceModalTokenSecretDraft || null });
                    setWorkspaceModalTokenSecretDraft("");
                  }}
                  type="button"
                >
                  Save project Modal secret
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="settings-card">
        <div className="settings-card__header">
          <div>
            <h3 className="settings-card__title">Runtime controls</h3>
            <p className="settings-card__copy">Refresh status or restart the backend from the settings area.</p>
          </div>
          <span className="settings-secret-status">{backendState.statusLabel}</span>
        </div>
        <p className="settings-card__copy">{backendState.detail}</p>
        <p className="settings-card__copy">{modalConfigured ? "Modal-backed compute is available." : "Modal-backed compute is not configured yet."}</p>
        <div className="settings-card__actions">
          <button
            className="button"
            data-backend-action="refresh"
            disabled={pendingBackendAction !== null}
            onClick={() => onBackendAction("refresh")}
            type="button"
          >
            {pendingBackendAction === "refresh" ? "Refreshing…" : "Refresh backend"}
          </button>
          <button
            className="button"
            data-backend-action={startAction}
            disabled={pendingBackendAction !== null}
            onClick={() => onBackendAction(startAction)}
            type="button"
          >
            {pendingBackendAction === startAction
              ? startAction === "initialize"
                ? "Initializing…"
                : "Restarting…"
              : startAction === "initialize"
                ? "Initialize K-Dense"
                : "Restart backend"}
          </button>
        </div>
      </div>
    </section>
  );
}
