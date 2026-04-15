import type { BackendServiceState } from "../shared/backend-service";
import {
  createSidebarSessionState,
  createSidebarWindowState,
} from "../shared/sidebar-persistence";
import type { SidebarScaffoldState } from "../shared/sidebar-scaffold";
import type { WorkspaceTrustState } from "../shared/workspace-trust";
import type {
  PreviewLatexCompileResponsePayload,
  PreviewLatexStateEventPayload,
} from "../shared/webview-bridge";
import mermaid from "mermaid";
import { createRoot, type Root } from "react-dom/client";
import {
  createWebviewBridge,
  isBridgeStateEvent,
  isSidebarBackendStateEvent,
  isPreviewLatexStateEvent,
} from "./bridge-client";
import { SidebarApp } from "./sidebar-app";
import {
  renderPreviewShell,
  sharedWebviewStyles,
} from "./sidebar-shell";
import {
  createSidebarBackendActionPayload,
  createSidebarChatSendPayload,
  createSidebarSettingsUpdatePayload,
} from "./sidebar-action-payloads";

declare global {
  interface Window {
    __KDENSE_WEBVIEW__?: {
      title: string;
      heading: string;
      body: string;
      bodyIsHtml?: boolean;
      kind: "sidebar" | "preview";
      trust?: WorkspaceTrustState;
    };
  }
}

const model = window.__KDENSE_WEBVIEW__;
const container = document.getElementById("app");

if (!model || !container) {
  throw new Error("Missing K-Dense webview bootstrap state.");
}

const webviewModel = model;
const appContainer = container;
let sidebarRoot: Root | null = null;
let sidebarPendingBackendAction: "refresh" | "start" | "initialize" | null = null;
let sidebarComposerDraft = "";
let sidebarPendingChatSend = false;
let sidebarSelectedTargetId: string | undefined;
let previewLatexCompilePending = false;

const style = document.createElement("style");
style.textContent = sharedWebviewStyles;
document.head.append(style);

void bootstrap();

async function bootstrap() {
  let bridgeStatus = "Connecting to extension host…";
  let sidebarState: SidebarScaffoldState | null = null;

  render(bridgeStatus, sidebarState, undefined);

  const bridge = createWebviewBridge({
    surface: webviewModel.kind,
    onEvent(message) {
      if (isBridgeStateEvent(message)) {
        bridgeStatus = message.payload.message;
        render(bridgeStatus, sidebarState, bridge);
        return;
      }

      if (isSidebarBackendStateEvent(message)) {
        const previousStatus = sidebarState?.backend.status;

        if (sidebarState) {
          sidebarState = {
            ...sidebarState,
            backend: message.payload,
          };
        }

        if (message.payload.status !== "starting") {
          sidebarPendingBackendAction = null;
        }

        if (sidebarState) {
          render(bridgeStatus, sidebarState, bridge);
        }

        if (previousStatus !== "healthy" && message.payload.status === "healthy") {
          void bridge
            .request("sidebar.bootstrap", {
              surface: "sidebar",
              restoreState: bridge.getWindowState(),
            })
            .then((nextState) => {
              sidebarState = nextState;
              render(bridgeStatus, sidebarState, bridge);
            })
            .catch(() => undefined);
        }
        return;
      }

      if (isPreviewLatexStateEvent(message)) {
        applyLatexCompileStateEvent(message.payload);
      }
    },
  });

  try {
    const state = await bridge.ready();
    bridgeStatus = state.message;

    if (webviewModel.kind === "sidebar") {
      sidebarState = await bridge.request("sidebar.bootstrap", {
        surface: "sidebar",
        restoreState: bridge.getWindowState(),
      });
    }
  } catch (error) {
    bridgeStatus = `Bridge connection failed: ${getErrorMessage(error)}`;
  }

  render(bridgeStatus, sidebarState, bridge);

  window.addEventListener(
    "unload",
    () => {
      sidebarRoot?.unmount();
      bridge.dispose();
    },
    { once: true },
  );
}

function render(
  bridgeStatus: string,
  sidebarState: SidebarScaffoldState | null,
  bridge?: ReturnType<typeof createWebviewBridge>,
) {
  if (webviewModel.kind === "sidebar" && sidebarState) {
    if (
      !sidebarSelectedTargetId ||
      !sidebarState.targetOptions.some((option) => option.id === sidebarSelectedTargetId)
    ) {
      sidebarSelectedTargetId = sidebarState.selectedTargetId;
    }

    const effectiveSidebarState: SidebarScaffoldState = {
      ...sidebarState,
      selectedTargetId: sidebarSelectedTargetId,
      targetRequirement: sidebarSelectedTargetId ? undefined : sidebarState.targetRequirement,
    };

    bridge?.setWindowState(
      createSidebarWindowState({
        workspaceIdentity: effectiveSidebarState.workspaceIdentity,
        bridgeStatus,
        session: createSidebarSessionState(
          effectiveSidebarState.messages,
          effectiveSidebarState.provenance,
        ),
        settings: effectiveSidebarState.settings,
      }),
    );

    if (!sidebarRoot) {
      sidebarRoot = createRoot(appContainer);
    }

    sidebarRoot.render(
      <SidebarApp
        composerDraft={sidebarComposerDraft}
        onBackendAction={(action) => {
          if (!bridge || sidebarPendingBackendAction) {
            return;
          }
          void runBackendAction(bridge, effectiveSidebarState, bridgeStatus, action);
        }}
        onComposerDraftChange={(value) => {
          sidebarComposerDraft = value;
          render(bridgeStatus, sidebarState, bridge);
        }}
        onSend={(request) => {
          if (!bridge) {
            return;
          }
          void runChatSend(bridge, effectiveSidebarState, bridgeStatus, request);
        }}
        onTargetChange={(value) => {
          sidebarSelectedTargetId = value;
          render(bridgeStatus, sidebarState, bridge);
        }}
        onSettingsUpdate={(request) => {
          if (!bridge) {
            return;
          }
          void runSettingsUpdate(bridge, effectiveSidebarState, bridgeStatus, request);
        }}
        pendingBackendAction={sidebarPendingBackendAction}
        pendingChatSend={sidebarPendingChatSend}
        selectedTargetId={sidebarSelectedTargetId}
        state={effectiveSidebarState}
      />,
    );
    void hydratePreviewEnhancements();
    return;
  }

  appContainer.innerHTML = renderPreviewShell(
    webviewModel.heading,
    webviewModel.body,
    webviewModel.bodyIsHtml ?? false,
    bridgeStatus,
    webviewModel.kind,
    webviewModel.trust,
  );

  void hydratePreviewEnhancements();
  if (bridge) {
    bindPreviewLatexActions(bridge);
  }
}

function bindPreviewLatexActions(bridge: ReturnType<typeof createWebviewBridge>) {
  const compileButton = appContainer.querySelector<HTMLButtonElement>("[data-latex-compile]");
  const engineSelect = appContainer.querySelector<HTMLSelectElement>("[data-latex-engine]");

  if (!compileButton || !engineSelect) {
    return;
  }

  compileButton.addEventListener("click", () => {
    if (compileButton.disabled || previewLatexCompilePending) {
      return;
    }

    const engine = engineSelect.value;
    if (engine !== "pdflatex" && engine !== "xelatex" && engine !== "lualatex") {
      return;
    }

    void runPreviewLatexCompile(bridge, engine);
  });
}

async function runPreviewLatexCompile(
  bridge: ReturnType<typeof createWebviewBridge>,
  engine: "pdflatex" | "xelatex" | "lualatex",
) {
  const compileButton = appContainer.querySelector<HTMLButtonElement>("[data-latex-compile]");
  const engineSelect = appContainer.querySelector<HTMLSelectElement>("[data-latex-engine]");
  const status = appContainer.querySelector<HTMLElement>("[data-latex-status]");
  const commandChip = appContainer.querySelector<HTMLElement>("[data-latex-command]");
  const logPanel = appContainer.querySelector<HTMLElement>("[data-latex-log]");

  if (!compileButton || !engineSelect || !status || !commandChip || !logPanel) {
    return;
  }

  previewLatexCompilePending = true;
  compileButton.disabled = true;
  engineSelect.disabled = true;
  compileButton.textContent = "Compiling…";
  status.textContent = `Compiling with ${engine} through the extension host…`;
  commandChip.textContent = "Running";
  logPanel.textContent = "Compilation started…";

  try {
    const result = await bridge.request("preview.latex.compile", {
      surface: "preview",
      engine,
    });
    applyLatexCompileResult(result);
  } catch (error) {
    status.textContent = getErrorMessage(error);
    commandChip.textContent = "Blocked";
    logPanel.textContent = getErrorMessage(error);
    const output = appContainer.querySelector<HTMLElement>("[data-latex-output]");
    if (output) {
      output.innerHTML = `<div class="preview-empty-output">${escapeHtml(getErrorMessage(error))}</div>`;
    }
  } finally {
    previewLatexCompilePending = false;
    compileButton.disabled = false;
    engineSelect.disabled = false;
    compileButton.textContent = "Compile";
  }
}

function applyLatexCompileStateEvent(payload: PreviewLatexStateEventPayload) {
  const compileButton = appContainer.querySelector<HTMLButtonElement>("[data-latex-compile]");
  const engineSelect = appContainer.querySelector<HTMLSelectElement>("[data-latex-engine]");
  const status = appContainer.querySelector<HTMLElement>("[data-latex-status]");
  const commandChip = appContainer.querySelector<HTMLElement>("[data-latex-command]");
  const logPanel = appContainer.querySelector<HTMLElement>("[data-latex-log]");

  if (engineSelect) {
    engineSelect.value = payload.engine;
  }

  if (payload.phase === "running") {
    previewLatexCompilePending = true;
    if (compileButton) {
      compileButton.disabled = true;
      compileButton.textContent = "Compiling…";
    }
    if (engineSelect) {
      engineSelect.disabled = true;
    }
    if (status) {
      status.textContent = payload.statusMessage;
    }
    if (commandChip) {
      commandChip.textContent = payload.commandLine ?? "Auto compile";
    }
    if (logPanel) {
      logPanel.textContent = payload.log ?? "Compilation started…";
    }
    return;
  }

  previewLatexCompilePending = false;
  if (compileButton) {
    compileButton.disabled = false;
    compileButton.textContent = "Compile";
  }
  if (engineSelect) {
    engineSelect.disabled = false;
  }
  applyLatexCompileResult(payload);
}

function applyLatexCompileResult(result: PreviewLatexCompileResponsePayload) {
  const status = appContainer.querySelector<HTMLElement>("[data-latex-status]");
  const commandChip = appContainer.querySelector<HTMLElement>("[data-latex-command]");
  const logPanel = appContainer.querySelector<HTMLElement>("[data-latex-log]");
  const output = appContainer.querySelector<HTMLElement>("[data-latex-output]");

  if (status) {
    status.textContent = result.statusMessage;
  }

  if (commandChip) {
    commandChip.textContent = result.commandLine;
  }

  if (logPanel) {
    const sections = [result.stdout, result.stderr, result.log].filter((section) => section.trim().length > 0);
    logPanel.textContent = sections.length > 0 ? sections.join("\n\n") : "No compiler output was captured.";
  }

  if (output) {
    output.innerHTML = result.success && result.pdfUri
      ? `<iframe class="preview-pdf-frame" src="${escapeAttribute(result.pdfUri)}#toolbar=0&navpanes=0" title="Rendered PDF preview"></iframe>`
      : '<div class="preview-empty-output">Compilation failed. Review the compile log for details.</div>';
  }
}

async function runBackendAction(
  bridge: ReturnType<typeof createWebviewBridge>,
  sidebarState: SidebarScaffoldState,
  bridgeStatus: string,
  action: "refresh" | "start" | "initialize",
) {
  sidebarPendingBackendAction = action;
  const nextSidebarState: SidebarScaffoldState = {
    ...sidebarState,
    backend:
      action === "refresh"
        ? {
            ...sidebarState.backend,
            detail: "Refreshing backend status through the extension host adapter…",
          }
        : sidebarState.backend,
  };

  render(bridgeStatus, nextSidebarState, bridge);

  try {
    const backendState = await bridge.request(
      "sidebar.backend.action",
      createSidebarBackendActionPayload(
        action,
        action === "refresh" ? undefined : sidebarSelectedTargetId,
      ),
    );
    sidebarPendingBackendAction = null;
    render(
      bridgeStatus,
      {
        ...sidebarState,
        backend: backendState,
      },
      bridge,
    );
  } catch (error) {
    sidebarPendingBackendAction = null;
    render(
      bridgeStatus,
      {
        ...sidebarState,
        backend: createClientFailureState(sidebarState.backend, error),
      },
      bridge,
    );
  }
}

async function runChatSend(
  bridge: ReturnType<typeof createWebviewBridge>,
  sidebarState: SidebarScaffoldState,
  bridgeStatus: string,
  request: { text: string; modelId: string },
) {
  const text = request.text.trim();
  if (!text || sidebarPendingChatSend) {
    return;
  }

  sidebarPendingChatSend = true;
  render(bridgeStatus, sidebarState, bridge);

  try {
    const nextState = await bridge.request(
      "sidebar.chat.send",
      createSidebarChatSendPayload(text, sidebarSelectedTargetId, request.modelId),
    );
    sidebarComposerDraft = "";
    sidebarPendingChatSend = false;
    render(bridgeStatus, nextState, bridge);
  } catch (error) {
    sidebarPendingChatSend = false;
    render(
      bridgeStatus,
      appendClientChatError(sidebarState, error),
      bridge,
    );
  }
}

async function runSettingsUpdate(
  bridge: ReturnType<typeof createWebviewBridge>,
  sidebarState: SidebarScaffoldState,
  bridgeStatus: string,
  request: {
    globalSettings?: SidebarScaffoldState["settings"];
    workspaceSettings?: SidebarScaffoldState["settings"] | null;
    globalOpenRouterApiKey?: string;
    workspaceOpenRouterApiKey?: string | null;
  },
) {
  try {
    const nextState = await bridge.request(
      "sidebar.settings.update",
      createSidebarSettingsUpdatePayload(request),
    );
    render(bridgeStatus, nextState, bridge);
  } catch (error) {
    render(
      bridgeStatus,
      appendClientChatError(sidebarState, error),
      bridge,
    );
  }
}

function appendClientChatError(
  state: SidebarScaffoldState,
  error: unknown,
): SidebarScaffoldState {
  const stamp = Date.now();
  const message = getErrorMessage(error);

  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: `assistant-error-${stamp}`,
        role: "assistant",
        content: `Chat request failed: ${message}`,
        timestampLabel: "Just now",
        chips: ["Host bridge", "Error"],
      },
    ],
    provenance: [
      ...state.provenance,
      {
        id: `prov-error-${stamp}`,
        type: "assistant_response",
        label: "Chat request failed",
        detail: message,
        relativeTime: "just now",
        chips: [{ label: "Surface", value: "sidebar" }],
      },
    ],
  };
}

function createClientFailureState(
  currentState: BackendServiceState,
  error: unknown,
): BackendServiceState {
  return {
    ...currentState,
    status: "failed",
    statusLabel: "Failed",
    detail: `Host-mediated backend action failed: ${getErrorMessage(error)}`,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

async function hydratePreviewEnhancements() {
  const mermaidNodes = Array.from(
    appContainer.querySelectorAll<HTMLElement>(".mermaid"),
  );

  if (mermaidNodes.length === 0) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
  });

  try {
    await mermaid.run({ nodes: mermaidNodes });
  } catch (error) {
    const message = getErrorMessage(error);
    for (const node of mermaidNodes) {
      node.classList.add("preview-mermaid-error");
      node.setAttribute("data-kady-mermaid-error", message);
    }
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export {};
