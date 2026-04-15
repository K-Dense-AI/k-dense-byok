import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { SidebarStateStorage } from "../../src/host/sidebar-state-storage";
import { createBackendServiceState } from "../../src/shared/backend-service";
import {
  createSidebarWindowState,
  SIDEBAR_GLOBAL_SETTINGS_KEY,
  SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY,
  SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY,
  SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY,
  SIDEBAR_PARALLEL_API_KEY_SECRET_KEY,
  SIDEBAR_WORKSPACE_SNAPSHOT_KEY,
  type SidebarSettingsState,
} from "../../src/shared/sidebar-persistence";
import { createSidebarScaffoldState } from "../../src/shared/sidebar-scaffold";
import { createBridgeState } from "../../src/shared/webview-bridge";

suite("sidebar persistence", () => {
  test("restores same-window state without falling back to workspace-shared live session history", async () => {
    const context = createStorageContext();
    const workspaceFolder = createWorkspaceFolder("file:///workspace/alpha");
    const storage = new SidebarStateStorage(context, () => [workspaceFolder]);
    const scaffoldState = createSidebarScaffoldState(
      createBridgeState("sidebar"),
      createBackendServiceState("healthy", {
        detail: "Backend is healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        workspaceIdentity: storage.getWorkspaceIdentity(),
        session: {
          messages: [
            {
              id: "workspace-message",
              role: "assistant",
              content: "Persisted window session",
              timestampLabel: "Earlier",
            },
          ],
          provenance: [
            {
              id: "workspace-prov",
              type: "assistant_response",
              label: "Window session",
              detail: "Persisted in window state.",
              relativeTime: "earlier",
            },
          ],
        },
        settings: {
          showReasoning: true,
          showProvenance: true,
          defaultModelId: "openrouter/anthropic/claude-opus-4.6",
          defaultComputeId: "local",
        },
      },
    );

    const persistedWindowState = await storage.persistScaffoldState(
      scaffoldState,
      "Bridge from workspace",
    );
    const restored = await storage.restoreState(persistedWindowState);

    assert.equal(restored.workspaceIdentity, storage.getWorkspaceIdentity());
    assert.equal(restored.bridgeStatus, "Bridge from workspace");
    assert.equal(restored.session?.messages[0]?.content, "Persisted window session");
    assert.equal(restored.session?.provenance[0]?.label, "Window session");
    assert.equal(restored.settings.showReasoning, true);
    assert.equal(restored.settings.showProvenance, true);
    assert.equal(restored.settings.defaultModelId, "openrouter/anthropic/claude-opus-4.6");
    assert.equal(restored.settings.defaultComputeId, "local");
  });

  test("does not let a second window inherit another window's live session for the same workspace", async () => {
    const context = createStorageContext();
    const workspaceFolder = createWorkspaceFolder("file:///workspace/shared");
    const firstWindowStorage = new SidebarStateStorage(context, () => [workspaceFolder]);
    const secondWindowStorage = new SidebarStateStorage(context, () => [workspaceFolder]);

    const firstWindowState = createSidebarScaffoldState(
      createBridgeState("sidebar"),
      createBackendServiceState("healthy", {
        detail: "Shared workspace backend is healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        workspaceIdentity: firstWindowStorage.getWorkspaceIdentity(),
        session: {
          messages: [
            {
              id: "first-window-message",
              role: "assistant",
              content: "Window one conversation",
              timestampLabel: "Earlier",
            },
          ],
          provenance: [
            {
              id: "first-window-prov",
              type: "assistant_response",
              label: "Window one session",
              detail: "Should not leak to a second window.",
              relativeTime: "earlier",
            },
          ],
        },
        settings: {
          showReasoning: false,
          showProvenance: true,
          defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
          defaultComputeId: "local",
        },
      },
    );

    await firstWindowStorage.persistScaffoldState(firstWindowState, "Bridge from first window");
    const restored = await secondWindowStorage.restoreState(undefined);

    assert.equal(restored.workspaceIdentity, secondWindowStorage.getWorkspaceIdentity());
    assert.equal(restored.bridgeStatus, undefined);
    assert.equal(restored.session, undefined);
    assert.deepEqual(restored.settings, {
      showReasoning: true,
      showProvenance: true,
      defaultModelId: "openrouter/anthropic/claude-opus-4.6",
      defaultComputeId: "local",
    });
    assert.equal(
      (context.workspaceMemento.values[SIDEBAR_WORKSPACE_SNAPSHOT_KEY] as { workspaceIdentity: string }).workspaceIdentity,
      secondWindowStorage.getWorkspaceIdentity(),
    );
  });

  test("ignores mismatched window restore state and stale workspace snapshots from other workspaces", async () => {
    const context = createStorageContext();
    const alphaStorage = new SidebarStateStorage(context, () => [createWorkspaceFolder("file:///workspace/alpha")]);
    const betaStorage = new SidebarStateStorage(context, () => [createWorkspaceFolder("file:///workspace/beta")]);

    const alphaScaffoldState = createSidebarScaffoldState(
      createBridgeState("sidebar"),
      createBackendServiceState("healthy", {
        detail: "Alpha backend is healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        workspaceIdentity: alphaStorage.getWorkspaceIdentity(),
        session: {
          messages: [
            {
              id: "alpha-message",
              role: "assistant",
              content: "Alpha workspace snapshot",
              timestampLabel: "Earlier",
            },
          ],
          provenance: [
            {
              id: "alpha-prov",
              type: "assistant_response",
              label: "Alpha snapshot",
              detail: "Scoped to alpha workspace.",
              relativeTime: "earlier",
            },
          ],
        },
      },
    );

    await alphaStorage.persistScaffoldState(alphaScaffoldState, "Alpha window");

    const mismatchedWindowState = createSidebarWindowState({
      workspaceIdentity: alphaStorage.getWorkspaceIdentity(),
      bridgeStatus: "Alpha window",
      session: {
        messages: [
          {
            id: "alpha-window-message",
            role: "assistant",
            content: "Alpha window state",
            timestampLabel: "Earlier",
          },
        ],
        provenance: [],
      },
      settings: {
        showReasoning: false,
        showProvenance: true,
        defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
        defaultComputeId: "local",
      },
    });

    const restored = await betaStorage.restoreState(mismatchedWindowState);

    assert.equal(restored.workspaceIdentity, betaStorage.getWorkspaceIdentity());
    assert.equal(restored.bridgeStatus, undefined);
    assert.equal(restored.session, undefined);
    assert.deepEqual(restored.settings, {
      showReasoning: true,
      showProvenance: true,
      defaultModelId: "openrouter/anthropic/claude-opus-4.6",
      defaultComputeId: "local",
    });
  });



  test("workspace overrides take precedence over global defaults for the current workspace", async () => {
    const context = createStorageContext();
    const storage = new SidebarStateStorage(context, () => [createWorkspaceFolder("file:///workspace/alpha")]);
    await storage.saveGlobalSettings({
      showReasoning: true,
      showProvenance: false,
      defaultModelId: "openrouter/anthropic/claude-opus-4.6",
      defaultComputeId: "local",
    });
    await storage.saveWorkspaceSettings(storage.getWorkspaceIdentity(), {
      showReasoning: false,
      showProvenance: true,
      defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
      defaultComputeId: "t4",
    });

    const restored = await storage.restoreState();

    assert.equal(restored.globalSettings.defaultModelId, "openrouter/anthropic/claude-opus-4.6");
    assert.equal(restored.workspaceSettings?.defaultModelId, "openrouter/google/gemini-3.1-pro-preview");
    assert.equal(restored.settings.defaultModelId, "openrouter/google/gemini-3.1-pro-preview");
    assert.equal(restored.settings.defaultComputeId, "t4");
    assert.equal(restored.settings.showReasoning, false);
  });

  test("stores secret values only in secure storage and never in plain persisted state", async () => {
    const context = createStorageContext();
    const storage = new SidebarStateStorage(context, () => [createWorkspaceFolder("file:///workspace/alpha")]);
    const settings: SidebarSettingsState = {
      showReasoning: false,
      showProvenance: true,
      defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
      defaultComputeId: "local",
    };

    const scaffoldState = createSidebarScaffoldState(
      createBridgeState("sidebar"),
      createBackendServiceState("healthy", {
        detail: "Secret-safe scaffold.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        workspaceIdentity: storage.getWorkspaceIdentity(),
        settings,
      },
    );

    await storage.saveGlobalSettings(settings);
    await storage.saveWorkspaceSettings(storage.getWorkspaceIdentity(), {
      ...settings,
      showReasoning: true,
      defaultComputeId: "t4",
    });
    await storage.persistScaffoldState(scaffoldState, "Bridge ready");
    await storage.storeSecrets(storage.getWorkspaceIdentity(), {
      globalOpenRouterApiKey: "sk-openrouter-secret-value",
      workspaceOpenRouterApiKey: "sk-openrouter-project-secret",
      globalParallelApiKey: "parallel-global-secret",
      workspaceParallelApiKey: "parallel-project-secret",
      globalModalTokenId: "modal-id-global",
      workspaceModalTokenId: "modal-id-project",
      globalModalTokenSecret: "modal-secret-global",
      workspaceModalTokenSecret: "modal-secret-project",
    });

    const restored = await storage.restoreState();
    const secretMetadata = await storage.getSecretMetadata(storage.getWorkspaceIdentity());
    const runtimeConfig = await storage.getEffectiveRuntimeConfig();

    assert.equal(secretMetadata.hasGlobalOpenRouterApiKey, true);
    assert.equal(secretMetadata.hasWorkspaceOpenRouterApiKey, true);
    assert.equal(secretMetadata.effectiveOpenRouterApiKeyScope, "workspace");
    assert.equal(secretMetadata.hasGlobalParallelApiKey, true);
    assert.equal(secretMetadata.hasWorkspaceParallelApiKey, true);
    assert.equal(secretMetadata.effectiveParallelApiKeyScope, "workspace");
    assert.equal(secretMetadata.hasGlobalModalTokenId, true);
    assert.equal(secretMetadata.hasWorkspaceModalTokenId, true);
    assert.equal(secretMetadata.effectiveModalTokenIdScope, "workspace");
    assert.equal(secretMetadata.hasGlobalModalTokenSecret, true);
    assert.equal(secretMetadata.hasWorkspaceModalTokenSecret, true);
    assert.equal(secretMetadata.effectiveModalTokenSecretScope, "workspace");
    assert.equal(restored.settings.defaultComputeId, "t4");
    assert.equal(runtimeConfig.effectiveParallelApiKey, "parallel-project-secret");
    assert.equal(runtimeConfig.effectiveModalTokenId, "modal-id-project");
    assert.equal(runtimeConfig.effectiveModalTokenSecret, "modal-secret-project");
    assert.equal(
      context.secretStorage.values.get(SIDEBAR_OPENROUTER_API_KEY_SECRET_KEY),
      "sk-openrouter-secret-value",
    );
    assert.equal(
      context.secretStorage.values.get(SIDEBAR_PARALLEL_API_KEY_SECRET_KEY),
      "parallel-global-secret",
    );
    assert.equal(
      context.secretStorage.values.get(SIDEBAR_MODAL_TOKEN_ID_SECRET_KEY),
      "modal-id-global",
    );
    assert.equal(
      context.secretStorage.values.get(SIDEBAR_MODAL_TOKEN_SECRET_SECRET_KEY),
      "modal-secret-global",
    );
    assert.equal(
      JSON.stringify(context.workspaceMemento.values).includes(
        "sk-openrouter-secret-value",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(context.globalMemento.values).includes(
        "sk-openrouter-secret-value",
      ),
      false,
    );
    assert.ok(context.workspaceMemento.values[SIDEBAR_WORKSPACE_SNAPSHOT_KEY]);
    assert.deepEqual(context.globalMemento.values[SIDEBAR_GLOBAL_SETTINGS_KEY], settings);
  });
});

function createWorkspaceFolder(folderUri: string): vscode.WorkspaceFolder {
  const uri = vscode.Uri.parse(folderUri);
  return {
    uri,
    name: uri.path.split("/").filter(Boolean).at(-1) ?? "workspace",
    index: 0,
  };
}

function createStorageContext() {
  const workspaceMemento = createMemoryMemento();
  const globalMemento = createMemoryMemento();
  const secretStorage = createMemorySecretStorage();

  return {
    workspaceMemento,
    globalMemento,
    secretStorage,
    workspaceState: workspaceMemento as unknown as vscode.Memento,
    globalState: {
      ...globalMemento,
      setKeysForSync() {
        // test double intentionally keeps sync configuration in-memory only
      },
    } as unknown as vscode.ExtensionContext["globalState"],
    secrets: secretStorage as unknown as vscode.SecretStorage,
  };
}

function createMemoryMemento() {
  const values: Record<string, unknown> = {};

  return {
    values,
    get<T>(key: string, defaultValue?: T) {
      return (key in values ? values[key] : defaultValue) as T;
    },
    update(key: string, value: unknown) {
      values[key] = value;
      return Promise.resolve();
    },
    keys() {
      return Object.keys(values);
    },
  };
}

function createMemorySecretStorage() {
  const values = new Map<string, string>();

  return {
    values,
    get(key: string) {
      return Promise.resolve(values.get(key));
    },
    store(key: string, value: string) {
      values.set(key, value);
      return Promise.resolve();
    },
    delete(key: string) {
      values.delete(key);
      return Promise.resolve();
    },
    onDidChange() {
      return { dispose() {} };
    },
  };
}
