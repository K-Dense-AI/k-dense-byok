import {
  BRIDGE_VERSION,
  type BridgeEventMessage,
  type BridgeRequestPayloadMap,
  type BridgeRequestType,
  type BridgeResponsePayloadMap,
  parseHostMessage,
  type WebviewSurface,
} from "../shared/webview-bridge";
import {
  isSidebarWindowState,
  type SidebarWindowState,
} from "../shared/sidebar-persistence";

type VsCodeApi<State> = {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type BridgeClientState = {
  lastRequestId: number;
  sidebarWindowState?: SidebarWindowState;
};

type PendingRequest = {
  type: BridgeRequestType;
  resolve: (payload: BridgeResponsePayloadMap[BridgeRequestType]) => void;
  reject: (error: Error) => void;
};

type WebviewBridgeOptions = {
  surface: WebviewSurface;
  vscodeApi?: VsCodeApi<BridgeClientState>;
  onEvent?: (message: BridgeEventMessage) => void;
};

declare function acquireVsCodeApi<State>(): VsCodeApi<State>;

export function createWebviewBridge(options: WebviewBridgeOptions) {
  const vscodeApi = options.vscodeApi ?? acquireVsCodeApi<BridgeClientState>();
  const persistedState = vscodeApi.getState() ?? { lastRequestId: 0 };
  let lastRequestId = persistedState.lastRequestId;
  let sidebarWindowState = isSidebarWindowState(persistedState.sidebarWindowState)
    ? persistedState.sidebarWindowState
    : undefined;
  const pendingRequests = new Map<string, PendingRequest>();

  const persistClientState = () => {
    vscodeApi.setState({
      lastRequestId,
      sidebarWindowState,
    });
  };

  const messageListener = (event: MessageEvent<unknown>) => {
    const parsed = parseHostMessage(event.data);

    if (!parsed.ok) {
      return;
    }

    const message = parsed.value;

    if (message.kind === "event") {
      options.onEvent?.(message);
      return;
    }

    const pending = pendingRequests.get(message.requestId);

    if (!pending) {
      return;
    }

    pendingRequests.delete(message.requestId);

    if (!message.ok) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      return;
    }

    pending.resolve(message.payload);
  };

  window.addEventListener("message", messageListener);

  return {
    request<T extends BridgeRequestType>(
      type: T,
      payload: BridgeRequestPayloadMap[T],
    ): Promise<BridgeResponsePayloadMap[T]> {
      const requestId = createRequestId(options.surface, ++lastRequestId);
      persistClientState();

      return new Promise<BridgeResponsePayloadMap[T]>((resolve, reject) => {
        pendingRequests.set(requestId, {
          type,
          resolve: resolve as PendingRequest["resolve"],
          reject,
        });

        vscodeApi.postMessage({
          version: BRIDGE_VERSION,
          kind: "request",
          requestId,
          type,
          payload,
        });
      });
    },
    async ready() {
      return this.request("bridge.ready", {
        surface: options.surface,
      });
    },
    getWindowState() {
      return sidebarWindowState;
    },
    setWindowState(windowState?: SidebarWindowState) {
      sidebarWindowState = windowState;
      persistClientState();
    },
    dispose() {
      window.removeEventListener("message", messageListener);

      for (const pending of pendingRequests.values()) {
        pending.reject(new Error("Bridge disposed before the host responded."));
      }

      pendingRequests.clear();
    },
  };
}

export function isBridgeStateEvent(
  message: BridgeEventMessage,
): message is BridgeEventMessage<"bridge.state"> {
  return message.type === "bridge.state";
}

export function isSidebarBackendStateEvent(
  message: BridgeEventMessage,
): message is BridgeEventMessage<"sidebar.backend.state"> {
  return message.type === "sidebar.backend.state";
}

export function isPreviewLatexStateEvent(
  message: BridgeEventMessage,
): message is BridgeEventMessage<"preview.latex.state"> {
  return message.type === "preview.latex.state";
}

function createRequestId(surface: WebviewSurface, sequence: number) {
  return `${surface}-${sequence}`;
}
