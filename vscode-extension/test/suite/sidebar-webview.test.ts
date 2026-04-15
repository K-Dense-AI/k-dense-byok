import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { createBackendServiceState } from "../../src/shared/backend-service";
import { createSidebarScaffoldState } from "../../src/shared/sidebar-scaffold";
import { createBridgeState } from "../../src/shared/webview-bridge";
import { createWorkspaceTrustState } from "../../src/shared/workspace-trust";
import { KadyChatViewProvider } from "../../src/views/kady-chat-view-provider";
import { renderPreviewShell } from "../../src/webview/sidebar-shell";
import { renderSidebarToStaticMarkup } from "../../src/webview/sidebar-app";

suite("sidebar webview scaffold", () => {
  test("provider still registers and renders sidebar webview html", () => {
    const context = {
      extensionUri: vscode.Uri.file("/tmp/kdense-extension"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const fakeWebview = {
      html: "",
      options: undefined as vscode.WebviewOptions | undefined,
      postMessage: async () => true,
      asWebviewUri(uri: vscode.Uri) {
        return uri;
      },
    } as unknown as vscode.Webview;

    const fakeView = {
      webview: fakeWebview,
    } as vscode.WebviewView;

    new KadyChatViewProvider(context).resolveWebviewView(fakeView);

    assert.equal(fakeWebview.options?.enableScripts, true);
    assert.ok(fakeWebview.options?.localResourceRoots?.length);
    assert.match(fakeWebview.html, /window\.__KDENSE_WEBVIEW__/);
    assert.match(fakeWebview.html, /"kind":"sidebar"/);
    assert.match(fakeWebview.html, /<div id="app"><\/div>/);
    assert.equal(context.subscriptions.length, 3);
  });

  test("sidebar activation auto-refreshes and auto-starts the backend in the normal trusted case", async () => {
    let refreshCalls = 0;
    let startCalls = 0;
    const backendAdapter = {
      getState: () =>
        createBackendServiceState("unavailable", {
          detail: "Backend unavailable.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        }),
      refreshStatus: async () => {
        refreshCalls += 1;
        return createBackendServiceState("unavailable", {
          detail: "Backend unavailable.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        });
      },
      startBackend: async () => {
        startCalls += 1;
        return createBackendServiceState("starting", {
          detail: "Starting backend.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        });
      },
      sendChat: async () => {
        throw new Error("not used in this test");
      },
      onDidChangeState: () => new vscode.Disposable(() => undefined),
      dispose() {},
    };
    const context = {
      extensionUri: vscode.Uri.file("/tmp/kdense-extension"),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const provider = new KadyChatViewProvider(context, {
      backendAdapter: backendAdapter as never,
      getWorkspaceTrustState: () => createWorkspaceTrustState(true),
    });
    (provider as unknown as { currentTargetId?: string }).currentTargetId =
      vscode.workspace.workspaceFolders?.[0]?.uri.toString();

    await provider.primeBackendForSidebarActivation();

    assert.equal(refreshCalls, 1);
    assert.equal(startCalls, 1);
  });


  test("fresh trusted sidebar state repopulates skills after backend auto-start reaches healthy", async () => {
    const healthRefreshGate = createDeferred<void>();
    const autoStartDone = createDeferred<void>();
    const backendEvents = new vscode.EventEmitter<ReturnType<typeof createBackendServiceState>>();
    let backendState = createBackendServiceState("unavailable", {
      detail: "Backend unavailable.",
      baseUrl: "http://127.0.0.1:8000",
      executionLocation: "desktop",
    });
    const backendAdapter = {
      getState: () => backendState,
      refreshStatus: async () => {
        await healthRefreshGate.promise;
        return backendState;
      },
      startBackend: async () => {
        backendState = createBackendServiceState("healthy", {
          detail: "Backend healthy and prepared runtime is available.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        });
        backendEvents.fire(backendState);
        autoStartDone.resolve();
        return backendState;
      },
      getSidebarControlAvailability: async () => ({
        modalConfigured: backendState.status === "healthy",
        availableSkills:
          backendState.status === "healthy"
            ? [
                {
                  id: "peer-review",
                  name: "Peer Review",
                  description: "Review manuscripts critically",
                  author: "K-Dense",
                  license: "MIT",
                  compatibility: "built-in",
                },
              ]
            : [],
      }),
      sendChat: async () => {
        throw new Error("not used in this test");
      },
      onDidChangeState: backendEvents.event,
      dispose() {
        backendEvents.dispose();
      },
    };
    const context = createMockExtensionContext();
    const provider = new KadyChatViewProvider(context, {
      backendAdapter: backendAdapter as never,
      getWorkspaceTrustState: () => createWorkspaceTrustState(true),
    });
    const targetId = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    (provider as unknown as { currentTargetId?: string }).currentTargetId = targetId;

    const fakeWebview = createFakeWebview();
    provider.resolveWebviewView({ webview: fakeWebview } as vscode.WebviewView);

    const initialState = await (provider as unknown as {
      ensureSidebarState(): Promise<ReturnType<typeof createSidebarScaffoldState>>;
    }).ensureSidebarState();
    assert.deepEqual(initialState.availableSkills, []);
    assert.equal(initialState.modalConfigured, false);

    healthRefreshGate.resolve();
    await autoStartDone.promise;
    await flushAsyncWork();

    const refreshedState = (provider as unknown as {
      currentSidebarState: ReturnType<typeof createSidebarScaffoldState> | null;
    }).currentSidebarState;
    assert.ok(refreshedState);
    assert.equal(refreshedState?.backend.status, "healthy");
    assert.equal(refreshedState?.modalConfigured, true);
    assert.equal(refreshedState?.availableSkills.length, 1);
    assert.equal(refreshedState?.availableSkills[0]?.id, "peer-review");
  });

  test("restricted mode UI is rendered explicitly in sidebar and preview shells", () => {
    const restrictedState = createWorkspaceTrustState(false);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", restrictedState),
      createBackendServiceState("unavailable", {
        detail: "Backend status has not been checked yet.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
    );

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "",
      pendingChatSend: false,
      selectedTargetId: sidebarState.selectedTargetId,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });
    const previewHtml = renderPreviewShell(
      "Preview",
      "Body",
      false,
      "Preview bridge connected. Restricted Mode is active for host-backed preview flows.",
      "preview",
      restrictedState,
    );

    assert.match(sidebarHtml, /Restricted Mode/);
    assert.match(sidebarHtml, /read-only in Restricted Mode/);
    assert.match(sidebarHtml, /Trust required/);
    assert.match(previewHtml, /Restricted Mode/);
    assert.match(previewHtml, /Preview open: true/);
  });

  test("trusted sidebar render ports the real chat hierarchy instead of using the old scaffold shell", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", trustedState),
      createBackendServiceState("healthy", {
        detail: "Backend healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        modalConfigured: true,
        availableSkills: [
          {
            id: "peer-review",
            name: "Peer Review",
            description: "Review manuscripts critically",
            author: "K-Dense",
            license: "MIT",
            compatibility: "built-in",
          },
        ],
      },
    );

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "Draft question",
      pendingChatSend: false,
      selectedTargetId: sidebarState.selectedTargetId,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });

    assert.match(sidebarHtml, /Chat header/);
    assert.match(sidebarHtml, /What can I help you with\?/);
    assert.match(sidebarHtml, /I can research topics, write code, analyze data, and delegate tasks to specialized agents\./);
    assert.match(sidebarHtml, /<form[^>]*composer-shell/);
    assert.match(sidebarHtml, /data-chat-input/);
    assert.match(sidebarHtml, /data-chat-send/);
    assert.match(sidebarHtml, /Session provenance/);
    assert.match(sidebarHtml, /data-sidebar-tab="chat"/);
    assert.match(sidebarHtml, /data-sidebar-tab="workflows"/);
    assert.match(sidebarHtml, /data-model-select/);
    assert.match(sidebarHtml, /Claude Opus 4\.6/);
    assert.match(sidebarHtml, /NASA APIs/);
    assert.match(sidebarHtml, /data-compute-select/);
    assert.match(sidebarHtml, /Peer Review/);
    assert.doesNotMatch(sidebarHtml, /Start a conversation with Kady/);
    assert.doesNotMatch(sidebarHtml, /The extension now uses the real host-mediated chat path/);
  });





test("settings tab render shows scoped settings and runtime controls", () => {
  const trustedState = createWorkspaceTrustState(true);
  const sidebarState = createSidebarScaffoldState(
    createBridgeState("sidebar", trustedState),
    createBackendServiceState("unavailable", {
      detail: "Backend unavailable.",
      baseUrl: "http://127.0.0.1:8000",
      executionLocation: "desktop",
    }),
    {
      settings: {
        showReasoning: true,
        showProvenance: false,
        defaultModelId: "openrouter/anthropic/claude-opus-4.6",
        defaultComputeId: "local",
      },
      globalSettings: {
        showReasoning: true,
        showProvenance: false,
        defaultModelId: "openrouter/anthropic/claude-opus-4.6",
        defaultComputeId: "local",
      },
      workspaceSettings: {
        showReasoning: false,
        showProvenance: true,
        defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
        defaultComputeId: "t4",
      },
      secretMetadata: {
        hasGlobalOpenRouterApiKey: true,
        hasWorkspaceOpenRouterApiKey: true,
        effectiveOpenRouterApiKeyScope: "workspace",
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
    },
  );

  const sidebarHtml = renderSidebarToStaticMarkup({
    state: sidebarState,
    pendingBackendAction: null,
    composerDraft: "",
    pendingChatSend: false,
    selectedTargetId: sidebarState.selectedTargetId,
    initialActiveTab: "settings",
    onComposerDraftChange: () => undefined,
    onTargetChange: () => undefined,
    onSend: () => undefined,
    onBackendAction: () => undefined,
    onSettingsUpdate: () => undefined,
  });

  assert.match(sidebarHtml, /data-sidebar-tab="settings"/);
  assert.match(sidebarHtml, />Global</);
  assert.match(sidebarHtml, />Project</);
  assert.match(sidebarHtml, /Primary defaults/);
  assert.match(sidebarHtml, /Primary overrides/);
  assert.match(sidebarHtml, /Advanced provider secrets/);
  assert.match(sidebarHtml, /data-settings-save="global"/);
  assert.match(sidebarHtml, /data-settings-save="workspace"/);
  assert.match(sidebarHtml, /data-settings-secret="global-openrouter"/);
  assert.match(sidebarHtml, /data-backend-action="refresh"/);
  assert.match(sidebarHtml, /data-backend-action="start"/);
});


test("workflows tab render shows workflow launcher and hides chat composer", () => {
  const trustedState = createWorkspaceTrustState(true);
  const sidebarState = createSidebarScaffoldState(
    createBridgeState("sidebar", trustedState),
    createBackendServiceState("healthy", {
      detail: "Backend healthy.",
      baseUrl: "http://127.0.0.1:8000",
      executionLocation: "desktop",
    }),
    {
      modalConfigured: true,
      availableSkills: [
        {
          id: "peer-review",
          name: "Peer Review",
          description: "Review manuscripts critically",
          author: "K-Dense",
          license: "MIT",
          compatibility: "built-in",
        },
      ],
    },
  );

  const sidebarHtml = renderSidebarToStaticMarkup({
    state: sidebarState,
    pendingBackendAction: null,
    composerDraft: "",
    pendingChatSend: false,
    selectedTargetId: sidebarState.selectedTargetId,
    initialActiveTab: "workflows",
    onComposerDraftChange: () => undefined,
    onTargetChange: () => undefined,
    onSend: () => undefined,
    onBackendAction: () => undefined,
    onSettingsUpdate: () => undefined,
  });

  assert.match(sidebarHtml, /data-sidebar-tab="workflows"/);
  assert.match(sidebarHtml, /data-workflows-search/);
  assert.match(sidebarHtml, /Review a Paper/);
  assert.match(sidebarHtml, /data-workflow-preview/);
  assert.match(sidebarHtml, /data-workflow-edit-toggle/);
  assert.match(sidebarHtml, /Run workflow/);
  assert.doesNotMatch(sidebarHtml, /data-chat-input/);
});

  test("deterministic sidebar render hides workspace target controls", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = {
      ...createSidebarScaffoldState(
        createBridgeState("sidebar", trustedState),
        createBackendServiceState("healthy", {
          detail: "Backend healthy.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        }),
      ),
      targetOptions: [{ id: "file:///workspace-a", name: "workspace-a" }],
      selectedTargetId: "file:///workspace-a",
      targetRequirement: undefined,
    };

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "Draft question",
      pendingChatSend: false,
      selectedTargetId: sidebarState.selectedTargetId,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });

    assert.doesNotMatch(sidebarHtml, /data-workspace-target/);
    assert.doesNotMatch(sidebarHtml, /Choose workspace folder/);
  });

  test("multi-root sidebar render requires explicit workspace target selection before execute actions", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = {
      ...createSidebarScaffoldState(
        createBridgeState("sidebar", trustedState),
        createBackendServiceState("healthy", {
          detail: "Backend healthy.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        }),
      ),
      targetOptions: [
        { id: "file:///workspace-a", name: "workspace-a" },
        { id: "file:///workspace-b", name: "workspace-b" },
      ],
      selectedTargetId: undefined,
      targetRequirement:
        "Choose a target workspace folder before sending chat requests or starting the backend from the sidebar.",
    };

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "Draft question",
      pendingChatSend: false,
      selectedTargetId: undefined,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });

    assert.match(sidebarHtml, /Choose a workspace target/);
    assert.match(sidebarHtml, /data-workspace-target/);
    assert.match(sidebarHtml, /data-chat-send="true" disabled/);
  });

  test("sidebar runtime uses the React ported component stack instead of the old sidebar-shell renderer", async () => {
    const mainSource = await fs.readFile(
      path.resolve(__dirname, "../../../src/webview/main.tsx"),
      "utf8",
    );
    const sidebarAppSource = await fs.readFile(
      path.resolve(__dirname, "../../../src/webview/sidebar-app.tsx"),
      "utf8",
    );

    assert.match(mainSource, /createRoot/);
    assert.match(mainSource, /SidebarApp/);
    assert.doesNotMatch(mainSource, /renderSidebarShell/);
    assert.match(sidebarAppSource, /components\/ai-elements\/conversation/);
    assert.match(sidebarAppSource, /components\/ai-elements\/message/);
    assert.match(sidebarAppSource, /components\/ai-elements\/prompt-input/);
    assert.match(sidebarAppSource, /components\/provenance-panel/);
  });

  test("extension activation no longer relies on retainContextWhenHidden for sidebar or preview", async () => {
    const extensionSource = await fs.readFile(
      path.resolve(__dirname, "../../../src/extension.ts"),
      "utf8",
    );

    assert.doesNotMatch(extensionSource, /retainContextWhenHidden\s*:\s*true/);
  });

  test("sidebar webview runtime keeps backend access off direct fetch and localhost calls", async () => {
    const webviewFiles = [
      path.resolve(__dirname, "../../../src/webview/main.tsx"),
      path.resolve(__dirname, "../../../src/webview/bridge-client.ts"),
      path.resolve(__dirname, "../../../src/webview/sidebar-app.tsx"),
    ];

    for (const filePath of webviewFiles) {
      const content = await fs.readFile(filePath, "utf8");
      assert.equal(
        /\bfetch\s*\(/.test(content),
        false,
        `${filePath.toString()} should not call fetch directly`,
      );
      assert.equal(
        /http:\/\/localhost/i.test(content),
        false,
        `${filePath.toString()} should not hardcode localhost backend access`,
      );
    }
  });
});


function createFakeWebview() {
  return {
    html: "",
    options: undefined as vscode.WebviewOptions | undefined,
    postMessage: async () => true,
    asWebviewUri(uri: vscode.Uri) {
      return uri;
    },
  } as unknown as vscode.Webview;
}

function createMockExtensionContext() {
  const workspaceState = new Map<string, unknown>();
  const globalState = new Map<string, unknown>();
  const secrets = new Map<string, string>();

  return {
    extensionUri: vscode.Uri.file("/tmp/kdense-extension"),
    subscriptions: [],
    workspaceState: {
      get: (key: string) => workspaceState.get(key),
      update: async (key: string, value: unknown) => {
        workspaceState.set(key, value);
      },
    },
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => {
        globalState.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
