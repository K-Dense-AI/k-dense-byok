import type {
  BackendServiceAction,
  BackendServiceState,
} from "./backend-service";
import type { SidebarScaffoldState } from "./sidebar-scaffold";
import type { SidebarSkill } from "./sidebar-controls";
import { isSidebarSettingsState, isSidebarWindowState, type SidebarSettingsState, type SidebarWindowState } from "./sidebar-persistence";
import {
  createWorkspaceTrustState,
  type WorkspaceTrustState,
} from "./workspace-trust";

export const BRIDGE_VERSION = 1;

export type WebviewSurface = "sidebar" | "preview";

export type BridgeRequestType =
  | "bridge.ready"
  | "sidebar.bootstrap"
  | "sidebar.backend.action"
  | "sidebar.chat.send"
  | "sidebar.settings.update"
  | "preview.latex.compile";
export type BridgeEventType = "bridge.state" | "sidebar.backend.state" | "preview.latex.state";

export type BridgeErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_PAYLOAD"
  | "UNKNOWN_MESSAGE_TYPE"
  | "UNSUPPORTED_VERSION"
  | "SURFACE_MISMATCH"
  | "CAPABILITY_DENIED"
  | "BACKEND_ACTION_FAILED";

export type BridgeReadyRequestPayload = {
  surface: WebviewSurface;
};

export type SidebarBootstrapRequestPayload = {
  surface: "sidebar";
  restoreState?: SidebarWindowState;
};

export type SidebarBackendActionRequestPayload = {
  surface: "sidebar";
  action: BackendServiceAction;
  workspaceTargetId?: string;
};

export type SidebarChatSendRequestPayload = {
  surface: "sidebar";
  text: string;
  workspaceTargetId?: string;
  modelId?: string;
};


export type SidebarSettingsUpdateRequestPayload = {
  surface: "sidebar";
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

export type PreviewLatexCompileEngine = "pdflatex" | "xelatex" | "lualatex";

export type PreviewLatexCompileRequestPayload = {
  surface: "preview";
  engine: PreviewLatexCompileEngine;
};

export type PreviewLatexCompileResponsePayload = {
  success: boolean;
  engine: PreviewLatexCompileEngine;
  command: string;
  commandLine: string;
  statusMessage: string;
  stdout: string;
  stderr: string;
  log: string;
  pdfUri?: string;
};

export type PreviewLatexCompileTrigger = "auto" | "manual";

export type PreviewLatexStateEventPayload =
  | {
      phase: "running";
      trigger: PreviewLatexCompileTrigger;
      engine: PreviewLatexCompileEngine;
      statusMessage: string;
      commandLine?: string;
      log?: string;
    }
  | ({
      phase: "completed";
      trigger: PreviewLatexCompileTrigger;
    } & PreviewLatexCompileResponsePayload);

export type BridgeStatePayload = {
  surface: WebviewSurface;
  connected: true;
  trust: WorkspaceTrustState;
  message: string;
};

export type BridgeRequestPayloadMap = {
  "bridge.ready": BridgeReadyRequestPayload;
  "sidebar.bootstrap": SidebarBootstrapRequestPayload;
  "sidebar.backend.action": SidebarBackendActionRequestPayload;
  "sidebar.chat.send": SidebarChatSendRequestPayload;
  "sidebar.settings.update": SidebarSettingsUpdateRequestPayload;
  "preview.latex.compile": PreviewLatexCompileRequestPayload;
};

export type BridgeResponsePayloadMap = {
  "bridge.ready": BridgeStatePayload;
  "sidebar.bootstrap": SidebarScaffoldState;
  "sidebar.backend.action": BackendServiceState;
  "sidebar.chat.send": SidebarScaffoldState;
  "sidebar.settings.update": SidebarScaffoldState;
  "preview.latex.compile": PreviewLatexCompileResponsePayload;
};

export type BridgeEventPayloadMap = {
  "bridge.state": BridgeStatePayload;
  "sidebar.backend.state": BackendServiceState;
  "preview.latex.state": PreviewLatexStateEventPayload;
};

type BridgeEnvelope = {
  version: typeof BRIDGE_VERSION;
};

export type BridgeRequestMessage<T extends BridgeRequestType = BridgeRequestType> =
  BridgeEnvelope & {
    kind: "request";
    requestId: string;
    type: T;
    payload: BridgeRequestPayloadMap[T];
  };

type BridgeResponseBase<T extends BridgeRequestType = BridgeRequestType> =
  BridgeEnvelope & {
    kind: "response";
    requestId: string;
    type: T;
  };

export type BridgeSuccessResponse<T extends BridgeRequestType = BridgeRequestType> =
  BridgeResponseBase<T> & {
    ok: true;
    payload: BridgeResponsePayloadMap[T];
  };

export type BridgeErrorResponse = BridgeResponseBase & {
  ok: false;
  error: {
    code: BridgeErrorCode;
    message: string;
  };
};

export type BridgeResponseMessage = BridgeSuccessResponse | BridgeErrorResponse;

export type BridgeEventMessage<T extends BridgeEventType = BridgeEventType> =
  BridgeEnvelope & {
    kind: "event";
    type: T;
    payload: BridgeEventPayloadMap[T];
  };

export type HostToWebviewMessage = BridgeResponseMessage | BridgeEventMessage;
export type WebviewToHostMessage = BridgeRequestMessage;

type ParseSuccess<T> = {
  ok: true;
  value: T;
};

type ParseFailure = {
  ok: false;
  error: {
    code: BridgeErrorCode;
    message: string;
  };
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export function parseWebviewMessage(
  input: unknown,
): ParseResult<WebviewToHostMessage> {
  if (!isRecord(input)) {
    return invalidMessage("Bridge messages must be objects.");
  }

  if (input.version !== BRIDGE_VERSION) {
    return invalidVersion(input.version);
  }

  if (input.kind !== "request") {
    return invalidMessage("Webview bridge messages must use kind 'request'.");
  }

  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    return invalidMessage("Bridge requestId must be a non-empty string.");
  }

  if (typeof input.type !== "string") {
    return invalidMessage("Bridge request type must be a string.");
  }

  switch (input.type) {
    case "bridge.ready": {
      if (!isBridgeReadyPayload(input.payload)) {
        return invalidPayload("bridge.ready payload must include a valid surface.");
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    case "sidebar.bootstrap": {
      if (!isSidebarBootstrapPayload(input.payload)) {
        return invalidPayload(
          "sidebar.bootstrap payload must target the sidebar surface.",
        );
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    case "sidebar.backend.action": {
      if (!isSidebarBackendActionPayload(input.payload)) {
        return invalidPayload(
          "sidebar.backend.action payload must target the sidebar surface and use a supported backend action.",
        );
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    case "sidebar.chat.send": {
      if (!isSidebarChatSendPayload(input.payload)) {
        return invalidPayload(
          "sidebar.chat.send payload must target the sidebar surface and include non-empty text.",
        );
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    case "sidebar.settings.update": {
      if (!isSidebarSettingsUpdatePayload(input.payload)) {
        return invalidPayload(
          "sidebar.settings.update payload must target the sidebar surface and use supported settings values.",
        );
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    case "preview.latex.compile": {
      if (!isPreviewLatexCompilePayload(input.payload)) {
        return invalidPayload(
          "preview.latex.compile payload must target the preview surface and include a supported engine.",
        );
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "request",
          requestId: input.requestId,
          type: input.type,
          payload: input.payload,
        },
      };
    }
    default:
      return {
        ok: false,
        error: {
          code: "UNKNOWN_MESSAGE_TYPE",
          message: `Unsupported bridge request type '${input.type}'.`,
        },
      };
  }
}

export function parseHostMessage(
  input: unknown,
): ParseResult<HostToWebviewMessage> {
  if (!isRecord(input)) {
    return invalidMessage("Bridge messages must be objects.");
  }

  if (input.version !== BRIDGE_VERSION) {
    return invalidVersion(input.version);
  }

  if (input.kind === "event") {
    if (input.type === "bridge.state") {
      if (!isBridgeStatePayload(input.payload)) {
        return invalidPayload("bridge.state payload is invalid.");
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "event",
          type: "bridge.state",
          payload: input.payload,
        },
      };
    }

    if (input.type === "sidebar.backend.state") {
      if (!isBackendServiceState(input.payload)) {
        return invalidPayload("sidebar.backend.state payload is invalid.");
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "event",
          type: "sidebar.backend.state",
          payload: input.payload,
        },
      };
    }

    if (input.type === "preview.latex.state") {
      if (!isPreviewLatexStateEventPayload(input.payload)) {
        return invalidPayload("preview.latex.state payload is invalid.");
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "event",
          type: "preview.latex.state",
          payload: input.payload,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "UNKNOWN_MESSAGE_TYPE",
        message: `Unsupported bridge event type '${String(input.type)}'.`,
      },
    };
  }

  if (input.kind === "response") {
    if (typeof input.requestId !== "string" || input.requestId.length === 0) {
      return invalidMessage("Bridge response requestId must be a non-empty string.");
    }

    if (
      input.type !== "bridge.ready" &&
      input.type !== "sidebar.bootstrap" &&
      input.type !== "sidebar.backend.action" &&
      input.type !== "sidebar.chat.send" &&
      input.type !== "sidebar.settings.update" &&
      input.type !== "preview.latex.compile"
    ) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_MESSAGE_TYPE",
          message: `Unsupported bridge response type '${String(input.type)}'.`,
        },
      };
    }

    if (input.ok === true) {
      if (input.type === "bridge.ready") {
        if (!isBridgeStatePayload(input.payload)) {
          return invalidPayload("Successful bridge response payload is invalid.");
        }

        return {
          ok: true,
          value: {
            version: BRIDGE_VERSION,
            kind: "response",
            requestId: input.requestId,
            type: "bridge.ready",
            ok: true,
            payload: input.payload,
          },
        };
      }

      if (input.type === "sidebar.bootstrap") {
        if (!isSidebarScaffoldState(input.payload)) {
          return invalidPayload("Successful sidebar response payload is invalid.");
        }

        return {
          ok: true,
          value: {
            version: BRIDGE_VERSION,
            kind: "response",
            requestId: input.requestId,
            type: "sidebar.bootstrap",
            ok: true,
            payload: input.payload,
          },
        };
      }

      if (input.type === "sidebar.chat.send") {
        if (!isSidebarScaffoldState(input.payload)) {
          return invalidPayload("Successful chat response payload is invalid.");
        }

        return {
          ok: true,
          value: {
            version: BRIDGE_VERSION,
            kind: "response",
            requestId: input.requestId,
            type: "sidebar.chat.send",
            ok: true,
            payload: input.payload,
          },
        };
      }

      if (input.type === "sidebar.settings.update") {
        if (!isSidebarScaffoldState(input.payload)) {
          return invalidPayload("Successful settings response payload is invalid.");
        }

        return {
          ok: true,
          value: {
            version: BRIDGE_VERSION,
            kind: "response",
            requestId: input.requestId,
            type: "sidebar.settings.update",
            ok: true,
            payload: input.payload,
          },
        };
      }

      if (input.type === "preview.latex.compile") {
        if (!isPreviewLatexCompileResponsePayload(input.payload)) {
          return invalidPayload("Successful preview compile response payload is invalid.");
        }

        return {
          ok: true,
          value: {
            version: BRIDGE_VERSION,
            kind: "response",
            requestId: input.requestId,
            type: "preview.latex.compile",
            ok: true,
            payload: input.payload,
          },
        };
      }

      if (!isBackendServiceState(input.payload)) {
        return invalidPayload("Successful backend response payload is invalid.");
      }

      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "response",
          requestId: input.requestId,
          type: "sidebar.backend.action",
          ok: true,
          payload: input.payload,
        },
      };
    }

    if (
      input.ok === false &&
      isRecord(input.error) &&
      typeof input.error.code === "string" &&
      typeof input.error.message === "string"
    ) {
      return {
        ok: true,
        value: {
          version: BRIDGE_VERSION,
          kind: "response",
          requestId: input.requestId,
          type: input.type,
          ok: false,
          error: {
            code: input.error.code as BridgeErrorCode,
            message: input.error.message,
          },
        },
      };
    }

    return invalidPayload("Errored bridge response payload is invalid.");
  }

  return invalidMessage("Bridge messages must use kind 'response' or 'event'.");
}

export function createBridgeState(
  surface: WebviewSurface,
  trust: WorkspaceTrustState = createWorkspaceTrustState(true),
): BridgeStatePayload {
  return {
    surface,
    connected: true,
    trust,
    message:
      surface === "sidebar"
        ? `Sidebar bridge connected. ${trust.statusLabel} is active for host-backed actions.`
        : `Preview bridge connected. ${trust.statusLabel} is active for host-backed preview flows.`,
  };
}

export function createSuccessResponse<T extends BridgeRequestType>(
  request: BridgeRequestMessage<T>,
  payload: BridgeResponsePayloadMap[T],
): BridgeSuccessResponse<T> {
  return {
    version: BRIDGE_VERSION,
    kind: "response",
    requestId: request.requestId,
    type: request.type,
    ok: true,
    payload,
  };
}

export function createErrorResponse(
  requestId: string,
  type: BridgeRequestType,
  code: BridgeErrorCode,
  message: string,
): BridgeErrorResponse {
  return {
    version: BRIDGE_VERSION,
    kind: "response",
    requestId,
    type,
    ok: false,
    error: {
      code,
      message,
    },
  };
}

export function createStateEvent(
  payload: BridgeStatePayload,
): BridgeEventMessage<"bridge.state"> {
  return {
    version: BRIDGE_VERSION,
    kind: "event",
    type: "bridge.state",
    payload,
  };
}

export function createBackendStateEvent(
  payload: BackendServiceState,
): BridgeEventMessage<"sidebar.backend.state"> {
  return {
    version: BRIDGE_VERSION,
    kind: "event",
    type: "sidebar.backend.state",
    payload,
  };
}

export function createPreviewLatexStateEvent(
  payload: PreviewLatexStateEventPayload,
): BridgeEventMessage<"preview.latex.state"> {
  return {
    version: BRIDGE_VERSION,
    kind: "event",
    type: "preview.latex.state",
    payload,
  };
}

function isBridgeReadyPayload(value: unknown): value is BridgeReadyRequestPayload {
  return isRecord(value) && isSurface(value.surface);
}

function isSidebarBootstrapPayload(
  value: unknown,
): value is SidebarBootstrapRequestPayload {
  return (
    isRecord(value) &&
    value.surface === "sidebar" &&
    (value.restoreState === undefined || isSidebarWindowState(value.restoreState))
  );
}

function isSidebarBackendActionPayload(
  value: unknown,
): value is SidebarBackendActionRequestPayload {
  return (
    isRecord(value) &&
    value.surface === "sidebar" &&
      (value.action === "refresh" || value.action === "start" || value.action === "initialize" || value.action === "stop") &&
    (value.workspaceTargetId === undefined ||
      (typeof value.workspaceTargetId === "string" && value.workspaceTargetId.length > 0)) &&
    (value.modelId === undefined ||
      (typeof value.modelId === "string" && value.modelId.length > 0))
  );
}

function isSidebarChatSendPayload(
  value: unknown,
): value is SidebarChatSendRequestPayload {
  return (
    isRecord(value) &&
    value.surface === "sidebar" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    (value.workspaceTargetId === undefined ||
      (typeof value.workspaceTargetId === "string" && value.workspaceTargetId.length > 0)) &&
    (value.modelId === undefined ||
      (typeof value.modelId === "string" && value.modelId.length > 0))
  );
}


function isSidebarSettingsUpdatePayload(
  value: unknown,
): value is SidebarSettingsUpdateRequestPayload {
  return (
    isRecord(value) &&
    value.surface === "sidebar" &&
    (value.globalSettings === undefined || isSidebarSettingsState(value.globalSettings)) &&
    (value.workspaceSettings === undefined || value.workspaceSettings === null || isSidebarSettingsState(value.workspaceSettings)) &&
    (value.globalOpenRouterApiKey === undefined || typeof value.globalOpenRouterApiKey === "string") &&
    (value.workspaceOpenRouterApiKey === undefined || value.workspaceOpenRouterApiKey === null || typeof value.workspaceOpenRouterApiKey === "string") &&
    (value.globalParallelApiKey === undefined || typeof value.globalParallelApiKey === "string") &&
    (value.workspaceParallelApiKey === undefined || value.workspaceParallelApiKey === null || typeof value.workspaceParallelApiKey === "string") &&
    (value.globalModalTokenId === undefined || typeof value.globalModalTokenId === "string") &&
    (value.workspaceModalTokenId === undefined || value.workspaceModalTokenId === null || typeof value.workspaceModalTokenId === "string") &&
    (value.globalModalTokenSecret === undefined || typeof value.globalModalTokenSecret === "string") &&
    (value.workspaceModalTokenSecret === undefined || value.workspaceModalTokenSecret === null || typeof value.workspaceModalTokenSecret === "string")
  );
}

function isPreviewLatexCompilePayload(
  value: unknown,
): value is PreviewLatexCompileRequestPayload {
  return (
    isRecord(value) &&
    value.surface === "preview" &&
    (value.engine === "pdflatex" || value.engine === "xelatex" || value.engine === "lualatex")
  );
}

function isBridgeStatePayload(value: unknown): value is BridgeStatePayload {
  return (
    isRecord(value) &&
    isSurface(value.surface) &&
    value.connected === true &&
    isWorkspaceTrustState(value.trust) &&
    typeof value.message === "string"
  );
}

function isWorkspaceTrustState(value: unknown): value is WorkspaceTrustState {
  return (
    isRecord(value) &&
    typeof value.isTrusted === "boolean" &&
    (value.mode === "trusted" || value.mode === "restricted") &&
    typeof value.statusLabel === "string" &&
    typeof value.summary === "string" &&
    typeof value.detail === "string" &&
    isWorkspaceCapabilityMatrix(value.capabilities) &&
    isWorkspaceCapabilityList(value.allowedCapabilities) &&
    isWorkspaceCapabilityList(value.blockedCapabilities)
  );
}

function isWorkspaceCapabilityMatrix(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.readOnlyUi === "boolean" &&
    typeof value.previewOpen === "boolean" &&
    typeof value.write === "boolean" &&
    typeof value.execute === "boolean" &&
    typeof value.backendStart === "boolean" &&
    typeof value.secretSensitive === "boolean"
  );
}

function isWorkspaceCapabilityList(value: unknown) {
  return Array.isArray(value) && value.every(isWorkspaceCapability);
}

function isWorkspaceCapability(value: unknown) {
  return (
    value === "readOnlyUi" ||
    value === "previewOpen" ||
    value === "write" ||
    value === "execute" ||
    value === "backendStart" ||
    value === "secretSensitive"
  );
}

function isBackendServiceState(value: unknown): value is BackendServiceState {
  return (
    isRecord(value) &&
    isBackendServiceStatus(value.status) &&
    typeof value.statusLabel === "string" &&
    typeof value.detail === "string" &&
    typeof value.baseUrl === "string" &&
    (value.executionLocation === "desktop" || value.executionLocation === "remote") &&
    (value.requiresInitialization === undefined || typeof value.requiresInitialization === "boolean") &&
    (value.skillsReady === undefined || typeof value.skillsReady === "boolean") &&
    (value.workspaceRootLabel === undefined || typeof value.workspaceRootLabel === "string") &&
    (value.lastCheckedAt === undefined || typeof value.lastCheckedAt === "string")
  );
}

function isPreviewLatexCompileResponsePayload(
  value: unknown,
): value is PreviewLatexCompileResponsePayload {
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    (value.engine === "pdflatex" || value.engine === "xelatex" || value.engine === "lualatex") &&
    typeof value.command === "string" &&
    typeof value.commandLine === "string" &&
    typeof value.statusMessage === "string" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.log === "string" &&
    (value.pdfUri === undefined || typeof value.pdfUri === "string")
  );
}

function isPreviewLatexStateEventPayload(
  value: unknown,
): value is PreviewLatexStateEventPayload {
  if (!isRecord(value)) {
    return false;
  }

  if (value.phase === "running") {
    return (
      (value.trigger === "auto" || value.trigger === "manual") &&
      (value.engine === "pdflatex" || value.engine === "xelatex" || value.engine === "lualatex") &&
      typeof value.statusMessage === "string" &&
      (value.commandLine === undefined || typeof value.commandLine === "string") &&
      (value.log === undefined || typeof value.log === "string")
    );
  }

  if (value.phase === "completed") {
    return (
      (value.trigger === "auto" || value.trigger === "manual") &&
      isPreviewLatexCompileResponsePayload(value)
    );
  }

  return false;
}

function isBackendServiceStatus(value: unknown) {
  return (
    value === "unavailable" ||
    value === "starting" ||
    value === "healthy" ||
    value === "failed"
  );
}

function isSidebarScaffoldState(value: unknown): value is SidebarScaffoldState {
  return (
    isRecord(value) &&
    typeof value.workspaceIdentity === "string" &&
    typeof value.heading === "string" &&
    typeof value.body === "string" &&
    typeof value.status === "string" &&
    isBackendServiceState(value.backend) &&
    isSidebarSettingsState(value.settings) &&
    isSidebarSettingsState(value.globalSettings) &&
    (value.workspaceSettings === undefined || isSidebarSettingsState(value.workspaceSettings)) &&
    isSidebarSecretMetadata(value.secretMetadata) &&
    typeof value.modalConfigured === "boolean" &&
    Array.isArray(value.availableSkills) &&
    value.availableSkills.every(isSidebarSkill) &&
    typeof value.composerPlaceholder === "string" &&
    typeof value.composerHint === "string" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.provenance)
  );
}


function isSidebarSecretMetadata(value: unknown): value is { hasGlobalOpenRouterApiKey: boolean; hasWorkspaceOpenRouterApiKey: boolean; effectiveOpenRouterApiKeyScope: "workspace" | "global" | null } {
  return (
    isRecord(value) &&
    typeof value.hasGlobalOpenRouterApiKey === "boolean" &&
    typeof value.hasWorkspaceOpenRouterApiKey === "boolean" &&
    (value.effectiveOpenRouterApiKeyScope === "workspace" ||
      value.effectiveOpenRouterApiKeyScope === "global" ||
      value.effectiveOpenRouterApiKeyScope === null) &&
    typeof value.hasGlobalParallelApiKey === "boolean" &&
    typeof value.hasWorkspaceParallelApiKey === "boolean" &&
    (value.effectiveParallelApiKeyScope === "workspace" ||
      value.effectiveParallelApiKeyScope === "global" ||
      value.effectiveParallelApiKeyScope === null) &&
    typeof value.hasGlobalModalTokenId === "boolean" &&
    typeof value.hasWorkspaceModalTokenId === "boolean" &&
    (value.effectiveModalTokenIdScope === "workspace" ||
      value.effectiveModalTokenIdScope === "global" ||
      value.effectiveModalTokenIdScope === null) &&
    typeof value.hasGlobalModalTokenSecret === "boolean" &&
    typeof value.hasWorkspaceModalTokenSecret === "boolean" &&
    (value.effectiveModalTokenSecretScope === "workspace" ||
      value.effectiveModalTokenSecretScope === "global" ||
      value.effectiveModalTokenSecretScope === null)
  );
}

function isSidebarSkill(value: unknown): value is SidebarSkill {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.author === "string" &&
    typeof value.license === "string" &&
    typeof value.compatibility === "string"
  );
}

function isSurface(value: unknown): value is WebviewSurface {
  return value === "sidebar" || value === "preview";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidMessage(message: string): ParseFailure {
  return {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message,
    },
  };
}

function invalidPayload(message: string): ParseFailure {
  return {
    ok: false,
    error: {
      code: "INVALID_PAYLOAD",
      message,
    },
  };
}

function invalidVersion(version: unknown): ParseFailure {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED_VERSION",
      message: `Unsupported bridge version '${String(version)}'. Expected ${BRIDGE_VERSION}.`,
    },
  };
}
