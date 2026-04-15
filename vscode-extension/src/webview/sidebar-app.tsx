import { useEffect, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarScaffoldState } from "../shared/sidebar-scaffold";
import type { WorkspaceTrustState } from "../shared/workspace-trust";
import {
  COMPUTE_INSTANCES,
  createSidebarChatRequest,
  DATABASES,
  LOCAL_INSTANCE,
  MODELS,
  type Database,
  type ModalInstance,
  type Model,
} from "./chat-controls";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "./components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageReasoning,
  MessageResponse,
} from "./components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./components/ai-elements/prompt-input";
import { ProvenancePanel } from "./components/provenance-panel";
import { SettingsPanel, type SettingsUpdateRequest } from "./settings-panel";
import { WorkflowsPanel, type WorkflowLaunchRequest } from "./workflows-panel";

export type SidebarAppProps = {
  state: SidebarScaffoldState;
  pendingBackendAction: "refresh" | "start" | "initialize" | null;
  composerDraft: string;
  pendingChatSend: boolean;
  selectedTargetId?: string;
  initialActiveTab?: "chat" | "workflows" | "settings";
  onComposerDraftChange: (value: string) => void;
  onTargetChange: (value?: string) => void;
  onSend: (request: { text: string; modelId: string }) => void;
  onBackendAction: (action: "refresh" | "start" | "initialize") => void;
  onSettingsUpdate: (request: SettingsUpdateRequest) => void;
};

function shouldShowTargetSelector(
  state: SidebarScaffoldState,
  selectedTargetId?: string,
) {
  return Boolean(
    state.targetRequirement && !selectedTargetId && state.targetOptions.length > 1,
  );
}

function ServiceNotice({
  state,
  pendingBackendAction,
  selectedTargetId,
  onBackendAction,
}: {
  state: SidebarScaffoldState;
  pendingBackendAction: "refresh" | "start" | "initialize" | null;
  selectedTargetId?: string;
  onBackendAction: (action: "refresh" | "start" | "initialize") => void;
}) {
  const backend = state.backend;
  const trust = state.trust;
  const targetRequirement = state.targetRequirement;
  const requiresInitialization = backend.requiresInitialization === true;
  const startBlockedByTrust = !trust.capabilities.backendStart;
  const startDisabled =
    startBlockedByTrust ||
    pendingBackendAction !== null ||
    backend.status === "starting" ||
    Boolean(targetRequirement && !selectedTargetId);
  const refreshDisabled = pendingBackendAction !== null;
  const executionLocationLabel =
    backend.executionLocation === "remote" ? "Remote host" : "Desktop host";
  const needsNotice =
    !trust.isTrusted ||
    backend.status !== "healthy" ||
    pendingBackendAction !== null ||
    Boolean(targetRequirement && !selectedTargetId);

  if (!needsNotice) {
    return null;
  }

  const title = !trust.isTrusted
    ? trust.statusLabel
    : requiresInitialization
      ? "Initialize workspace"
      : targetRequirement && !selectedTargetId
        ? "Choose a workspace target"
        : backend.status === "starting"
          ? "Starting backend"
          : backend.status === "failed"
            ? "Backend start failed"
            : backend.status === "unavailable"
              ? "Backend unavailable"
              : "Backend status";
  const copy = !trust.isTrusted
    ? trust.detail
    : targetRequirement && !selectedTargetId
      ? targetRequirement
      : backend.detail;
  const meta = !trust.isTrusted
    ? trust.summary
    : `${executionLocationLabel} · ${backend.baseUrl}${backend.workspaceRootLabel ? ` · ${backend.workspaceRootLabel}` : ""}`;

  return (
    <section
      aria-label="Sidebar status"
      className={`service-notice service-notice--${trust.isTrusted ? "trusted" : "restricted"}`}
    >
      <div className="service-notice__row">
        <h2 className="service-notice__title">{title}</h2>
        <div className="message__chips">
          <span className="chip">{backend.statusLabel}</span>
          <span className="chip">{executionLocationLabel}</span>
          {!trust.isTrusted ? <span className="chip">{state.status}</span> : null}
        </div>
      </div>
      <p className="service-notice__copy">{copy}</p>
      <p className="service-notice__copy">{meta}</p>
      {trust.isTrusted ? (
        <div className="service-notice__actions">
          <button
            className="button"
            data-backend-action="refresh"
            disabled={refreshDisabled}
            onClick={() => onBackendAction("refresh")}
            type="button"
          >
            {pendingBackendAction === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          {backend.status !== "healthy" ? (
            <button
              className="button"
              data-backend-action={requiresInitialization ? "initialize" : "start"}
              disabled={startDisabled}
              onClick={() => onBackendAction(requiresInitialization ? "initialize" : "start")}
              type="button"
            >
              {pendingBackendAction === "initialize"
                ? "Initializing…"
                : pendingBackendAction === "start" || backend.status === "starting"
                  ? "Starting…"
                  : requiresInitialization
                    ? "Initialize K-Dense"
                    : backend.status === "failed"
                      ? "Retry backend"
                      : "Start backend"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function getEmptyStateCopy(trust: WorkspaceTrustState) {
  if (!trust.isTrusted) {
    return {
      title: "Sidebar chat is read-only in Restricted Mode",
      description: trust.summary,
    };
  }
  return {
    title: "What can I help you with?",
    description:
      "I can research topics, write code, analyze data, and delegate tasks to specialized agents.",
  };
}

function formatCountLabel(label: string, count: number, singular: string, plural: string) {
  if (count === 0) {
    return label;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

function MultiSelectControl<T extends { id: string; name: string; description?: string }>({
  controlLabel,
  items,
  selectedIds,
  onToggle,
  emptyMessage,
}: {
  controlLabel: string;
  items: T[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  emptyMessage: string;
}) {
  const selectedCount = selectedIds.length;
  return (
    <details className="composer-picker">
      <summary className="composer-picker__summary">
        <span className="composer-picker__label">
          {formatCountLabel(
            controlLabel,
            selectedCount,
            controlLabel.slice(0, -1).toLowerCase(),
            `${controlLabel.toLowerCase()}`,
          )}
        </span>
      </summary>
      <div className="composer-picker__menu">
        {items.length === 0 ? (
          <p className="composer-picker__empty">{emptyMessage}</p>
        ) : (
          <div className="composer-picker__list">
            {items.map((item) => {
              const selected = selectedIds.includes(item.id);
              return (
                <label className="composer-picker__option" key={item.id}>
                  <input
                    checked={selected}
                    onChange={() => onToggle(item.id)}
                    type="checkbox"
                  />
                  <span className="composer-picker__option-body">
                    <span className="composer-picker__option-title">{item.name}</span>
                    {item.description ? (
                      <span className="composer-picker__option-copy">{item.description}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

function ModelControl({
  selectedModelId,
  onChange,
}: {
  selectedModelId: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="composer-control composer-control--select" aria-label="Model selector">
      <select
        className="composer-control__select"
        data-model-select
        onChange={(event) => onChange(event.currentTarget.value)}
        value={selectedModelId}
      >
        {MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ComputeControl({
  modalConfigured,
  selectedComputeId,
  onChange,
}: {
  modalConfigured: boolean;
  selectedComputeId: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="composer-control composer-control--select" aria-label="Compute selector">
      <select
        className="composer-control__select"
        data-compute-select
        onChange={(event) => onChange(event.currentTarget.value)}
        value={selectedComputeId}
      >
        <option value={LOCAL_INSTANCE.id}>{LOCAL_INSTANCE.label}</option>
        {COMPUTE_INSTANCES.map((instance) => (
          <option disabled={!modalConfigured} key={instance.id} value={instance.id}>
            {instance.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TargetSelector({
  state,
  selectedTargetId,
  onTargetChange,
}: {
  state: SidebarScaffoldState;
  selectedTargetId?: string;
  onTargetChange: (value?: string) => void;
}) {
  return (
    <label
      aria-label="Workspace target selector"
      className="composer-control composer-control--select"
    >
      <select
        className="composer-control__select"
        data-workspace-target
        onChange={(event) => onTargetChange(event.currentTarget.value || undefined)}
        value={selectedTargetId ?? ""}
      >
        <option value="">Choose workspace folder…</option>
        {state.targetOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChatHeader({
  activeTab,
  onTabChange,
  provenanceCount,
  userTurns,
}: {
  activeTab: "chat" | "workflows" | "settings";
  onTabChange: (tab: "chat" | "workflows" | "settings") => void;
  provenanceCount: number;
  userTurns: number;
}) {
  return (
    <header aria-label="Chat header" className="chat-tabbar">
      <div className="chat-tablist" role="tablist" aria-label="Sidebar views">
        {([
          ["chat", "Chat"],
          ["workflows", "Workflows"],
          ["settings", "Settings"],
        ] as const).map(([tabId, label]) => (
          <button
            aria-selected={activeTab === tabId}
            className={`chat-tab${activeTab === tabId ? " chat-tab--active" : ""}`}
            data-sidebar-tab={tabId}
            key={tabId}
            onClick={() => onTabChange(tabId)}
            role="tab"
            type="button"
          >
            <span>{label}</span>
            {tabId === "chat" && userTurns > 0 ? <span className="chat-tab__badge">{userTurns}</span> : null}
          </button>
        ))}
      </div>
      <span className="chat-tab__meta">
        {activeTab === "chat"
          ? provenanceCount > 0
            ? `${provenanceCount} event${provenanceCount === 1 ? "" : "s"}`
            : userTurns > 0
              ? `${userTurns} turn${userTurns === 1 ? "" : "s"}`
              : "Ready to chat"
          : activeTab === "workflows"
            ? "Workflow launcher"
            : "Sidebar settings"}
      </span>
    </header>
  );
}

function getSendLabel(state: SidebarScaffoldState, pendingChatSend: boolean) {
  if (pendingChatSend) {
    return "Sending…";
  }
  if (!state.trust.capabilities.execute) {
    return "Trust required";
  }
  if (state.backend.requiresInitialization) {
    return "Initialize first";
  }
  if (state.backend.status !== "healthy") {
    return state.backend.status === "starting" ? "Starting…" : "Waiting…";
  }
  return "Send";
}

export function SidebarApp({
  state,
  pendingBackendAction,
  composerDraft,
  pendingChatSend,
  selectedTargetId,
  initialActiveTab = "chat",
  onComposerDraftChange,
  onTargetChange,
  onSend,
  onBackendAction,
  onSettingsUpdate,
}: SidebarAppProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "workflows" | "settings">(initialActiveTab);
  const [selectedModelId, setSelectedModelId] = useState(state.settings.defaultModelId);
  const [selectedDatabaseIds, setSelectedDatabaseIds] = useState<string[]>([]);
  const [selectedComputeId, setSelectedComputeId] = useState(state.settings.defaultComputeId);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedSkillIds((current) =>
      current.filter((id) => state.availableSkills.some((skill) => skill.id === id)),
    );
  }, [state.availableSkills]);

  useEffect(() => {
    setSelectedModelId(state.settings.defaultModelId);
    setSelectedComputeId(state.settings.defaultComputeId);
  }, [state.settings.defaultComputeId, state.settings.defaultModelId]);

  const selectedModel = useMemo<Model>(
    () => MODELS.find((model) => model.id === selectedModelId) ?? MODELS[0],
    [selectedModelId],
  );
  const selectedDatabases = useMemo<Database[]>(
    () => DATABASES.filter((database) => selectedDatabaseIds.includes(database.id)),
    [selectedDatabaseIds],
  );
  const selectedCompute = useMemo<ModalInstance | null>(() => {
    if (selectedComputeId === LOCAL_INSTANCE.id) {
      return null;
    }
    return COMPUTE_INSTANCES.find((instance) => instance.id === selectedComputeId) ?? null;
  }, [selectedComputeId]);
  const selectedSkills = useMemo(
    () => state.availableSkills.filter((skill) => selectedSkillIds.includes(skill.id)),
    [selectedSkillIds, state.availableSkills],
  );

  const showTargetSelector = shouldShowTargetSelector(state, selectedTargetId);
  const sendBlocked =
    pendingChatSend ||
    !state.trust.capabilities.execute ||
    state.backend.requiresInitialization ||
    state.backend.status !== "healthy" ||
    showTargetSelector;
  const sendDisabled = sendBlocked || composerDraft.trim().length === 0;
  const workflowLaunchReason = !state.trust.capabilities.execute
    ? "Trust the workspace to run workflows."
    : state.backend.requiresInitialization
      ? "Initialize K-Dense before running workflows."
      : state.backend.status !== "healthy"
        ? "Start the backend before running workflows."
        : showTargetSelector
          ? "Choose a workspace target before running workflows."
          : undefined;
  const userTurns = state.messages.filter((message) => message.role === "user").length;
  const emptyState = getEmptyStateCopy(state.trust);

  const handleToggleDatabase = (id: string) => {
    setSelectedDatabaseIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const handleToggleSkill = (id: string) => {
    setSelectedSkillIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const handleSend = () => {
    if (sendDisabled) {
      return;
    }

    onSend(
      createSidebarChatRequest({
        prompt: composerDraft,
        modelId: selectedModel.id,
        selectedDatabases,
        selectedCompute,
        selectedSkills,
      }),
    );
  };

  const handleWorkflowLaunch = (request: WorkflowLaunchRequest) => {
    if (sendBlocked) {
      return;
    }

    const workflowCompute =
      request.computeId === LOCAL_INSTANCE.id
        ? null
        : COMPUTE_INSTANCES.find((instance) => instance.id === request.computeId) ?? null;
    const workflowSkills = state.availableSkills.filter((skill) =>
      request.suggestedSkillIds.includes(skill.id),
    );

    setSelectedModelId(request.modelId);
    setSelectedComputeId(request.computeId);
    setSelectedSkillIds(request.suggestedSkillIds);
    setActiveTab("chat");

    onSend(
      createSidebarChatRequest({
        prompt: request.prompt,
        modelId: request.modelId,
        selectedDatabases,
        selectedCompute: workflowCompute,
        selectedSkills: workflowSkills,
      }),
    );
  };

  return (
    <main className="shell shell--sidebar">
      <section className="sidebar-chat">
        <ChatHeader
          activeTab={activeTab}
          onTabChange={setActiveTab}
          provenanceCount={state.settings.showProvenance ? state.provenance.length : 0}
          userTurns={userTurns}
        />
        <ServiceNotice
          onBackendAction={onBackendAction}
          pendingBackendAction={pendingBackendAction}
          selectedTargetId={selectedTargetId}
          state={state}
        />

        {activeTab === "chat" ? (
          <>
            <section aria-label="Kady chat" className="chat-panel" data-chat-region="transcript">
              <Conversation className={state.messages.length === 0 ? "conversation-frame--empty" : undefined}>
                {state.messages.length > 0 ? (
                  <ConversationContent>
                    {state.messages.map((message) => (
                      <Message from={message.role} key={message.id}>
                        <MessageContent>
                          <MessageResponse>{message.content}</MessageResponse>
                          {message.reasoning ? <MessageReasoning reasoning={message.reasoning} /> : null}
                          {message.chips && message.chips.length > 0 ? (
                            <div className="message__chips">
                              {message.chips.map((chip) => (
                                <span className="chip" key={`${message.id}:${chip}`}>
                                  {chip}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </MessageContent>
                        <span className="message__meta">
                          {message.role === "user" ? "You" : "Kady"} · {message.timestampLabel}
                        </span>
                      </Message>
                    ))}
                  </ConversationContent>
                ) : (
                  <ConversationEmptyState description={emptyState.description} title={emptyState.title} />
                )}
              </Conversation>
            </section>
            <section className="chat-footer-stack" aria-label="Chat footer">
              <div className="chat-footer-stack__composer">
                <PromptInput
                  aria-label="Chat composer"
                  data-chat-region="composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSend();
                  }}
                >
                  <div className="composer__body">
                    <div className="composer__surface">
                      <PromptInputTextarea
                        data-chat-input
                        disabled={pendingChatSend}
                        onChange={(event) => onComposerDraftChange(event.currentTarget.value)}
                        onSubmit={handleSend}
                        placeholder={state.composerPlaceholder}
                        value={composerDraft}
                      />
                    </div>
                  </div>
                  <PromptInputFooter>
                    <div className="composer__toolbar" aria-label="Composer controls" role="group">
                      <PromptInputTools className="composer__cluster composer__cluster--core">
                        <ModelControl onChange={setSelectedModelId} selectedModelId={selectedModelId} />
                        <ComputeControl
                          modalConfigured={state.modalConfigured}
                          onChange={setSelectedComputeId}
                          selectedComputeId={selectedComputeId}
                        />
                        {showTargetSelector ? (
                          <TargetSelector
                            onTargetChange={onTargetChange}
                            selectedTargetId={selectedTargetId}
                            state={state}
                          />
                        ) : null}
                      </PromptInputTools>
                      <PromptInputTools className="composer__cluster composer__cluster--context">
                        <MultiSelectControl
                          controlLabel="Data sources"
                          emptyMessage="No databases available."
                          items={DATABASES.map((database) => ({
                            id: database.id,
                            name: database.name,
                            description: database.description,
                          }))}
                          onToggle={handleToggleDatabase}
                          selectedIds={selectedDatabaseIds}
                        />
                        <MultiSelectControl
                          controlLabel="Skills"
                          emptyMessage="No skills available from the backend yet."
                          items={state.availableSkills.map((skill) => ({
                            id: skill.id,
                            name: skill.name,
                            description: skill.description,
                          }))}
                          onToggle={handleToggleSkill}
                          selectedIds={selectedSkillIds}
                        />
                      </PromptInputTools>
                    </div>
                    <div className="composer__meta">
                      <PromptInputSubmit
                        disabled={sendDisabled}
                        label={getSendLabel(state, pendingChatSend)}
                        onClick={handleSend}
                        pending={pendingChatSend}
                      />
                    </div>
                  </PromptInputFooter>
                </PromptInput>
              </div>
              {state.settings.showProvenance ? (
                <div className="chat-footer-stack__provenance">
                  <ProvenancePanel events={state.provenance} />
                </div>
              ) : null}
            </section>
          </>
        ) : activeTab === "workflows" ? (
          <section className="chat-panel chat-panel--workflows">
            <WorkflowsPanel
              availableSkills={state.availableSkills}
              currentComputeId={selectedComputeId}
              currentModelId={selectedModelId}
              launchDisabled={sendBlocked}
              launchDisabledReason={workflowLaunchReason}
              modalConfigured={state.modalConfigured}
              onLaunch={handleWorkflowLaunch}
            />
          </section>
        ) : (
          <section className="chat-panel chat-panel--settings">
            <SettingsPanel
              backendState={state.backend}
              computeOptions={[
                { id: LOCAL_INSTANCE.id, label: LOCAL_INSTANCE.label },
                ...COMPUTE_INSTANCES.map((instance) => ({
                  id: instance.id,
                  label: instance.label,
                  disabled: !state.modalConfigured,
                })),
              ]}
              globalSettings={state.globalSettings}
              secretMetadata={state.secretMetadata}
              modalConfigured={state.modalConfigured}
              modelOptions={MODELS.map((model) => ({ id: model.id, label: model.label }))}
              onBackendAction={onBackendAction}
              onSave={onSettingsUpdate}
              pendingBackendAction={pendingBackendAction}
              workspaceSettings={state.workspaceSettings}
            />
          </section>
        )}
      </section>
    </main>
  );
}

export function renderSidebarToStaticMarkup(props: SidebarAppProps) {
  return renderToStaticMarkup(<SidebarApp {...props} />);
}
