import type { BridgeStatePayload } from "./webview-bridge";
import type {
  BackendChatResult,
  BackendServiceState,
} from "./backend-service";
import {
  createDefaultSidebarSettings,
  createSidebarSessionState,
  type SidebarSecretMetadata,
  type SidebarSessionState,
  type SidebarSettingsState,
} from "./sidebar-persistence";
import type { WorkspaceTrustState } from "./workspace-trust";
import {
  createDefaultSidebarControlAvailability,
  type SidebarSkill,
} from "./sidebar-controls";

export type SidebarChatMessageRole = "user" | "assistant";

export type SidebarChatMessage = {
  id: string;
  role: SidebarChatMessageRole;
  content: string;
  timestampLabel: string;
  reasoning?: string;
  chips?: string[];
};

export type SidebarProvenanceEventType =
  | "user_query"
  | "delegation_start"
  | "tool_call"
  | "delegation_complete"
  | "assistant_response";

export type SidebarProvenanceChip = {
  label: string;
  value: string;
};

export type SidebarProvenanceEvent = {
  id: string;
  type: SidebarProvenanceEventType;
  label: string;
  detail: string;
  relativeTime: string;
  chips?: SidebarProvenanceChip[];
};

export type SidebarTargetOption = {
  id: string;
  name: string;
};

export type SidebarScaffoldState = {
  workspaceIdentity: string;
  heading: string;
  body: string;
  status: string;
  trust: WorkspaceTrustState;
  backend: BackendServiceState;
  settings: SidebarSettingsState;
  globalSettings: SidebarSettingsState;
  workspaceSettings?: SidebarSettingsState;
  secretMetadata: SidebarSecretMetadata;
  composerPlaceholder: string;
  composerHint: string;
  modalConfigured: boolean;
  availableSkills: SidebarSkill[];
  messages: SidebarChatMessage[];
  provenance: SidebarProvenanceEvent[];
  targetOptions: SidebarTargetOption[];
  selectedTargetId?: string;
  targetRequirement?: string;
};

type SidebarApplyChatOptions = {
  trustLabel: string;
  selectedTargetId?: string;
  targetOptions?: SidebarTargetOption[];
  targetRequirement?: string;
};

export function createSidebarScaffoldState(
  bridgeState: BridgeStatePayload,
  backend: BackendServiceState,
  options?: {
    workspaceIdentity?: string;
    session?: SidebarSessionState;
    settings?: SidebarSettingsState;
    targetOptions?: SidebarTargetOption[];
    selectedTargetId?: string;
    targetRequirement?: string;
    modalConfigured?: boolean;
    availableSkills?: SidebarSkill[];
    globalSettings?: SidebarSettingsState;
    workspaceSettings?: SidebarSettingsState;
    secretMetadata?: SidebarSecretMetadata;
  },
): SidebarScaffoldState {
  const defaultSession = createSidebarSessionState([], []);

  const targetOptions = options?.targetOptions ?? [];
  const selectedTargetId = options?.selectedTargetId;
  const targetRequirement = options?.targetRequirement;
  const controlAvailability = createDefaultSidebarControlAvailability();
  const defaultSettings = createDefaultSidebarSettings();

  return {
    workspaceIdentity: options?.workspaceIdentity ?? "workspace:unknown",
    heading: bridgeState.trust.isTrusted
      ? "Kady sidebar"
      : "Kady sidebar is in Restricted Mode",
    body: bridgeState.trust.isTrusted
      ? "Sidebar chat routes through the extension host and reused backend session contract."
      : "This workspace is untrusted, so the sidebar stays in a read-only posture and chat sending remains blocked until trust is granted.",
    status: bridgeState.message,
    trust: bridgeState.trust,
    backend,
    settings: options?.settings ?? defaultSettings,
    globalSettings: options?.globalSettings ?? defaultSettings,
    workspaceSettings: options?.workspaceSettings,
    secretMetadata: options?.secretMetadata ?? {
      hasGlobalOpenRouterApiKey: false,
      hasWorkspaceOpenRouterApiKey: false,
      effectiveOpenRouterApiKeyScope: null,
      hasGlobalParallelApiKey: false,
      hasWorkspaceParallelApiKey: false,
      effectiveParallelApiKeyScope: null,
      hasGlobalModalTokenId: false,
      hasWorkspaceModalTokenId: false,
      effectiveModalTokenIdScope: null,
      hasGlobalModalTokenSecret: false,
      hasWorkspaceModalTokenSecret: false,
      effectiveModalTokenSecretScope: null,
    },
    composerPlaceholder: bridgeState.trust.isTrusted
      ? "Ask Kady anything…"
      : "Trust this workspace to enable Kady chat…",
    composerHint: bridgeState.trust.isTrusted
      ? "Enter to send, Shift+Enter for a newline. All backend access stays host-mediated."
      : "Restricted Mode blocks chat send because the reused backend can trigger agent execution. Trust the workspace to enable Kady chat.",
    modalConfigured: options?.modalConfigured ?? controlAvailability.modalConfigured,
    availableSkills: options?.availableSkills ?? controlAvailability.availableSkills,
    messages: options?.session?.messages ?? defaultSession.messages,
    provenance: options?.session?.provenance ?? defaultSession.provenance,
    targetOptions,
    selectedTargetId,
    targetRequirement,
  };
}

export function applyBackendChatResultToSidebarState(
  state: SidebarScaffoldState,
  result: BackendChatResult,
  options: SidebarApplyChatOptions,
): SidebarScaffoldState {
  const stamp = Date.now();
  const userMessage: SidebarChatMessage = {
    id: `user-${stamp}`,
    role: "user",
    content: result.userText,
    timestampLabel: "Just now",
    chips: ["Workspace", options.trustLabel],
  };

  const assistantMessage: SidebarChatMessage = {
    id: `assistant-${stamp + 1}`,
    role: "assistant",
    content: result.assistantText,
    timestampLabel: "Just now",
    chips: [
      "Host bridge",
      ...(result.modelVersion ? [`Model ${result.modelVersion}`] : []),
    ],
  };

  const toolEvents: SidebarProvenanceEvent[] = result.toolEvents.map((event, index) => ({
    id: `prov-tool-${stamp}-${index}`,
    type:
      event.toolName === "delegate_task"
        ? event.stage === "call"
          ? "delegation_start"
          : "delegation_complete"
        : "tool_call",
    label: event.label,
    detail:
      event.detail ??
      "Host-mediated tool activity was captured from the backend stream.",
    relativeTime: "just now",
    chips: [
      { label: "Tool", value: event.toolName },
      { label: "Status", value: event.status },
    ],
  }));

  return {
    ...state,
    messages: [...state.messages, userMessage, assistantMessage],
    provenance: [
      ...state.provenance,
      {
        id: `prov-user-${stamp}`,
        type: "user_query",
        label: "User query",
        detail: result.userText,
        relativeTime: "just now",
        chips: [
          { label: "Surface", value: "sidebar" },
          { label: "Session", value: result.sessionId },
        ],
      },
      ...toolEvents,
      {
        id: `prov-assistant-${stamp + 1}`,
        type: "assistant_response",
        label: "Assistant response",
        detail: result.assistantText,
        relativeTime: "just now",
        chips: [
          ...(result.modelVersion
            ? [{ label: "Model", value: result.modelVersion }]
            : []),
          { label: "Trust", value: options.trustLabel },
        ],
      },
    ],
    selectedTargetId: options.selectedTargetId ?? state.selectedTargetId,
    targetOptions: options.targetOptions ?? state.targetOptions,
    targetRequirement: options.targetRequirement ?? state.targetRequirement,
  };
}
