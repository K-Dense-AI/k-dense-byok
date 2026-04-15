import type {
  SidebarChatMessage,
  SidebarProvenanceEvent,
} from "./sidebar-scaffold";
import { DEFAULT_MODEL, LOCAL_INSTANCE } from "../webview/chat-controls";

export const SIDEBAR_PERSISTENCE_VERSION = 1;
export const SIDEBAR_WORKSPACE_SNAPSHOT_KEY = "kdense.sidebar.workspaceSnapshot";
export const SIDEBAR_GLOBAL_SETTINGS_KEY = "kdense.sidebar.globalSettings";
export const SIDEBAR_WORKSPACE_SETTINGS_KEY = "kdense.sidebar.workspaceSettings";
export const SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY =
  "kdense.sidebar.secret.openRouterApiKey";
export const SIDEBAR_PARALLEL_API_KEY_SECRET_KEY =
  "kdense.sidebar.secret.parallelApiKey";
export const SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY =
  "kdense.sidebar.secret.modalTokenId";
export const SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY =
  "kdense.sidebar.secret.modalTokenSecret";

export type SidebarSessionState = {
  messages: SidebarChatMessage[];
  provenance: SidebarProvenanceEvent[];
};

export type SidebarSettingsState = {
  showReasoning: boolean;
  showProvenance: boolean;
  defaultModelId: string;
  defaultComputeId: string;
};

export type SidebarSecretValues = {
  globalOpenRouterApiKey?: string;
  workspaceOpenRouterApiKey?: string | null;
  globalParallelApiKey?: string;
  workspaceParallelApiKey?: string | null;
  globalModalTokenId?: string;
  workspaceModalTokenId?: string | null;
  globalModalTokenSecret?: string;
  workspaceModalTokenSecret?: string | null;
};

export type SidebarSecretMetadata = {
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

export type SidebarWorkspaceSnapshot = {
  version: typeof SIDEBAR_PERSISTENCE_VERSION;
  workspaceIdentity: string;
  updatedAt: string;
};

export type SidebarWindowState = {
  version: typeof SIDEBAR_PERSISTENCE_VERSION;
  workspaceIdentity: string;
  bridgeStatus?: string;
  session?: SidebarSessionState;
  settings?: SidebarSettingsState;
};

export function createDefaultSidebarSettings(): SidebarSettingsState {
  return {
    showReasoning: true,
    showProvenance: true,
    defaultModelId: DEFAULT_MODEL.id,
    defaultComputeId: LOCAL_INSTANCE.id,
  };
}

export function createSidebarSessionState(
  messages: SidebarChatMessage[],
  provenance: SidebarProvenanceEvent[],
): SidebarSessionState {
  return {
    messages: messages.map(cloneMessage),
    provenance: provenance.map(cloneProvenanceEvent),
  };
}

export function cloneSidebarSettings(
  settings: SidebarSettingsState,
): SidebarSettingsState {
  return {
    showReasoning: settings.showReasoning,
    showProvenance: settings.showProvenance,
    defaultModelId: settings.defaultModelId,
    defaultComputeId: settings.defaultComputeId,
  };
}

export function createSidebarWindowState(options: {
  workspaceIdentity: string;
  bridgeStatus?: string;
  session?: SidebarSessionState;
  settings?: SidebarSettingsState;
}): SidebarWindowState {
  return {
    version: SIDEBAR_PERSISTENCE_VERSION,
    workspaceIdentity: options.workspaceIdentity,
    bridgeStatus: options.bridgeStatus,
    session: options.session
      ? createSidebarSessionState(
          options.session.messages,
          options.session.provenance,
        )
      : undefined,
    settings: options.settings
      ? cloneSidebarSettings(options.settings)
      : undefined,
  };
}

export function isSidebarSettingsState(
  value: unknown,
): value is SidebarSettingsState {
  return (
    isRecord(value) &&
    typeof value.showReasoning === "boolean" &&
    typeof value.showProvenance === "boolean" &&
    typeof value.defaultModelId === "string" &&
    value.defaultModelId.length > 0 &&
    typeof value.defaultComputeId === "string" &&
    value.defaultComputeId.length > 0
  );
}

export function isSidebarSessionState(value: unknown): value is SidebarSessionState {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.provenance)
  );
}

export function isSidebarWorkspaceSnapshot(
  value: unknown,
): value is SidebarWorkspaceSnapshot {
  return (
    isRecord(value) &&
    value.version === SIDEBAR_PERSISTENCE_VERSION &&
    typeof value.workspaceIdentity === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function isSidebarWindowState(value: unknown): value is SidebarWindowState {
  return (
    isRecord(value) &&
    value.version === SIDEBAR_PERSISTENCE_VERSION &&
    typeof value.workspaceIdentity === "string" &&
    (value.bridgeStatus === undefined || typeof value.bridgeStatus === "string") &&
    (value.session === undefined || isSidebarSessionState(value.session)) &&
    (value.settings === undefined || isSidebarSettingsState(value.settings))
  );
}

function cloneMessage(message: SidebarChatMessage): SidebarChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestampLabel: message.timestampLabel,
    reasoning: message.reasoning,
    chips: message.chips ? [...message.chips] : undefined,
  };
}

function cloneProvenanceEvent(
  event: SidebarProvenanceEvent,
): SidebarProvenanceEvent {
  return {
    id: event.id,
    type: event.type,
    label: event.label,
    detail: event.detail,
    relativeTime: event.relativeTime,
    chips: event.chips
      ? event.chips.map((chip) => ({
          label: chip.label,
          value: chip.value,
        }))
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
