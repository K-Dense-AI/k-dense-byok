import * as vscode from "vscode";
import type { BackendServiceAdapter } from "./backend-service-adapter";
import type { LatexCompileSummary } from "./latex-compile";
import { createBackendServiceState } from "../shared/backend-service";
import {
  createWorkspaceCapabilityDeniedMessage,
  ensureWorkspaceCapability,
  getCurrentWorkspaceTrustState,
  type WorkspaceTrustDependencies,
} from "./workspace-trust";
import { createSidebarScaffoldState } from "../shared/sidebar-scaffold";
import {
  BRIDGE_VERSION,
  type BridgeErrorCode,
  type BridgeRequestMessage,
  type SidebarBootstrapRequestPayload,
  type SidebarChatSendRequestPayload,
  type SidebarSettingsUpdateRequestPayload,
  type PreviewLatexCompileRequestPayload,
  createBackendStateEvent,
  createBridgeState,
  createErrorResponse,
  createStateEvent,
  createSuccessResponse,
  parseWebviewMessage,
  type BridgeRequestPayloadMap,
  type WebviewSurface,
} from "../shared/webview-bridge";

type BridgeBackendAdapter = Pick<
  BackendServiceAdapter,
  "getState" | "refreshStatus" | "initializeWorkspace" | "startBackend"
>;

type BridgeRouterOptions = {
  getSidebarScaffoldState?:
    | ((payload: SidebarBootstrapRequestPayload) => ReturnType<typeof createSidebarScaffoldState>)
    | ((payload: SidebarBootstrapRequestPayload) => Promise<ReturnType<typeof createSidebarScaffoldState>>);
  handleSidebarChatSend?:
    | ((payload: SidebarChatSendRequestPayload) => ReturnType<typeof createSidebarScaffoldState>)
    | ((payload: SidebarChatSendRequestPayload) => Promise<ReturnType<typeof createSidebarScaffoldState>>);
  handleSidebarSettingsUpdate?:
    | ((payload: SidebarSettingsUpdateRequestPayload) => ReturnType<typeof createSidebarScaffoldState>)
    | ((payload: SidebarSettingsUpdateRequestPayload) => Promise<ReturnType<typeof createSidebarScaffoldState>>);
  getBridgeState?: (surface: WebviewSurface) => ReturnType<typeof createBridgeState>;
  backendAdapter?: BridgeBackendAdapter;
  handlePreviewLatexCompile?:
    | ((payload: PreviewLatexCompileRequestPayload) => Promise<LatexCompileSummary>)
    | ((payload: PreviewLatexCompileRequestPayload) => LatexCompileSummary);
  workspaceTrustDependencies?: WorkspaceTrustDependencies;
};

type BridgePostMessageTarget = {
  postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean;
  onDidReceiveMessage?(listener: (message: unknown) => void): vscode.Disposable;
};

export function attachWebviewBridgeRouter(
  webview: vscode.Webview,
  surface: WebviewSurface,
  options?: BridgeRouterOptions,
): vscode.Disposable {
  return createWebviewBridgeRouter(webview, surface, options);
}

export function createWebviewBridgeRouter(
  target: BridgePostMessageTarget,
  surface: WebviewSurface,
  options?: BridgeRouterOptions,
): vscode.Disposable {
  const listener = async (rawMessage: unknown) => {
    await handleBridgeMessage(target, surface, rawMessage, options);
  };

  if (target.onDidReceiveMessage) {
    return target.onDidReceiveMessage(listener);
  }

  return new vscode.Disposable(() => undefined);
}

export async function handleBridgeMessage(
  target: Pick<BridgePostMessageTarget, "postMessage">,
  surface: WebviewSurface,
  rawMessage: unknown,
  options?: BridgeRouterOptions,
) {
  const parsed = parseWebviewMessage(rawMessage);

  if (!parsed.ok) {
    return postBridgeError(
      target,
      inferRequestId(rawMessage),
      inferRequestType(rawMessage),
      parsed.error.code,
      parsed.error.message,
    );
  }

  const request = parsed.value;

  if (request.payload.surface !== surface) {
    return postBridgeError(
      target,
      request.requestId,
      request.type,
      "SURFACE_MISMATCH",
      `Bridge request targeted surface '${request.payload.surface}' but '${surface}' owns this webview.`,
    );
  }

  switch (request.type) {
    case "bridge.ready": {
      const state =
        options?.getBridgeState?.(surface) ??
        createBridgeState(surface, getCurrentWorkspaceTrustState());
      await target.postMessage(createSuccessResponse(request, state));
      await target.postMessage(createStateEvent(state));
      return;
    }
    case "sidebar.bootstrap": {
      const payload = request.payload as SidebarBootstrapRequestPayload;
      const scaffoldState =
        (await options?.getSidebarScaffoldState?.(payload)) ??
        createSidebarScaffoldState(
          options?.getBridgeState?.("sidebar") ??
            createBridgeState("sidebar", getCurrentWorkspaceTrustState()),
          options?.backendAdapter?.getState() ??
            createBackendServiceState("unavailable", {
              detail: "Backend adapter is not registered for this sidebar.",
              baseUrl: "http://127.0.0.1:17800",
              executionLocation: "desktop",
            }),
        );
      await target.postMessage(createSuccessResponse(request, scaffoldState));
      return;
    }
    case "sidebar.backend.action": {
      const payload = request.payload as BridgeRequestPayloadMap["sidebar.backend.action"];
      const backendAdapter = options?.backendAdapter;

      if (!backendAdapter) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          "Backend adapter is unavailable for this webview.",
        );
      }

      if (payload.action === "initialize" || payload.action === "start") {
        const allowed = await ensureWorkspaceCapability(
          "backendStart",
          options.workspaceTrustDependencies,
        );

        if (!allowed) {
          return postBridgeError(
            target,
            request.requestId,
            request.type,
            "CAPABILITY_DENIED",
            createWorkspaceCapabilityDeniedMessage("backendStart"),
          );
        }

        const state = payload.action === "initialize"
          ? await backendAdapter.initializeWorkspace({
              workspaceTargetId: payload.workspaceTargetId,
            })
          : await backendAdapter.startBackend({
              workspaceTargetId: payload.workspaceTargetId,
            });
        await target.postMessage(createSuccessResponse(request, state));
        return;
      }

      const state = await backendAdapter.refreshStatus();
      await target.postMessage(createSuccessResponse(request, state));
      return;
    }
    case "sidebar.chat.send": {
      const payload = request.payload as SidebarChatSendRequestPayload;
      const handler = options?.handleSidebarChatSend;

      if (!handler) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          "Sidebar chat is not registered for this webview.",
        );
      }

      const allowed = await ensureWorkspaceCapability(
        "execute",
        options.workspaceTrustDependencies,
      );

      if (!allowed) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "CAPABILITY_DENIED",
          createWorkspaceCapabilityDeniedMessage("execute"),
        );
      }

      try {
        const state = await handler(payload);
        await target.postMessage(createSuccessResponse(request, state));
      } catch (error) {
        await postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    case "sidebar.settings.update": {
      const payload = request.payload as SidebarSettingsUpdateRequestPayload;
      const handler = options?.handleSidebarSettingsUpdate;

      if (!handler) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          "Sidebar settings are not registered for this webview.",
        );
      }

      try {
        const state = await handler(payload);
        await target.postMessage(createSuccessResponse(request, state));
      } catch (error) {
        await postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    case "preview.latex.compile": {
      const payload = request.payload as PreviewLatexCompileRequestPayload;
      const handler = options?.handlePreviewLatexCompile;

      if (!handler) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          "LaTeX compile is not registered for this preview.",
        );
      }

      const allowed = await ensureWorkspaceCapability(
        "execute",
        options.workspaceTrustDependencies,
      );

      if (!allowed) {
        return postBridgeError(
          target,
          request.requestId,
          request.type,
          "CAPABILITY_DENIED",
          createWorkspaceCapabilityDeniedMessage("execute"),
        );
      }

      try {
        const result = await handler(payload);
        await target.postMessage(createSuccessResponse(request, {
          success: result.success,
          engine: result.engine,
          command: result.command,
          commandLine: result.commandLine,
          statusMessage: result.statusMessage,
          stdout: result.stdout,
          stderr: result.stderr,
          log: result.log,
          pdfUri: result.pdfUri?.toString(),
        }));
      } catch (error) {
        await postBridgeError(
          target,
          request.requestId,
          request.type,
          "BACKEND_ACTION_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
  }
}

export function inferRequestId(rawMessage: unknown) {
  if (
    typeof rawMessage === "object" &&
    rawMessage !== null &&
    "requestId" in rawMessage
  ) {
    const candidate = (rawMessage as { requestId?: unknown }).requestId;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return `bridge-error-${BRIDGE_VERSION}`;
}

export function inferRequestType(rawMessage: unknown): BridgeRequestMessage["type"] {
  if (typeof rawMessage === "object" && rawMessage !== null && "type" in rawMessage) {
    const candidate = (rawMessage as { type?: unknown }).type;
    if (
      candidate === "bridge.ready" ||
      candidate === "sidebar.bootstrap" ||
      candidate === "sidebar.backend.action" ||
      candidate === "sidebar.chat.send" ||
      candidate === "preview.latex.compile"
    ) {
      return candidate;
    }
  }

  return "bridge.ready";
}

async function postBridgeError(
  target: Pick<BridgePostMessageTarget, "postMessage">,
  requestId: string,
  type: BridgeRequestMessage["type"],
  code: BridgeErrorCode,
  message: string,
) {
  await target.postMessage(createErrorResponse(requestId, type, code, message));
}

export async function postBackendStateEvent(
  target: Pick<BridgePostMessageTarget, "postMessage">,
  backendState: Parameters<typeof createBackendStateEvent>[0],
) {
  await target.postMessage(createBackendStateEvent(backendState));
}
