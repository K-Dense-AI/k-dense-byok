import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { createBackendServiceState } from "../../src/shared/backend-service";
import type { SidebarScaffoldState } from "../../src/shared/sidebar-scaffold";
import { createWebviewBridge } from "../../src/webview/bridge-client";
import {
  handleBridgeMessage,
  inferRequestId,
  inferRequestType,
} from "../../src/host/webview-bridge-router";
import {
  createWorkspaceTrustState,
} from "../../src/shared/workspace-trust";
import { createSidebarWindowState } from "../../src/shared/sidebar-persistence";
import {
  BRIDGE_VERSION,
  type BridgeSuccessResponse,
  createBridgeState,
  type HostToWebviewMessage,
  parseHostMessage,
} from "../../src/shared/webview-bridge";

suite("webview bridge contract", () => {
  test("accepts a valid ready request and returns typed response plus state event", async () => {
    const postedMessages: HostToWebviewMessage[] = [];

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-1",
        type: "bridge.ready",
        payload: {
          surface: "sidebar",
        },
      },
      {
        getBridgeState: (surface) =>
          createBridgeState(surface, createWorkspaceTrustState(false)),
        backendAdapter: {
          getState: () =>
            createBackendServiceState("unavailable", {
              detail: "Backend is not running yet.",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
        } as never,
      },
    );

    assert.equal(postedMessages.length, 2);

    const [response, event] = postedMessages;

    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (response.kind === "response" && response.ok && response.type === "bridge.ready") {
      const readyResponse = response as BridgeSuccessResponse<"bridge.ready">;
      assert.equal(readyResponse.payload.surface, "sidebar");
      assert.equal(readyResponse.payload.connected, true);
      assert.equal(readyResponse.payload.trust.mode, "restricted");
      assert.equal(readyResponse.payload.trust.capabilities.previewOpen, true);
      assert.equal(readyResponse.payload.trust.capabilities.write, false);
    }

    assert.equal(event.kind, "event");
    if (event.kind === "event" && event.type === "bridge.state") {
      const payload = event.payload as { surface: string };
      assert.equal(event.type, "bridge.state");
      assert.equal(payload.surface, "sidebar");
    }
  });

  test("returns scaffold sidebar state over the typed bridge", async () => {
    const postedMessages: HostToWebviewMessage[] = [];

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-boot-1",
        type: "sidebar.bootstrap",
        payload: {
          surface: "sidebar",
        },
      },
      {
        getBridgeState: (surface) =>
          createBridgeState(surface, createWorkspaceTrustState(false)),
        backendAdapter: {
          getState: () =>
            createBackendServiceState("unavailable", {
              detail: "Backend is not running yet.",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
        } as never,
      },
    );

    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;

    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (
      response.kind === "response" &&
      response.ok &&
      response.type === "sidebar.bootstrap"
    ) {
      const sidebarResponse = response as BridgeSuccessResponse<"sidebar.bootstrap">;
      assert.equal(sidebarResponse.type, "sidebar.bootstrap");
      assert.match(sidebarResponse.payload.heading, /sidebar/i);
      assert.equal(sidebarResponse.payload.messages.length, 0);
      assert.equal(sidebarResponse.payload.provenance.length, 0);
      assert.equal(sidebarResponse.payload.trust.mode, "restricted");
      assert.match(sidebarResponse.payload.status, /restricted mode/i);
      assert.equal(sidebarResponse.payload.backend.status, "unavailable");
      assert.equal(sidebarResponse.payload.modalConfigured, false);
      assert.deepEqual(sidebarResponse.payload.availableSkills, []);
    }
  });

  test("routes sidebar chat send through the host bridge and returns updated session state", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let chatCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-chat-1",
        type: "sidebar.chat.send",
        payload: {
          surface: "sidebar",
          text: "hello from the sidebar",
          workspaceTargetId: "file:///workspace-b",
          modelId: "openrouter/anthropic/claude-opus-4.6",
        },
      },
      {
        handleSidebarChatSend: async (payload): Promise<SidebarScaffoldState> => {
          chatCalls += 1;
          return {
            workspaceIdentity: "workspace:test",
            heading: "Kady chat is ready in the sidebar",
            body: "Real chat body",
            status: "Sidebar bridge connected.",
            trust: createWorkspaceTrustState(true),
            backend: createBackendServiceState("healthy", {
              detail: "Backend healthy",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
            settings: {
              showReasoning: true,
              showProvenance: true,
              defaultModelId: "openrouter/anthropic/claude-opus-4.6",
              defaultComputeId: "local",
            },
            globalSettings: {
              showReasoning: true,
              showProvenance: true,
              defaultModelId: "openrouter/anthropic/claude-opus-4.6",
              defaultComputeId: "local",
            },
            workspaceSettings: undefined,
            secretMetadata: {
              hasGlobalOpenRouterApiKey: false,
              hasWorkspaceOpenRouterApiKey: false,
              effectiveOpenRouterApiKeyScope: null,
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
            modalConfigured: true,
            availableSkills: [],
            composerPlaceholder: "Ask Kady",
            composerHint: `${payload.text} @ ${payload.workspaceTargetId ?? "missing"} @ ${payload.modelId ?? "missing-model"}`,
            targetOptions: [],
            selectedTargetId: payload.workspaceTargetId,
            targetRequirement: undefined,
            messages: [
              {
                id: "assistant-1",
                role: "assistant",
                content: "hello from the host",
                timestampLabel: "Just now",
              },
            ],
            provenance: [],
          };
        },
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => true,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(chatCalls, 1);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (response.kind === "response" && response.ok && response.type === "sidebar.chat.send") {
      const chatResponse = response as BridgeSuccessResponse<"sidebar.chat.send">;
      assert.equal(chatResponse.payload.messages.at(-1)?.content, "hello from the host");
      assert.equal(chatResponse.payload.composerHint, "hello from the sidebar @ file:///workspace-b @ openrouter/anthropic/claude-opus-4.6");
    }
  });

  test("denies sidebar chat send in restricted mode", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let chatCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-chat-2",
        type: "sidebar.chat.send",
        payload: {
          surface: "sidebar",
          text: "blocked",
        },
      },
      {
        handleSidebarChatSend: async () => {
          chatCalls += 1;
          throw new Error("should not run");
        },
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => false,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(chatCalls, 0);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    if (response.kind === "response" && !response.ok) {
      assert.equal(response.error.code, "CAPABILITY_DENIED");
      assert.match(response.error.message, /Execute actions/);
    }
  });

  test("blocks ambiguous multi-root sidebar chat until an explicit target is chosen", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let chatCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-chat-ambiguous",
        type: "sidebar.chat.send",
        payload: {
          surface: "sidebar",
          text: "blocked by target selection",
        },
      },
      {
        handleSidebarChatSend: async () => {
          chatCalls += 1;
          throw new Error("Choose a target workspace folder before running this action.");
        },
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => true,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(chatCalls, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    if (response.kind === "response" && !response.ok) {
      assert.equal(response.error.code, "BACKEND_ACTION_FAILED");
      assert.match(response.error.message, /target workspace folder/i);
    }
  });

  test("routes sidebar settings update through the host bridge and returns updated scaffold state", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let settingsCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-settings-1",
        type: "sidebar.settings.update",
        payload: {
          surface: "sidebar",
          globalSettings: {
            showReasoning: false,
            showProvenance: true,
            defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
            defaultComputeId: "local",
          },
          workspaceSettings: null,
          globalOpenRouterApiKey: "sk-global",
        },
      },
      {
        handleSidebarSettingsUpdate: async (): Promise<SidebarScaffoldState> => {
          settingsCalls += 1;
          return {
            workspaceIdentity: "workspace:test",
            heading: "Kady sidebar",
            body: "Settings updated",
            status: "Sidebar bridge connected.",
            trust: createWorkspaceTrustState(true),
            backend: createBackendServiceState("healthy", {
              detail: "Backend healthy",
              baseUrl: "http://127.0.0.1:17800",
              executionLocation: "desktop",
            }),
            settings: {
              showReasoning: false,
              showProvenance: true,
              defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
              defaultComputeId: "local",
            },
            globalSettings: {
              showReasoning: false,
              showProvenance: true,
              defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
              defaultComputeId: "local",
            },
            workspaceSettings: undefined,
            secretMetadata: {
              hasGlobalOpenRouterApiKey: true,
              hasWorkspaceOpenRouterApiKey: false,
              effectiveOpenRouterApiKeyScope: "global",
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
            modalConfigured: true,
            availableSkills: [],
            composerPlaceholder: "Ask Kady anything…",
            composerHint: "Updated settings",
            targetOptions: [],
            selectedTargetId: undefined,
            targetRequirement: undefined,
            messages: [],
            provenance: [],
          };
        },
      },
    );

    assert.equal(settingsCalls, 1);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (response.kind === "response" && response.ok && response.type === "sidebar.settings.update") {
      const settingsResponse = response as BridgeSuccessResponse<"sidebar.settings.update">;
      assert.equal(settingsResponse.payload.settings.showReasoning, false);
      assert.equal(settingsResponse.payload.secretMetadata.effectiveOpenRouterApiKeyScope, "global");
    }
  });

  test("routes preview LaTeX compile through the host bridge and returns trusted success output", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let compileCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "preview",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "preview-latex-1",
        type: "preview.latex.compile",
        payload: {
          surface: "preview",
          engine: "xelatex",
        },
      },
      {
        handlePreviewLatexCompile: async (payload) => {
          compileCalls += 1;
          assert.equal(payload.engine, "xelatex");
          return {
            success: true,
            engine: "xelatex",
            command: "latexmk",
            commandLine: "latexmk -xelatex paper.tex",
            statusMessage: "Compilation succeeded with latexmk.",
            stdout: "latexmk stdout",
            stderr: "",
            log: "This is pdfTeX",
            pdfUri: vscode.Uri.parse("file:///workspace/paper.pdf"),
          };
        },
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => true,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(compileCalls, 1);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (response.kind === "response" && response.ok && response.type === "preview.latex.compile") {
      const compileResponse = response as BridgeSuccessResponse<"preview.latex.compile">;
      assert.equal(compileResponse.payload.success, true);
      assert.equal(compileResponse.payload.command, "latexmk");
      assert.equal(compileResponse.payload.pdfUri, "file:///workspace/paper.pdf");
      assert.match(compileResponse.payload.log, /pdfTeX/);
    }
  });

  test("returns trusted preview LaTeX compile failure with log output instead of pretending success", async () => {
    const postedMessages: HostToWebviewMessage[] = [];

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "preview",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "preview-latex-2",
        type: "preview.latex.compile",
        payload: {
          surface: "preview",
          engine: "pdflatex",
        },
      },
      {
        handlePreviewLatexCompile: async () => ({
          success: false,
          engine: "pdflatex",
          command: "pdflatex",
          commandLine: "pdflatex paper.tex",
          statusMessage: "Compilation failed with pdflatex. Review the log output below.",
          stdout: "stdout text",
          stderr: "stderr text",
          log: "! Undefined control sequence.",
        }),
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => true,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (response.kind === "response" && response.ok && response.type === "preview.latex.compile") {
      const compileResponse = response as BridgeSuccessResponse<"preview.latex.compile">;
      assert.equal(compileResponse.payload.success, false);
      assert.equal(compileResponse.payload.pdfUri, undefined);
      assert.match(compileResponse.payload.stderr, /stderr text/);
      assert.match(compileResponse.payload.log, /Undefined control sequence/);
    }
  });

  test("denies preview LaTeX compile in restricted mode", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let compileCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "preview",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "preview-latex-3",
        type: "preview.latex.compile",
        payload: {
          surface: "preview",
          engine: "lualatex",
        },
      },
      {
        handlePreviewLatexCompile: async () => {
          compileCalls += 1;
          throw new Error("should not run");
        },
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => false,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(compileCalls, 0);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    if (response.kind === "response" && !response.ok) {
      assert.equal(response.error.code, "CAPABILITY_DENIED");
      assert.match(response.error.message, /Execute actions/);
    }
  });

  test("routes backend refresh through the host adapter instead of direct webview HTTP", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let refreshCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-backend-1",
        type: "sidebar.backend.action",
        payload: {
          surface: "sidebar",
          action: "refresh",
        },
      },
      {
        backendAdapter: {
          getState: () =>
            createBackendServiceState("unavailable", {
              detail: "idle",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
          refreshStatus: async () => {
            refreshCalls += 1;
            return createBackendServiceState("healthy", {
              detail: "Backend health check succeeded through the host adapter.",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            });
          },
        } as never,
      },
    );

    assert.equal(refreshCalls, 1);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
    if (
      response.kind === "response" &&
      response.ok &&
      response.type === "sidebar.backend.action"
    ) {
      const backendResponse = response as BridgeSuccessResponse<"sidebar.backend.action">;
      assert.equal(backendResponse.payload.status, "healthy");
      assert.match(backendResponse.payload.detail, /host adapter/i);
    }
  });


  test("passes explicit workspace target through backend start", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let receivedTargetId: string | undefined;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-backend-explicit",
        type: "sidebar.backend.action",
        payload: {
          surface: "sidebar",
          action: "start",
          workspaceTargetId: "file:///workspace-b",
        },
      },
      {
        backendAdapter: {
          getState: () =>
            createBackendServiceState("unavailable", {
              detail: "idle",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
          startBackend: async (options?: { workspaceTargetId?: string }) => {
            receivedTargetId = options?.workspaceTargetId;
            return createBackendServiceState("healthy", {
              detail: "started",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            });
          },
        } as never,
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => true,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(receivedTargetId, "file:///workspace-b");
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, true);
  });

  test("denies backend start in restricted mode before the adapter runs", async () => {
    const postedMessages: HostToWebviewMessage[] = [];
    let startCalls = 0;

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-backend-2",
        type: "sidebar.backend.action",
        payload: {
          surface: "sidebar",
          action: "start",
          workspaceTargetId: undefined,
        },
      },
      {
        backendAdapter: {
          getState: () =>
            createBackendServiceState("unavailable", {
              detail: "idle",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            }),
          startBackend: async () => {
            startCalls += 1;
            return createBackendServiceState("healthy", {
              detail: "should not run",
              baseUrl: "http://127.0.0.1:8000",
              executionLocation: "desktop",
            });
          },
        } as never,
        workspaceTrustDependencies: {
          isWorkspaceTrusted: () => false,
          showWarningMessage: async () => undefined,
        },
      },
    );

    assert.equal(startCalls, 0);
    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;
    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    if (response.kind === "response" && !response.ok) {
      assert.equal(response.error.code, "CAPABILITY_DENIED");
      assert.match(response.error.message, /Backend start/);
    }
  });

  test("rejects unknown request types with an explicit bridge error", async () => {
    const postedMessages: HostToWebviewMessage[] = [];

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "sidebar",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "sidebar-2",
        type: "bridge.unknown",
        payload: {},
      },
    );

    assert.equal(postedMessages.length, 1);
    const [response] = postedMessages;

    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    if (response.kind === "response" && !response.ok) {
      assert.equal(response.error.code, "UNKNOWN_MESSAGE_TYPE");
      assert.match(response.error.message, /Unsupported bridge request type/);
    }
  });

  test("rejects schema and version mismatches", async () => {
    const postedMessages: HostToWebviewMessage[] = [];

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "preview",
      {
        version: BRIDGE_VERSION + 1,
        kind: "request",
        requestId: "preview-1",
        type: "bridge.ready",
        payload: {
          surface: "preview",
        },
      },
    );

    await handleBridgeMessage(
      {
        postMessage(message) {
          const parsed = parseHostMessage(message);
          assert.equal(parsed.ok, true);
          if (parsed.ok) {
            postedMessages.push(parsed.value);
          }
          return true;
        },
      },
      "preview",
      {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "preview-2",
        type: "bridge.ready",
        payload: {
          surface: "sidebar",
        },
      },
    );

    assert.equal(postedMessages.length, 2);

    const [versionMismatch, surfaceMismatch] = postedMessages;
    assert.equal(versionMismatch.kind, "response");
    assert.equal(surfaceMismatch.kind, "response");

    if (versionMismatch.kind === "response" && !versionMismatch.ok) {
      assert.equal(versionMismatch.error.code, "UNSUPPORTED_VERSION");
      assert.equal(versionMismatch.requestId, inferRequestId({ requestId: "preview-1" }));
      assert.equal(versionMismatch.type, inferRequestType({ type: "bridge.ready" }));
    }

    if (surfaceMismatch.kind === "response" && !surfaceMismatch.ok) {
      assert.equal(surfaceMismatch.error.code, "SURFACE_MISMATCH");
      assert.match(surfaceMismatch.error.message, /owns this webview/);
    }
  });

  test("completes the live bridge handshake through the webview client", async () => {
    const listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>();
    const postedRequests: unknown[] = [];
    const fakeWindow = {
      addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
        const group = listeners.get(type) ?? new Set();
        group.add(listener);
        listeners.set(type, group);
      },
      removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
        listeners.get(type)?.delete(listener);
      },
      dispatchMessage(data: unknown) {
        const event = { data } as MessageEvent<unknown>;
        for (const listener of listeners.get("message") ?? []) {
          listener(event);
        }
      },
    };

    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
    });

    try {
      const events: HostToWebviewMessage[] = [];
      const bridge = createWebviewBridge({
        surface: "preview",
        vscodeApi: {
          getState() {
            return { lastRequestId: 0 };
          },
          setState() {
            return undefined;
          },
          postMessage(message) {
            postedRequests.push(message);

            void handleBridgeMessage(
              {
                postMessage(hostMessage) {
                  const parsed = parseHostMessage(hostMessage);
                  assert.equal(parsed.ok, true);
                  if (parsed.ok) {
                    events.push(parsed.value);
                  }
                  fakeWindow.dispatchMessage(hostMessage);
                  return true;
                },
              },
              "preview",
              message,
            );
          },
        },
        onEvent(message) {
          events.push(message);
        },
      });

      const response = await bridge.ready();

      assert.equal(postedRequests.length, 1);
      assert.deepEqual(postedRequests[0], {
        version: BRIDGE_VERSION,
        kind: "request",
        requestId: "preview-1",
        type: "bridge.ready",
        payload: {
          surface: "preview",
        },
      });
      assert.equal(response.surface, "preview");
      assert.equal(response.connected, true);
      assert.ok(events.some((message) => message.kind === "event" && message.type === "bridge.state"));

      bridge.dispose();
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
    }
  });

  test("webview client keeps sidebar window restore state in VS Code webview state", () => {
    const listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>();
    const persistedStates: unknown[] = [];
    const originalWindow = globalThis.window;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
          const group = listeners.get(type) ?? new Set();
          group.add(listener);
          listeners.set(type, group);
        },
        removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
          listeners.get(type)?.delete(listener);
        },
      },
    });

    try {
      const initialWindowState = createSidebarWindowState({
        workspaceIdentity: "file:///workspace/alpha",
        bridgeStatus: "Restored from VS Code state",
      });
      const bridge = createWebviewBridge({
        surface: "sidebar",
        vscodeApi: {
          getState() {
            return {
              lastRequestId: 4,
              sidebarWindowState: initialWindowState,
            };
          },
          setState(state) {
            persistedStates.push(state);
          },
          postMessage() {
            return undefined;
          },
        },
      });

      assert.equal(bridge.getWindowState()?.bridgeStatus, "Restored from VS Code state");

      bridge.setWindowState(
        createSidebarWindowState({
          workspaceIdentity: "file:///workspace/alpha",
          bridgeStatus: "Updated in window",
        }),
      );

      assert.deepEqual(persistedStates.at(-1), {
        lastRequestId: 4,
        sidebarWindowState: createSidebarWindowState({
          workspaceIdentity: "file:///workspace/alpha",
          bridgeStatus: "Updated in window",
        }),
      });

      bridge.dispose();
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
    }
  });
});
