export const BACKEND_HEALTH_PATH = "/health";

export type BackendServiceStatus =
  | "unavailable"
  | "starting"
  | "healthy"
  | "failed";

export type BackendExecutionLocation = "desktop" | "remote";

export type BackendServiceAction = "refresh" | "start" | "initialize" | "stop";

export type BackendChatToolEvent = {
  id: string;
  stage: "call" | "response";
  toolName: string;
  label: string;
  detail?: string;
  status: "running" | "complete" | "error";
};

export type BackendChatResult = {
  userText: string;
  assistantText: string;
  sessionId: string;
  modelVersion?: string;
  toolEvents: BackendChatToolEvent[];
};

export type BackendServiceState = {
  status: BackendServiceStatus;
  statusLabel: string;
  detail: string;
  baseUrl: string;
  executionLocation: BackendExecutionLocation;
  requiresInitialization?: boolean;
  skillsReady?: boolean;
  workspaceRootLabel?: string;
  lastCheckedAt?: string;
};

export function createBackendServiceState(
  status: BackendServiceStatus,
  options: {
    detail: string;
    baseUrl: string;
    executionLocation: BackendExecutionLocation;
    requiresInitialization?: boolean;
    skillsReady?: boolean;
    workspaceRootLabel?: string;
    checkedAt?: Date;
  },
): BackendServiceState {
  return {
    status,
    statusLabel: getBackendServiceStatusLabel(status),
    detail: options.detail,
    baseUrl: trimTrailingSlash(options.baseUrl),
    executionLocation: options.executionLocation,
    requiresInitialization: options.requiresInitialization,
    skillsReady: options.skillsReady,
    workspaceRootLabel: options.workspaceRootLabel,
    lastCheckedAt: options.checkedAt?.toISOString(),
  };
}

export function getBackendServiceStatusLabel(status: BackendServiceStatus) {
  switch (status) {
    case "unavailable":
      return "Unavailable";
    case "starting":
      return "Starting";
    case "healthy":
      return "Healthy";
    case "failed":
      return "Failed";
  }
}

export function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
