import type { BackendServiceAction } from "../shared/backend-service";
import type {
  SidebarBackendActionRequestPayload,
  SidebarChatSendRequestPayload,
  SidebarSettingsUpdateRequestPayload,
} from "../shared/webview-bridge";
import type { SidebarSettingsState } from "../shared/sidebar-persistence";

export function createSidebarBackendActionPayload(
  action: BackendServiceAction,
  workspaceTargetId?: string,
): SidebarBackendActionRequestPayload {
  return {
    surface: "sidebar",
    action,
    workspaceTargetId,
  };
}

export function createSidebarChatSendPayload(
  text: string,
  workspaceTargetId?: string,
  modelId?: string,
): SidebarChatSendRequestPayload {
  return {
    surface: "sidebar",
    text,
    workspaceTargetId,
    modelId,
  };
}

export function createSidebarSettingsUpdatePayload(options: {
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
}): SidebarSettingsUpdateRequestPayload {
  return {
    surface: "sidebar",
    globalSettings: options.globalSettings,
    workspaceSettings: options.workspaceSettings,
    globalOpenRouterApiKey: options.globalOpenRouterApiKey,
    workspaceOpenRouterApiKey: options.workspaceOpenRouterApiKey,
    globalParallelApiKey: options.globalParallelApiKey,
    workspaceParallelApiKey: options.workspaceParallelApiKey,
    globalModalTokenId: options.globalModalTokenId,
    workspaceModalTokenId: options.workspaceModalTokenId,
    globalModalTokenSecret: options.globalModalTokenSecret,
    workspaceModalTokenSecret: options.workspaceModalTokenSecret,
  };
}
