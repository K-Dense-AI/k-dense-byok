import * as vscode from "vscode";
import { BackendServiceAdapter } from "../host/backend-service-adapter";
import { SidebarStateStorage } from "../host/sidebar-state-storage";
import { listWorkspaceTargetOptions, resolveWorkspaceTarget } from "../host/workspace";
import { getCurrentWorkspaceTrustState } from "../host/workspace-trust";
import {
  attachWebviewBridgeRouter,
  postBackendStateEvent,
} from "../host/webview-bridge-router";
import {
  applyBackendChatResultToSidebarState,
  createSidebarScaffoldState,
  type SidebarScaffoldState,
  type SidebarTargetOption,
} from "../shared/sidebar-scaffold";
import { createBridgeState } from "../shared/webview-bridge";
import { renderWebviewHtml } from "../webview/render-webview-html";

type SidebarBackendAdapter = Pick<
  BackendServiceAdapter,
  | "getState"
  | "refreshStatus"
  | "initializeWorkspace"
  | "startBackend"
  | "stopBackend"
  | "sendChat"
  | "onDidChangeState"
  | "dispose"
  | "getSidebarControlAvailability"
>;

type SidebarStateStorageLike = Pick<
  SidebarStateStorage,
  | "restoreState"
  | "persistScaffoldState"
  | "saveGlobalSettings"
  | "saveWorkspaceSettings"
  | "storeSecrets"
  | "getEffectiveRuntimeConfig"
>;

type KadyChatViewProviderDependencies = {
  backendAdapter?: SidebarBackendAdapter;
  getWorkspaceTrustState?: typeof getCurrentWorkspaceTrustState;
  sidebarStateStorage?: SidebarStateStorageLike;
};

export class KadyChatViewProvider implements vscode.WebviewViewProvider {
  private readonly backendAdapter: SidebarBackendAdapter;
  private readonly sidebarStateStorage: SidebarStateStorageLike;
  private currentSidebarState: SidebarScaffoldState | null = null;
  private currentBridgeStatus: string | undefined;
  private currentTargetId: string | undefined;
  private readonly getWorkspaceTrustState: typeof getCurrentWorkspaceTrustState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    dependencies: KadyChatViewProviderDependencies = {},
  ) {
    this.getWorkspaceTrustState =
      dependencies.getWorkspaceTrustState ?? getCurrentWorkspaceTrustState;
    this.sidebarStateStorage =
      dependencies.sidebarStateStorage ?? new SidebarStateStorage(context);
    this.backendAdapter =
      dependencies.backendAdapter ??
      new BackendServiceAdapter({
        runtimeRootUri: vscode.Uri.joinPath(context.extensionUri, "dist", "runtime"),
        getRuntimeEnvironment: async () => {
          const runtimeConfig = await this.sidebarStateStorage.getEffectiveRuntimeConfig();
          return {
            defaultModelId: runtimeConfig.settings.defaultModelId,
            openRouterApiKey: runtimeConfig.effectiveOpenRouterApiKey,
            parallelApiKey: runtimeConfig.effectiveParallelApiKey,
            modalTokenId: runtimeConfig.effectiveModalTokenId,
            modalTokenSecret: runtimeConfig.effectiveModalTokenSecret,
          };
        },
        sessionOwnerId: `kdense-sidebar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const trustState = this.getWorkspaceTrustState();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };

    this.context.subscriptions.push(
      attachWebviewBridgeRouter(webviewView.webview, "sidebar", {
        getBridgeState: (surface) =>
          createBridgeState(surface, this.getWorkspaceTrustState()),
        backendAdapter: this.backendAdapter,
        getSidebarScaffoldState: async (payload) => {
          const bridgeState = createBridgeState(
            "sidebar",
            this.getWorkspaceTrustState(),
          );
          const restored = await this.sidebarStateStorage.restoreState(
            payload.restoreState,
          );
          const scaffoldState = await this.createScaffoldState({
            bridgeState,
            workspaceIdentity: restored.workspaceIdentity,
            session: restored.session,
            settings: restored.settings,
          });
          this.currentBridgeStatus = restored.bridgeStatus ?? bridgeState.message;
          return this.persistSidebarState(scaffoldState, this.currentBridgeStatus);
        },
        handleSidebarChatSend: async (payload) => {
          const scaffoldState = await this.ensureSidebarState();
          const result = await this.backendAdapter.sendChat(payload.text, {
            workspaceTargetId: payload.workspaceTargetId,
            modelId: payload.modelId,
          });
          this.currentTargetId = payload.workspaceTargetId ?? this.currentTargetId;
          const nextState = await this.createScaffoldState({
            bridgeState: createBridgeState("sidebar", this.getWorkspaceTrustState()),
            workspaceIdentity: scaffoldState.workspaceIdentity,
            session: {
              messages: scaffoldState.messages,
              provenance: scaffoldState.provenance,
            },
            settings: scaffoldState.settings,
          });
          const applied = applyBackendChatResultToSidebarState(nextState, result, {
            trustLabel: scaffoldState.trust.statusLabel,
            selectedTargetId: this.currentTargetId,
            targetOptions: nextState.targetOptions,
            targetRequirement: nextState.targetRequirement,
          });
          return this.persistSidebarState(applied, this.currentBridgeStatus);
        },
        handleSidebarSettingsUpdate: async (payload) => {
          const scaffoldState = await this.ensureSidebarState();
          const workspaceIdentity = scaffoldState.workspaceIdentity;

          if (payload.globalSettings) {
            await this.sidebarStateStorage.saveGlobalSettings(payload.globalSettings);
          }

          if (payload.workspaceSettings !== undefined) {
            await this.sidebarStateStorage.saveWorkspaceSettings(
              workspaceIdentity,
              payload.workspaceSettings,
            );
          }

          if (
            payload.globalOpenRouterApiKey !== undefined ||
            payload.workspaceOpenRouterApiKey !== undefined ||
            payload.globalParallelApiKey !== undefined ||
            payload.workspaceParallelApiKey !== undefined ||
            payload.globalModalTokenId !== undefined ||
            payload.workspaceModalTokenId !== undefined ||
            payload.globalModalTokenSecret !== undefined ||
            payload.workspaceModalTokenSecret !== undefined
          ) {
            await this.sidebarStateStorage.storeSecrets(workspaceIdentity, {
              globalOpenRouterApiKey: payload.globalOpenRouterApiKey,
              workspaceOpenRouterApiKey: payload.workspaceOpenRouterApiKey,
              globalParallelApiKey: payload.globalParallelApiKey,
              workspaceParallelApiKey: payload.workspaceParallelApiKey,
              globalModalTokenId: payload.globalModalTokenId,
              workspaceModalTokenId: payload.workspaceModalTokenId,
              globalModalTokenSecret: payload.globalModalTokenSecret,
              workspaceModalTokenSecret: payload.workspaceModalTokenSecret,
            });
          }

          const nextState = await this.createScaffoldState({
            bridgeState: createBridgeState("sidebar", this.getWorkspaceTrustState()),
            workspaceIdentity,
            session: {
              messages: scaffoldState.messages,
              provenance: scaffoldState.provenance,
            },
            settings: scaffoldState.settings,
          });

          return this.persistSidebarState(nextState, this.currentBridgeStatus);
        },
      }),
      this.backendAdapter.onDidChangeState((state) => {
        void this.handleBackendStateChange(webviewView.webview, state);
      }),
      this.backendAdapter,
    );

    void this.primeBackendForSidebarActivation();

    webviewView.webview.html = renderWebviewHtml(
      webviewView.webview,
      this.context.extensionUri,
      {
        title: "Kady Chat",
        heading: "Kady sidebar",
        body: "Typed bridge bootstrap in progress…",
        kind: "sidebar",
        trust: trustState,
      },
    );
  }

  private async ensureSidebarState() {
    if (this.currentSidebarState) {
      return this.currentSidebarState;
    }

    const bridgeState = createBridgeState("sidebar", this.getWorkspaceTrustState());
    const restored = await this.sidebarStateStorage.restoreState();
    const scaffoldState = await this.createScaffoldState({
      bridgeState,
      workspaceIdentity: restored.workspaceIdentity,
      session: restored.session,
      settings: restored.settings,
    });
    this.currentBridgeStatus = restored.bridgeStatus ?? bridgeState.message;
    return this.persistSidebarState(scaffoldState, this.currentBridgeStatus);
  }

  async primeBackendForSidebarActivation() {
    const refreshed = await this.backendAdapter.refreshStatus();

    if (refreshed.status === "healthy") {
      await this.refreshCurrentSidebarControls();
    }
  }

  private async handleBackendStateChange(
    webview: vscode.Webview,
    state: ReturnType<SidebarBackendAdapter["getState"]>,
  ) {
    const previousStatus = this.currentSidebarState?.backend.status;

    if (this.currentSidebarState) {
      if (previousStatus !== "healthy" && state.status === "healthy") {
        await this.refreshCurrentSidebarControls();
      } else {
        await this.persistSidebarState(
          {
            ...this.currentSidebarState,
            backend: state,
          },
          this.currentBridgeStatus,
        );
      }
    }

    await postBackendStateEvent(webview, state);
  }

  private async refreshCurrentSidebarControls() {
    if (!this.currentSidebarState) {
      return undefined;
    }

    const refreshedState = await this.createScaffoldState({
      bridgeState: createBridgeState("sidebar", this.getWorkspaceTrustState()),
      workspaceIdentity: this.currentSidebarState.workspaceIdentity,
      session: {
        messages: this.currentSidebarState.messages,
        provenance: this.currentSidebarState.provenance,
      },
      settings: this.currentSidebarState.settings,
    });

    return this.persistSidebarState(refreshedState, this.currentBridgeStatus);
  }

  private async createScaffoldState(options: {
    bridgeState: ReturnType<typeof createBridgeState>;
    workspaceIdentity: string;
    session?: {
      messages: SidebarScaffoldState["messages"];
      provenance: SidebarScaffoldState["provenance"];
    };
    settings?: SidebarScaffoldState["settings"];
  }) {
    const targetOptions = this.getTargetOptions();
    const selectedTargetId = this.resolveSelectedTargetId(targetOptions);
    const controlAvailability = await this.getSidebarControlAvailability();
    const restored = await this.sidebarStateStorage.restoreState();
    return createSidebarScaffoldState(options.bridgeState, this.backendAdapter.getState(), {
      workspaceIdentity: options.workspaceIdentity,
      session: options.session,
      settings: restored.settings,
      globalSettings: restored.globalSettings,
      workspaceSettings: restored.workspaceSettings,
      secretMetadata: restored.secretMetadata,
      targetOptions,
      selectedTargetId,
      targetRequirement: this.getTargetRequirement(targetOptions, selectedTargetId),
      modalConfigured: controlAvailability.modalConfigured,
      availableSkills: controlAvailability.availableSkills,
    });
  }

  private async getSidebarControlAvailability() {
    if (!this.backendAdapter.getSidebarControlAvailability) {
      return {
        modalConfigured: false,
        availableSkills: [],
      };
    }

    return this.backendAdapter.getSidebarControlAvailability();
  }

  private getTargetOptions(): SidebarTargetOption[] {
    return listWorkspaceTargetOptions().map((option) => ({
      id: option.id,
      name: option.name,
    }));
  }

  private resolveSelectedTargetId(targetOptions: SidebarTargetOption[]) {
    if (this.currentTargetId && targetOptions.some((option) => option.id === this.currentTargetId)) {
      return this.currentTargetId;
    }

    const resolution = resolveWorkspaceTarget({});
    if (resolution.ok) {
      this.currentTargetId = resolution.targetFolderUri.toString();
      return this.currentTargetId;
    }

    if (resolution.code === "ambiguous-workspace-target") {
      this.currentTargetId = undefined;
      return undefined;
    }

    if (targetOptions.length === 1) {
      this.currentTargetId = targetOptions[0].id;
      return this.currentTargetId;
    }

    this.currentTargetId = undefined;
    return undefined;
  }

  private getTargetRequirement(
    targetOptions: SidebarTargetOption[],
    selectedTargetId: string | undefined,
  ) {
    if (targetOptions.length <= 1 || selectedTargetId) {
      return undefined;
    }

    return "Choose a target workspace folder before sending chat requests or starting the backend from the sidebar.";
  }

  private async persistSidebarState(
    state: SidebarScaffoldState,
    bridgeStatus?: string,
  ) {
    const windowState = await this.sidebarStateStorage.persistScaffoldState(
      state,
      bridgeStatus,
    );
    this.currentSidebarState = state;
    this.currentBridgeStatus = windowState.bridgeStatus;
    this.currentTargetId = state.selectedTargetId;
    return state;
  }
}
