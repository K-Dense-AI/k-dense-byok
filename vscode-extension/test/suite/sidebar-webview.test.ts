import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { createBackendServiceState } from "../../src/shared/backend-service";
import { createSidebarScaffoldState } from "../../src/shared/sidebar-scaffold";
import { createBridgeState } from "../../src/shared/webview-bridge";
import { createWorkspaceTrustState } from "../../src/shared/workspace-trust";
import { KadyChatViewProvider } from "../../src/views/kady-chat-view-provider";
import { renderWebviewHtml } from "../../src/webview/render-webview-html";
import { isConversationNearBottom } from "../../src/webview/components/ai-elements/conversation";
import { getPromptInputAutosizeLayout } from "../../src/webview/components/ai-elements/prompt-input";
import { renderPreviewShell, sharedWebviewStyles } from "../../src/webview/sidebar-shell";
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

  test("webview html establishes the root height chain for bounded sidebar layouts", () => {
    const html = renderWebviewHtml(
      createFakeWebview(),
      vscode.Uri.file("/tmp/kdense-extension"),
      {
        title: "Kady Chat",
        heading: "Kady Chat",
        body: "Sidebar bridge ready.",
        kind: "sidebar",
      },
    );

    assert.match(html, /html,\s*body,\s*#app\s*{\s*height:\s*100%;\s*}/s);
    assert.match(html, /body\s*{\s*overflow:\s*hidden;\s*}/s);
  });

  test("sidebar activation refreshes backend status without auto-starting a runtime", async () => {
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
      stopBackend: async () =>
        createBackendServiceState("unavailable", {
          detail: "Stopped backend.",
          baseUrl: "http://127.0.0.1:8000",
          executionLocation: "desktop",
        }),
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
    assert.equal(startCalls, 0);
  });
  test("fresh trusted sidebar state repopulates skills after an explicit backend healthy event", async () => {
    const healthRefreshGate = createDeferred<void>();
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
        return backendState;
      },
      stopBackend: async () => backendState,
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
    await provider.primeBackendForSidebarActivation();
    backendState = createBackendServiceState("healthy", {
      detail: "Backend healthy and prepared runtime is available.",
      baseUrl: "http://127.0.0.1:8000",
      executionLocation: "desktop",
    });
    backendEvents.fire(backendState);
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

  test("trusted populated sidebar render encodes transcript, composer, and collapsed provenance dock order", () => {
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
        session: {
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Draft question",
              timestampLabel: "Just now",
              chips: ["Workspace", "Trusted"],
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Draft answer",
              timestampLabel: "Just now",
              chips: ["Host bridge", "Model Claude Opus 4.6"],
            },
          ],
          provenance: [
            {
              id: "prov-user-1",
              type: "user_query",
              label: "User query",
              detail: "Draft question",
              relativeTime: "just now",
              chips: [
                { label: "Surface", value: "sidebar" },
                { label: "Session", value: "session-1" },
              ],
            },
            {
              id: "prov-assistant-1",
              type: "assistant_response",
              label: "Assistant response",
              detail: "Draft answer",
              relativeTime: "just now",
              chips: [{ label: "Trust", value: "Trusted" }],
            },
          ],
        },
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
    assert.match(sidebarHtml, /data-chat-region="transcript"/);
    assert.match(sidebarHtml, /data-chat-region="composer"/);
    assert.match(sidebarHtml, /data-chat-region="provenance"/);
    assertRegionOrder(sidebarHtml, [
      'data-chat-region="transcript"',
      'data-chat-region="composer"',
      'data-chat-region="provenance"',
    ]);
    assert.match(sidebarHtml, /role="log"/);
    assert.match(sidebarHtml, /class="conversation-frame"/);
    assert.doesNotMatch(sidebarHtml, /conversation-frame--empty/);
    assert.match(sidebarHtml, /Draft question/);
    assert.match(sidebarHtml, /Draft answer/);
    assert.match(sidebarHtml, /<form[^>]*composer-shell/);
    assert.match(sidebarHtml, /data-chat-input/);
    assert.match(sidebarHtml, /data-chat-send/);
    assert.doesNotMatch(sidebarHtml, /KD × Roo composer/);
    assert.doesNotMatch(sidebarHtml, /Enter to send, Shift\+Enter for a newline\./);
    assert.doesNotMatch(sidebarHtml, /All backend access stays host-mediated\./);
    assert.match(sidebarHtml, /aria-label="Composer controls"/);
    assert.match(sidebarHtml, /composer__cluster composer__cluster--core/);
    assert.match(sidebarHtml, /composer__cluster composer__cluster--context/);
    assert.match(
      sidebarHtml,
      /<details[^>]*data-chat-region="provenance"[^>]*aria-label="Session provenance"(?![^>]*\sopen=|[^>]*\sopen>)/,
    );
    assert.match(sidebarHtml, /<details[^>]*class="sidebar-drawer provenance-dock"/);
    assert.match(sidebarHtml, /<span class="provenance-dock__title-row">\s*<span>Session provenance<\/span>\s*<span class="chip">2 events<\/span>\s*<\/span>/);
    assert.match(sidebarHtml, /<span class="provenance-dock__preview">Assistant response · just now · Draft answer<\/span>/);
    assert.match(sidebarHtml, /class="sidebar-drawer__body provenance-dock__body"/);
    assert.match(sidebarHtml, /User query/);
    assert.match(sidebarHtml, /Assistant response/);
    assert.match(sidebarHtml, /data-sidebar-tab="chat"/);
    assert.match(sidebarHtml, /data-sidebar-tab="workflows"/);
    assert.match(sidebarHtml, /data-model-select/);
    assert.match(sidebarHtml, /Claude Opus 4\.6/);
    assert.match(sidebarHtml, /NASA APIs/);
    assert.match(sidebarHtml, /data-compute-select/);
    assert.match(sidebarHtml, /Peer Review/);
    assert.doesNotMatch(sidebarHtml, /What can I help you with\?/);
    assert.doesNotMatch(sidebarHtml, /Start a conversation with Kady/);
    assert.doesNotMatch(sidebarHtml, /The extension now uses the real host-mediated chat path/);
  });

  test("restored trusted sidebar render keeps persisted transcript, reasoning, and provenance visible without empty-state gaps", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", trustedState),
      createBackendServiceState("healthy", {
        detail: "Backend healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        session: {
          messages: [
            {
              id: "user-restored-1",
              role: "user",
              content: "Persisted workspace question",
              timestampLabel: "Earlier",
              chips: ["Workspace alpha", "Trusted"],
            },
            {
              id: "assistant-restored-1",
              role: "assistant",
              content: "Persisted workspace answer",
              timestampLabel: "Earlier",
              reasoning: "Recovered from persisted sidebar session.",
              chips: ["Host bridge", "Model Claude Opus 4.6"],
            },
          ],
          provenance: [
            {
              id: "prov-restored-user",
              type: "user_query",
              label: "User query",
              detail: "Persisted workspace question",
              relativeTime: "earlier",
              chips: [{ label: "Surface", value: "sidebar" }],
            },
            {
              id: "prov-restored-assistant",
              type: "assistant_response",
              label: "Assistant response",
              detail: "Persisted workspace answer",
              relativeTime: "earlier",
              chips: [{ label: "Trust", value: "Trusted" }],
            },
          ],
        },
      },
    );

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "Follow up",
      pendingChatSend: false,
      selectedTargetId: sidebarState.selectedTargetId,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });

    assertRegionOrder(sidebarHtml, [
      'data-chat-region="transcript"',
      'data-chat-region="composer"',
      'data-chat-region="provenance"',
    ]);
    assert.match(sidebarHtml, /class="conversation-frame"/);
    assert.doesNotMatch(sidebarHtml, /conversation-frame--empty/);
    assert.match(sidebarHtml, /class="message message--user"/);
    assert.match(sidebarHtml, /class="message message--assistant"/);
    assert.match(sidebarHtml, /Persisted workspace question/);
    assert.match(sidebarHtml, /Persisted workspace answer/);
    assert.match(sidebarHtml, /Recovered from persisted sidebar session\./);
    assert.match(sidebarHtml, /<details class="message__reasoning" open="">/);
    assert.match(sidebarHtml, /Workspace alpha/);
    assert.match(sidebarHtml, /Trusted/);
    assert.match(sidebarHtml, /<span class="provenance-dock__preview">Assistant response · earlier · Persisted workspace answer<\/span>/);
    assert.doesNotMatch(sidebarHtml, /What can I help you with\?/);
  });

  test("trusted restored sidebar render preserves markdown-heavy assistant messages for narrow transcript layouts", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", trustedState),
      createBackendServiceState("healthy", {
        detail: "Backend healthy.",
        baseUrl: "http://127.0.0.1:8000",
        executionLocation: "desktop",
      }),
      {
        session: {
          messages: [
            {
              id: "assistant-markdown-1",
              role: "assistant",
              content:
                "## Restored summary\n\n> A persisted answer keeps rich markdown intact.\n\nUse `inline-code` inside the narrow pane.\n\n```ts\nconst veryLongValue = 'persisted-sidebar-render';\n```\n\n- first item\n- second item\n\nLong token: kdense_restore_layout_contract_should_wrap_inside_the_transcript_without_needing_new_persisted_ui_state.",
              timestampLabel: "Earlier",
              chips: ["Host bridge", "Model Claude Opus 4.6"],
            },
          ],
          provenance: [
            {
              id: "prov-markdown-1",
              type: "assistant_response",
              label: "Assistant response",
              detail: "Rich markdown persisted for restore coverage.",
              relativeTime: "earlier",
            },
          ],
        },
      },
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

    assert.match(sidebarHtml, /message__content message__content--rich preview-markdown__body/);
    assert.match(sidebarHtml, /<h2>Restored summary<\/h2>/);
    assert.match(sidebarHtml, /<blockquote>\s*<p>A persisted answer keeps rich markdown intact\.<\/p>\s*<\/blockquote>/);
    assert.match(sidebarHtml, /<code>inline-code<\/code>/);
    assert.match(sidebarHtml, /<pre class="hljs"><code class="hljs language-ts">/);
    assert.match(sidebarHtml, /<ul>\s*<li>first item<\/li>\s*<li>second item<\/li>\s*<\/ul>/);
    assert.match(sidebarHtml, /kdense_restore_layout_contract_should_wrap_inside_the_transcript_without_needing_new_persisted_ui_state/);
    assert.match(sharedWebviewStyles, /\.conversation-frame\s*{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/);
    assert.match(sharedWebviewStyles, /\.preview-markdown__body\s*{[^}]*overflow:\s*auto;/);
    assert.match(sharedWebviewStyles, /\.preview-markdown__body pre,[^}]*\.preview-pre\s*{[^}]*overflow:\s*auto;/s);
  });

  test("trusted empty sidebar render keeps transcript above composer and omits empty provenance dock", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", trustedState),
      createBackendServiceState("healthy", {
        detail: "Backend healthy.",
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

    assert.match(sidebarHtml, /data-chat-region="transcript"/);
    assert.match(sidebarHtml, /data-chat-region="composer"/);
    assertRegionOrder(sidebarHtml, ['data-chat-region="transcript"', 'data-chat-region="composer"']);
    assert.match(sidebarHtml, /class="conversation-frame conversation-frame--empty"/);
    assert.match(sidebarHtml, /What can I help you with\?/);
    assert.match(sidebarHtml, /I can research topics, write code, analyze data, and delegate tasks to specialized agents\./);
    assert.match(sidebarHtml, /data-chat-input/);
    assert.doesNotMatch(sidebarHtml, /data-chat-region="provenance"/);
    assert.doesNotMatch(sidebarHtml, /Session provenance/);
    assert.match(sidebarHtml, /Ready to chat/);
  });

  test("trusted sidebar render with showProvenance disabled keeps transcript and composer without provenance region", () => {
    const trustedState = createWorkspaceTrustState(true);
    const sidebarState = createSidebarScaffoldState(
      createBridgeState("sidebar", trustedState),
      createBackendServiceState("healthy", {
        detail: "Backend healthy.",
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
        session: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "Draft answer",
              timestampLabel: "Just now",
            },
          ],
          provenance: [
            {
              id: "prov-assistant-1",
              type: "assistant_response",
              label: "Assistant response",
              detail: "Draft answer",
              relativeTime: "just now",
            },
          ],
        },
      },
    );

    const sidebarHtml = renderSidebarToStaticMarkup({
      state: sidebarState,
      pendingBackendAction: null,
      composerDraft: "Follow up",
      pendingChatSend: false,
      selectedTargetId: sidebarState.selectedTargetId,
      onComposerDraftChange: () => undefined,
      onTargetChange: () => undefined,
      onSend: () => undefined,
      onBackendAction: () => undefined,
      onSettingsUpdate: () => undefined,
    });

    assert.match(sidebarHtml, /data-chat-region="transcript"/);
    assert.match(sidebarHtml, /data-chat-region="composer"/);
    assertRegionOrder(sidebarHtml, ['data-chat-region="transcript"', 'data-chat-region="composer"']);
    assert.match(sidebarHtml, /Draft answer/);
    assert.match(sidebarHtml, /data-chat-input/);
    assert.doesNotMatch(sidebarHtml, /data-chat-region="provenance"/);
    assert.doesNotMatch(sidebarHtml, /Session provenance/);
    assert.match(sidebarHtml, /Ready to chat/);
  });

  test("sidebar shell keeps the provenance dock bounded and internally scrollable", () => {
    assert.match(sharedWebviewStyles, /\.chat-footer-stack__provenance\s*{[^}]*max-height:\s*16rem;[^}]*position:\s*relative;[^}]*z-index:\s*2;/);
    assert.match(sharedWebviewStyles, /\.provenance-dock\s*{[^}]*height:\s*100%;[^}]*max-height:\s*100%;/);
    assert.match(sharedWebviewStyles, /\.provenance-dock__body\s*{[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/);
    assert.match(sharedWebviewStyles, /\.provenance-list--scroll\s*{[^}]*overflow:\s*auto;/);
  });

  test("sidebar shell keeps transcript, composer, and provenance as bounded stacked regions", () => {
    assert.match(sharedWebviewStyles, /html,\s*body,\s*#app\s*{[^}]*height:\s*100%;/s);
    assert.match(sharedWebviewStyles, /#app\s*{[^}]*overflow:\s*hidden;/s);
    assert.match(sharedWebviewStyles, /\.shell--sidebar\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
    assert.match(sharedWebviewStyles, /\.sidebar-chat\s*{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/s);
    assert.match(sharedWebviewStyles, /\.chat-panel\s*{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/s);
    assert.match(sharedWebviewStyles, /\.conversation-frame\s*{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
    assert.match(sharedWebviewStyles, /\.chat-footer-stack\s*{[^}]*grid-template-rows:\s*auto auto;[^}]*overflow:\s*hidden;/s);
    assert.match(sharedWebviewStyles, /\.chat-footer-stack__composer\s*{[^}]*max-height:\s*20rem;/s);
    assert.match(sharedWebviewStyles, /\.composer__body\s*{[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  });

  test("sidebar shell keeps the provenance dock above the composer stacking layer for pointer hits", () => {
    assert.match(sharedWebviewStyles, /\.composer-shell\s*{[^}]*position:\s*relative;[^}]*z-index:\s*1;/);
    assert.match(sharedWebviewStyles, /\.chat-footer-stack__provenance\s*{[^}]*z-index:\s*2;/);
  });

  test("conversation near-bottom helper preserves anchored follow when reader is already near the bottom", () => {
    assert.equal(
      isConversationNearBottom({
        scrollTop: 552,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
      true,
    );
  });

  test("conversation near-bottom helper keeps history-reading mode when user has scrolled up", () => {
    assert.equal(
      isConversationNearBottom({
        scrollTop: 320,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
      false,
    );
  });

  test("prompt input autosize keeps multiline growth bounded for the sidebar dock", () => {
    assert.deepEqual(getPromptInputAutosizeLayout(96, 720), {
      maxHeight: 172,
      nextHeight: 96,
      overflowY: "hidden",
    });
    assert.deepEqual(getPromptInputAutosizeLayout(420, 900), {
      maxHeight: 176,
      nextHeight: 176,
      overflowY: "auto",
    });
    assert.deepEqual(getPromptInputAutosizeLayout(180, 360), {
      maxHeight: 120,
      nextHeight: 120,
      overflowY: "auto",
    });
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

function assertRegionOrder(sidebarHtml: string, markers: string[]) {
  let previousIndex = -1;
  for (const marker of markers) {
    const index = sidebarHtml.indexOf(marker);
    assert.notEqual(index, -1, `Expected to find marker ${marker}`);
    assert.ok(index > previousIndex, `Expected marker ${marker} to appear after prior chat regions`);
    previousIndex = index;
  }
}
