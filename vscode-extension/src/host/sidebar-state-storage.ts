import * as vscode from "vscode";
import type { SidebarScaffoldState } from "../shared/sidebar-scaffold";
import {
  SIDEBAR_GLOBAL_SETTINGS_KEY,
  SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
  SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
  SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY,
  SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
  SIDEBAR_WORKSPACE_SETTINGS_KEY,
  SIDEBAR_WORKSPACE_SNAPSHOT_KEY,
  createDefaultSidebarSettings,
  createSidebarSessionState,
  createSidebarWindowState,
  isSidebarSettingsState,
  isSidebarWindowState,
  isSidebarWorkspaceSnapshot,
  type SidebarSecretMetadata,
  type SidebarSecretValues,
  type SidebarSettingsState,
  type SidebarWindowState,
  type SidebarWorkspaceSnapshot,
} from "../shared/sidebar-persistence";

type SidebarStorageContext = Pick<
  vscode.ExtensionContext,
  "workspaceState" | "globalState" | "secrets"
>;

type SidebarSettingsRestore = {
  workspaceIdentity: string;
  session?: SidebarWindowState["session"];
  settings: SidebarSettingsState;
  globalSettings: SidebarSettingsState;
  workspaceSettings?: SidebarSettingsState;
  secretMetadata: SidebarSecretMetadata;
  bridgeStatus?: string;
  workspaceSnapshotUpdatedAt?: string;
};

type SidebarEffectiveRuntimeConfig = {
  settings: SidebarSettingsState;
  globalSettings: SidebarSettingsState;
  workspaceSettings?: SidebarSettingsState;
  globalOpenRouterApiKey?: string;
  workspaceOpenRouterApiKey?: string;
  effectiveOpenRouterApiKey?: string;
  effectiveOpenRouterApiKeyScope: SidebarSecretMetadata["effectiveOpenRouterApiKeyScope"];
  globalParallelApiKey?: string;
  workspaceParallelApiKey?: string;
  effectiveParallelApiKey?: string;
  effectiveParallelApiKeyScope: SidebarSecretMetadata["effectiveParallelApiKeyScope"];
  globalModalTokenId?: string;
  workspaceModalTokenId?: string;
  effectiveModalTokenId?: string;
  effectiveModalTokenIdScope: SidebarSecretMetadata["effectiveModalTokenIdScope"];
  globalModalTokenSecret?: string;
  workspaceModalTokenSecret?: string;
  effectiveModalTokenSecret?: string;
  effectiveModalTokenSecretScope: SidebarSecretMetadata["effectiveModalTokenSecretScope"];
};

export class SidebarStateStorage {
  constructor(
    private readonly context: SidebarStorageContext,
    private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined =
      () => vscode.workspace.workspaceFolders,
  ) {}

  getWorkspaceIdentity(): string {
    const folders = this.getWorkspaceFolders() ?? [];

    if (folders.length === 0) {
      return "workspace:none";
    }

    return folders
      .map((folder) => folder.uri.toString(true))
      .sort()
      .join("::");
  }

  async restoreState(windowState?: SidebarWindowState): Promise<SidebarSettingsRestore> {
    const workspaceIdentity = this.getWorkspaceIdentity();
    const workspaceSnapshot = this.getWorkspaceSnapshot(workspaceIdentity);
    const globalSettings = this.getGlobalSettings();
    const workspaceSettings = this.getWorkspaceSettings(workspaceIdentity);
    const settings = workspaceSettings ?? globalSettings;
    const normalizedWindowState =
      windowState &&
      isSidebarWindowState(windowState) &&
      windowState.workspaceIdentity === workspaceIdentity
        ? windowState
        : undefined;

    return {
      workspaceIdentity,
      session: normalizedWindowState?.session,
      settings,
      globalSettings,
      workspaceSettings,
      secretMetadata: await this.getSecretMetadata(workspaceIdentity),
      bridgeStatus: normalizedWindowState?.bridgeStatus,
      workspaceSnapshotUpdatedAt: workspaceSnapshot?.updatedAt,
    };
  }

  async getEffectiveRuntimeConfig(
    workspaceIdentity: string = this.getWorkspaceIdentity(),
  ): Promise<SidebarEffectiveRuntimeConfig> {
    const globalSettings = this.getGlobalSettings();
    const workspaceSettings = this.getWorkspaceSettings(workspaceIdentity);
    const settings = workspaceSettings ?? globalSettings;
    const globalOpenRouterApiKey = await this.context.secrets.get(
      SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY,
    );
    const workspaceOpenRouterApiKey = await this.context.secrets.get(
      getWorkspaceOpenRouterSecretKey(workspaceIdentity),
    );
    const globalParallelApiKey = await this.context.secrets.get(
      SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
    );
    const workspaceParallelApiKey = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
        workspaceIdentity,
      ),
    );
    const globalModalTokenId = await this.context.secrets.get(
      SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
    );
    const workspaceModalTokenId = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
        workspaceIdentity,
      ),
    );
    const globalModalTokenSecret = await this.context.secrets.get(
      SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
    );
    const workspaceModalTokenSecret = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
        workspaceIdentity,
      ),
    );

    const normalizedGlobalOpenRouterApiKey = normalizeSecretValue(globalOpenRouterApiKey);
    const normalizedWorkspaceOpenRouterApiKey = normalizeSecretValue(workspaceOpenRouterApiKey);
    const normalizedGlobalParallelApiKey = normalizeSecretValue(globalParallelApiKey);
    const normalizedWorkspaceParallelApiKey = normalizeSecretValue(workspaceParallelApiKey);
    const normalizedGlobalModalTokenId = normalizeSecretValue(globalModalTokenId);
    const normalizedWorkspaceModalTokenId = normalizeSecretValue(workspaceModalTokenId);
    const normalizedGlobalModalTokenSecret = normalizeSecretValue(globalModalTokenSecret);
    const normalizedWorkspaceModalTokenSecret = normalizeSecretValue(workspaceModalTokenSecret);

    return {
      settings,
      globalSettings,
      workspaceSettings,
      globalOpenRouterApiKey: normalizedGlobalOpenRouterApiKey,
      workspaceOpenRouterApiKey: normalizedWorkspaceOpenRouterApiKey,
      effectiveOpenRouterApiKey:
        normalizedWorkspaceOpenRouterApiKey ?? normalizedGlobalOpenRouterApiKey,
      effectiveOpenRouterApiKeyScope: normalizedWorkspaceOpenRouterApiKey
        ? "workspace"
        : normalizedGlobalOpenRouterApiKey
          ? "global"
          : null,
      globalParallelApiKey: normalizedGlobalParallelApiKey,
      workspaceParallelApiKey: normalizedWorkspaceParallelApiKey,
      effectiveParallelApiKey:
        normalizedWorkspaceParallelApiKey ?? normalizedGlobalParallelApiKey,
      effectiveParallelApiKeyScope: normalizedWorkspaceParallelApiKey
        ? "workspace"
        : normalizedGlobalParallelApiKey
          ? "global"
          : null,
      globalModalTokenId: normalizedGlobalModalTokenId,
      workspaceModalTokenId: normalizedWorkspaceModalTokenId,
      effectiveModalTokenId:
        normalizedWorkspaceModalTokenId ?? normalizedGlobalModalTokenId,
      effectiveModalTokenIdScope: normalizedWorkspaceModalTokenId
        ? "workspace"
        : normalizedGlobalModalTokenId
          ? "global"
          : null,
      globalModalTokenSecret: normalizedGlobalModalTokenSecret,
      workspaceModalTokenSecret: normalizedWorkspaceModalTokenSecret,
      effectiveModalTokenSecret:
        normalizedWorkspaceModalTokenSecret ?? normalizedGlobalModalTokenSecret,
      effectiveModalTokenSecretScope: normalizedWorkspaceModalTokenSecret
        ? "workspace"
        : normalizedGlobalModalTokenSecret
          ? "global"
          : null,
    };
  }

  async persistScaffoldState(
    scaffoldState: SidebarScaffoldState,
    bridgeStatus?: string,
  ): Promise<SidebarWindowState> {
    const session = createSidebarSessionState(
      scaffoldState.messages,
      scaffoldState.provenance,
    );
    const snapshot: SidebarWorkspaceSnapshot = {
      version: 1,
      workspaceIdentity: scaffoldState.workspaceIdentity,
      updatedAt: new Date().toISOString(),
    };

    await this.context.workspaceState.update(
      SIDEBAR_WORKSPACE_SNAPSHOT_KEY,
      snapshot,
    );

    return createSidebarWindowState({
      workspaceIdentity: scaffoldState.workspaceIdentity,
      bridgeStatus,
      session,
      settings: scaffoldState.settings,
    });
  }

  async saveGlobalSettings(settings: SidebarSettingsState) {
    await this.context.globalState.update(
      SIDEBAR_GLOBAL_SETTINGS_KEY,
      settings,
    );
  }

  async saveWorkspaceSettings(
    workspaceIdentity: string,
    settings: SidebarSettingsState | null,
  ) {
    const current = this.getWorkspaceSettingsMap();
    if (settings) {
      current[workspaceIdentity] = settings;
    } else {
      delete current[workspaceIdentity];
    }
    await this.context.workspaceState.update(
      SIDEBAR_WORKSPACE_SETTINGS_KEY,
      current,
    );
  }

  async storeSecrets(
    workspaceIdentity: string,
    values: SidebarSecretValues,
  ) {
    if (values.globalOpenRouterApiKey !== undefined) {
      await this.storeSecretValue(
        SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY,
        values.globalOpenRouterApiKey,
      );
    }

    if (values.workspaceOpenRouterApiKey !== undefined) {
      await this.storeSecretValue(
        getWorkspaceOpenRouterSecretKey(workspaceIdentity),
        values.workspaceOpenRouterApiKey,
      );
    }

    if (values.globalParallelApiKey !== undefined) {
      await this.storeSecretValue(
        SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
        values.globalParallelApiKey,
      );
    }

    if (values.workspaceParallelApiKey !== undefined) {
      await this.storeSecretValue(
        getWorkspaceScopedSecretKey(
          SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
          workspaceIdentity,
        ),
        values.workspaceParallelApiKey,
      );
    }

    if (values.globalModalTokenId !== undefined) {
      await this.storeSecretValue(
        SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
        values.globalModalTokenId,
      );
    }

    if (values.workspaceModalTokenId !== undefined) {
      await this.storeSecretValue(
        getWorkspaceScopedSecretKey(
          SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
          workspaceIdentity,
        ),
        values.workspaceModalTokenId,
      );
    }

    if (values.globalModalTokenSecret !== undefined) {
      await this.storeSecretValue(
        SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
        values.globalModalTokenSecret,
      );
    }

    if (values.workspaceModalTokenSecret !== undefined) {
      await this.storeSecretValue(
        getWorkspaceScopedSecretKey(
          SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
          workspaceIdentity,
        ),
        values.workspaceModalTokenSecret,
      );
    }
  }

  async getSecretMetadata(workspaceIdentity: string): Promise<SidebarSecretMetadata> {
    const globalKey = await this.context.secrets.get(
      SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY,
    );
    const workspaceKey = await this.context.secrets.get(
      getWorkspaceOpenRouterSecretKey(workspaceIdentity),
    );
    const hasGlobalOpenRouterApiKey = typeof globalKey === "string" && globalKey.length > 0;
    const hasWorkspaceOpenRouterApiKey = typeof workspaceKey === "string" && workspaceKey.length > 0;
    const globalParallelApiKey = await this.context.secrets.get(
      SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
    );
    const workspaceParallelApiKey = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
        workspaceIdentity,
      ),
    );
    const globalModalTokenId = await this.context.secrets.get(
      SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
    );
    const workspaceModalTokenId = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
        workspaceIdentity,
      ),
    );
    const globalModalTokenSecret = await this.context.secrets.get(
      SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
    );
    const workspaceModalTokenSecret = await this.context.secrets.get(
      getWorkspaceScopedSecretKey(
        SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
        workspaceIdentity,
      ),
    );
    const hasGlobalParallelApiKey = typeof globalParallelApiKey === "string" && globalParallelApiKey.length > 0;
    const hasWorkspaceParallelApiKey = typeof workspaceParallelApiKey === "string" && workspaceParallelApiKey.length > 0;
    const hasGlobalModalTokenId = typeof globalModalTokenId === "string" && globalModalTokenId.length > 0;
    const hasWorkspaceModalTokenId = typeof workspaceModalTokenId === "string" && workspaceModalTokenId.length > 0;
    const hasGlobalModalTokenSecret = typeof globalModalTokenSecret === "string" && globalModalTokenSecret.length > 0;
    const hasWorkspaceModalTokenSecret = typeof workspaceModalTokenSecret === "string" && workspaceModalTokenSecret.length > 0;

    return {
      hasGlobalOpenRouterApiKey,
      hasWorkspaceOpenRouterApiKey,
      effectiveOpenRouterApiKeyScope: hasWorkspaceOpenRouterApiKey
        ? "workspace"
        : hasGlobalOpenRouterApiKey
          ? "global"
          : null,
      hasGlobalParallelApiKey,
      hasWorkspaceParallelApiKey,
      effectiveParallelApiKeyScope: hasWorkspaceParallelApiKey
        ? "workspace"
        : hasGlobalParallelApiKey
          ? "global"
          : null,
      hasGlobalModalTokenId,
      hasWorkspaceModalTokenId,
      effectiveModalTokenIdScope: hasWorkspaceModalTokenId
        ? "workspace"
        : hasGlobalModalTokenId
          ? "global"
          : null,
      hasGlobalModalTokenSecret,
      hasWorkspaceModalTokenSecret,
      effectiveModalTokenSecretScope: hasWorkspaceModalTokenSecret
        ? "workspace"
        : hasGlobalModalTokenSecret
          ? "global"
          : null,
    };
  }

  private async storeSecretValue(key: string, value: string | null) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
      await this.context.secrets.delete(key);
    } else {
      await this.context.secrets.store(key, trimmed);
    }
  }

  private getWorkspaceSnapshot(
    workspaceIdentity: string,
  ): SidebarWorkspaceSnapshot | undefined {
    const value = this.context.workspaceState.get<unknown>(
      SIDEBAR_WORKSPACE_SNAPSHOT_KEY,
    );

    if (!isSidebarWorkspaceSnapshot(value)) {
      return undefined;
    }

    return value.workspaceIdentity === workspaceIdentity ? value : undefined;
  }

  private getGlobalSettings(): SidebarSettingsState {
    const value = this.context.globalState.get<unknown>(SIDEBAR_GLOBAL_SETTINGS_KEY);
    return isSidebarSettingsState(value)
      ? value
      : createDefaultSidebarSettings();
  }

  private getWorkspaceSettings(workspaceIdentity: string): SidebarSettingsState | undefined {
    const current = this.getWorkspaceSettingsMap();
    const value = current[workspaceIdentity];
    return isSidebarSettingsState(value) ? value : undefined;
  }

  private getWorkspaceSettingsMap(): Record<string, unknown> {
    const value = this.context.workspaceState.get<unknown>(SIDEBAR_WORKSPACE_SETTINGS_KEY);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  }
}

function getWorkspaceOpenRouterSecretKey(workspaceIdentity: string) {
  return `${SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY}:${encodeURIComponent(workspaceIdentity)}`;
}

function getWorkspaceScopedSecretKey(baseKey: string, workspaceIdentity: string) {
  return `${baseKey}:${encodeURIComponent(workspaceIdentity)}`;
}

function normalizeSecretValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
