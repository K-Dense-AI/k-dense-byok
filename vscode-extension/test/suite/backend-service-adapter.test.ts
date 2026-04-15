import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { BackendServiceAdapter } from "../../src/host/backend-service-adapter";

suite("backend service adapter", () => {
  test("reports a healthy backend when the host health check succeeds", async () => {
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 200, statusText: "OK" }),
      getWorkspaceFolders: () => [],
      sessionOwnerId: "session-owner-healthy",
      readRuntimeOwner: async () => "session-owner-healthy",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.refreshStatus();

    assert.equal(state.status, "healthy");
    assert.equal(state.executionLocation, "desktop");
    assert.match(state.detail, /responded/);
    adapter.dispose();
  });

  test("blocks backend start in ambiguous multi-root workspaces until a target is chosen", async () => {
    const workspaceRoots = [
      createWorkspaceFolder("file:///workspace/a", 0, "a"),
      createWorkspaceFolder("file:///workspace/b", 1, "b"),
    ];
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 503, statusText: "Service Unavailable" }),
      createTerminal: () => ({
        sendText() {},
        show() {},
      }),
      getWorkspaceFolders: () => workspaceRoots,
      sleep: async () => undefined,
      healthPollAttempts: 0,
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend();

    assert.equal(state.status, "unavailable");
    assert.match(state.detail, /Choose a target workspace folder/i);
    adapter.dispose();
  });

  test("waits for /skills readiness before reporting backend start healthy", async () => {
    let terminalCwd = "";
    let startCommand = "";
    let skillsCalls = 0;
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          skillsCalls += 1;
          return skillsCalls < 2 ? Response.json([]) : Response.json([createSkillRecord()]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      createTerminal: (options) => ({
        sendText(text) {
          startCommand = text;
        },
        show() {
          terminalCwd = String(options.cwd);
        },
      }),
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sleep: async () => undefined,
      healthPollAttempts: 3,
      healthPollIntervalMs: 0,
      getRuntimeEnvironment: () => ({
        defaultModelId: "openrouter/google/gemini-3.1-pro-preview",
        openRouterApiKey: "sk-openrouter-runtime",
        parallelApiKey: "parallel-runtime",
        modalTokenId: "modal-id-runtime",
        modalTokenSecret: "modal-secret-runtime",
      }),
      sessionOwnerId: "session-owner-1",
      readRuntimeOwner: async () => "session-owner-1",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend({
      workspaceTargetId: workspaceRoot.uri.toString(),
    });

    assert.equal(state.status, "healthy");
    assert.match(state.detail, /\/skills is ready/i);
    assert.match(terminalCwd, /extension\/dist\/runtime/);
    assert.match(startCommand, /KDENSE_WORKSPACE_ROOT='\/workspace\/k-dense-byok' BACKEND_PORT=\d+ LITELLM_PORT=\d+ KDENSE_RUNTIME_OWNER='session-owner-1' DEFAULT_AGENT_MODEL='openrouter\/google\/gemini-3.1-pro-preview' OPENROUTER_API_KEY='sk-openrouter-runtime' PARALLEL_API_KEY='parallel-runtime' MODAL_TOKEN_ID='modal-id-runtime' MODAL_TOKEN_SECRET='modal-secret-runtime' bash \.\/start_kdense_backend\.sh/);
    assert.equal(skillsCalls, 2);
    adapter.dispose();
  });

  test("marks refresh as requiring initialization when bootstrap artifacts are missing", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: false });
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 503, statusText: "Service Unavailable" }),
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sessionOwnerId: "session-owner-send",
      readRuntimeOwner: async () => "session-owner-send",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.refreshStatus();

    assert.equal(state.status, "failed");
    assert.equal(state.requiresInitialization, true);
    assert.equal(state.skillsReady, false);
    assert.match(state.detail, /prep_sandbox\.py/);
    adapter.dispose();
  });

  test("initializes the workspace and then starts the backend-only runtime", async () => {
    let initCommand = "";
    let backendCommand = "";
    const runtimeState = { prepared: false };
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, {
      preparedRuntime: false,
      runtimeState,
    });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          return runtimeState.prepared ? Response.json([createSkillRecord()]) : Response.json([]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      createTerminal: () => ({
        sendText(text) {
          if (text.includes("initialize_kdense_workspace.sh")) {
            initCommand = text;
            runtimeState.prepared = true;
            return;
          }
          backendCommand = text;
        },
        show() {},
      }),
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sleep: async () => undefined,
      initializationPollAttempts: 2,
      initializationPollIntervalMs: 0,
      healthPollAttempts: 2,
      healthPollIntervalMs: 0,
      runRuntimeCommand: async () => undefined,
      sessionOwnerId: "session-owner-init",
      readRuntimeOwner: async () => "session-owner-init",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.initializeWorkspace({
      workspaceTargetId: workspaceRoot.uri.toString(),
    });

    assert.equal(state.status, "starting");
    assert.equal(state.requiresInitialization, true);
    assert.match(initCommand, /KDENSE_WORKSPACE_ROOT='\/workspace\/k-dense-byok' BACKEND_PORT=\d+ LITELLM_PORT=\d+ KDENSE_RUNTIME_OWNER='session-owner-init' bash \.\/initialize_kdense_workspace\.sh/);

    await flushAsyncWork();

    const finalState = adapter.getState();
    assert.equal(finalState.status, "healthy");
    assert.equal(finalState.requiresInitialization, false);
    assert.equal(finalState.skillsReady, true);
    assert.match(backendCommand, /KDENSE_WORKSPACE_ROOT='\/workspace\/k-dense-byok' BACKEND_PORT=\d+ LITELLM_PORT=\d+ KDENSE_RUNTIME_OWNER='session-owner-init' bash \.\/start_kdense_backend\.sh/);
    adapter.dispose();
  });

  test("fails backend start when health responds but sandbox bootstrap artifacts are missing", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: false });
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 200, statusText: "OK" }),
      createTerminal: () => ({
        sendText() {},
        show() {},
      }),
      runRuntimeCommand: async () => undefined,
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sleep: async () => undefined,
      healthPollAttempts: 1,
      healthPollIntervalMs: 0,
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend({
      workspaceTargetId: workspaceRoot.uri.toString(),
    });

    assert.equal(state.status, "failed");
    assert.match(state.detail, /prep_sandbox\.py/);
    assert.match(state.detail, /sandbox\/.venv/);
    assert.match(state.detail, /sandbox\/.gemini\/skills/);
    adapter.dispose();
  });

  test("fails backend start when /skills never becomes ready", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          return Response.json([]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      createTerminal: () => ({
        sendText() {},
        show() {},
      }),
      runRuntimeCommand: async () => undefined,
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sleep: async () => undefined,
      healthPollAttempts: 2,
      healthPollIntervalMs: 0,
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend({ workspaceTargetId: workspaceRoot.uri.toString() });

    assert.equal(state.status, "failed");
    assert.match(state.detail, /\/skills never became ready/i);
    assert.match(state.detail, /returned no installed skills/i);
    adapter.dispose();
  });

  test("keeps backend liveness healthy while reporting missing skills readiness", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          return new Response(null, { status: 503, statusText: "Service Unavailable" });
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sessionOwnerId: "session-owner-skills-health",
      readRuntimeOwner: async () => "session-owner-skills-health",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.refreshStatus();

    assert.equal(state.status, "healthy");
    assert.match(state.detail, /\/skills is not ready yet/i);
    assert.match(state.detail, /503 Service Unavailable/);
    adapter.dispose();
  });

  test("uses remote execution location when the extension host is remote", async () => {
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 200, statusText: "OK" }),
      getWorkspaceFolders: () => [],
      remoteName: "ssh-remote+research",
      sessionOwnerId: "session-owner-remote",
      readRuntimeOwner: async () => "session-owner-remote",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.refreshStatus();

    assert.equal(state.executionLocation, "remote");
    adapter.dispose();
  });

  test("treats a foreign-owned runtime as unavailable until this session takes over", async () => {
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 200, statusText: "OK" }),
      getWorkspaceFolders: () => [],
      sessionOwnerId: "session-owner-current",
      readRuntimeOwner: async () => "session-owner-other",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.refreshStatus();

    assert.equal(state.status, "unavailable");
    assert.match(state.detail, /owned by another VS Code session/i);
    adapter.dispose();
  });

  test("blocks sidebar chat in ambiguous multi-root workspaces until a target is chosen", async () => {
    const workspaceRoots = [
      createWorkspaceFolder("file:///workspace/a", 0, "a"),
      createWorkspaceFolder("file:///workspace/b", 1, "b"),
    ];
    const adapter = new BackendServiceAdapter({
      fetch: async () => new Response(null, { status: 200, statusText: "OK" }),
      getWorkspaceFolders: () => workspaceRoots,
      baseUrl: "http://127.0.0.1:8000",
    });

    await assert.rejects(
      () => adapter.sendChat("Summarize this repo"),
      /Choose a target workspace folder/i,
    );
    adapter.dispose();
  });

  test("only exposes sidebar skills from the prepared sandbox runtime", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: false });
    let skillsCalls = 0;
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/config")) {
          return Response.json({ modal_configured: true });
        }
        if (String(input).endsWith("/skills")) {
          skillsCalls += 1;
          return Response.json([createSkillRecord()]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sessionOwnerId: "session-owner-send",
      readRuntimeOwner: async () => "session-owner-send",
      baseUrl: "http://127.0.0.1:8000",
    });

    const availability = await adapter.getSidebarControlAvailability();

    assert.equal(availability.modalConfigured, true);
    assert.deepEqual(availability.availableSkills, []);
    assert.equal(skillsCalls, 0);
    adapter.dispose();
  });

  test("returns empty sidebar skills when /skills is unavailable despite backend liveness", async () => {
    const workspaceRoot = createWorkspaceFolder("file:///workspace/k-dense-byok", 0, "k-dense-byok");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/config")) {
          return Response.json({ modal_configured: true });
        }
        if (String(input).endsWith("/skills")) {
          return new Response(null, { status: 503, statusText: "Service Unavailable" });
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sessionOwnerId: "session-owner-send",
      readRuntimeOwner: async () => "session-owner-send",
      baseUrl: "http://127.0.0.1:8000",
    });

    const availability = await adapter.getSidebarControlAvailability();

    assert.equal(availability.modalConfigured, true);
    assert.deepEqual(availability.availableSkills, []);
    adapter.dispose();
  });

  test("creates a backend session and passes the explicit execution target through the real run_sse call path", async () => {
    const fetchCalls: string[] = [];
    const runSseHeaders: Headers[] = [];
    const runSseBodies: string[] = [];
    const workspaceRoot = createWorkspaceFolder("file:///workspace-b", 1, "workspace-b");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input, init) => {
        fetchCalls.push(String(input));

        if (String(input).endsWith("/config")) {
          return Response.json({ modal_configured: true });
        }

        if (String(input).endsWith("/skills")) {
          return Response.json([createSkillRecord()]);
        }

        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }

        if (String(input).includes("/sessions")) {
          return Response.json({ id: "session-123" });
        }

        runSseHeaders.push(new Headers(init?.headers));
        runSseBodies.push(typeof init?.body === "string" ? init.body : "");
        return new Response(
          [
            'data: {"modelVersion":"gemini-2.5-pro","content":{"parts":[{"functionCall":{"id":"tool-1","name":"delegate_task","args":{"prompt":"Inspect files"}}]}}',
            'data: {"partial":true,"content":{"parts":[{"text":"Hello"}]}}',
            'data: {"content":{"parts":[{"functionResponse":{"id":"tool-1","name":"delegate_task","response":{"result":"done","skills_used":["python"]}}},{"text":"Hello from Kady"}]}}',
          ].join("\n") + "\n",
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sessionOwnerId: "session-owner-send",
      readRuntimeOwner: async () => "session-owner-send",
      baseUrl: "http://127.0.0.1:8000",
    });

    const availability = await adapter.getSidebarControlAvailability();
    assert.equal(availability.modalConfigured, true);
    assert.equal(availability.availableSkills.length, 1);

    const result = await adapter.sendChat("Summarize this repo", {
      workspaceTargetId: workspaceRoot.uri.toString(),
      modelId: "openrouter/anthropic/claude-opus-4.6",
    });

    assert.equal(result.sessionId, "session-123");
    assert.equal(result.userText, "Summarize this repo");
    assert.equal(result.assistantText, "Hello from Kady");
    assert.equal(result.toolEvents.length > 0, true);
    assert.equal(result.toolEvents.some((event) => event.toolName === "delegate_task"), true);
    assert.equal(fetchCalls.some((value) => value.endsWith("/run_sse")), true);
    assert.equal(runSseHeaders.length, 1);
    assert.equal(
      runSseHeaders[0].get("X-KDense-Workspace-Target-Uri"),
      workspaceRoot.uri.toString(),
    );
    assert.equal(
      runSseHeaders[0].get("X-KDense-Workspace-Target-Name"),
      workspaceRoot.name,
    );
    assert.equal(runSseHeaders[0].get("X-KDense-Workspace-Target-Index"), "1");
    const runBody = JSON.parse(runSseBodies[0]) as {
      state_delta?: { _model?: string };
      newMessage?: { parts?: Array<{ text?: string }> };
    };
    assert.equal(runBody.state_delta?._model, "openrouter/anthropic/claude-opus-4.6");
    assert.equal(runBody.newMessage?.parts?.[0]?.text, "Summarize this repo");
    adapter.dispose();
  });

  test("starts from the bundled runtime while targeting an arbitrary opened workspace folder", async () => {
    let terminalCwd = "";
    let startCommand = "";
    const workspaceRoot = createWorkspaceFolder("file:///workspace/arbitrary-project", 0, "arbitrary-project");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          return Response.json([createSkillRecord()]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      createTerminal: (options) => ({
        sendText(text) {
          startCommand = text;
        },
        show() {
          terminalCwd = String(options.cwd);
        },
      }),
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      runRuntimeCommand: async () => undefined,
      sleep: async () => undefined,
      healthPollAttempts: 1,
      healthPollIntervalMs: 0,
      sessionOwnerId: "session-owner-arbitrary",
      readRuntimeOwner: async () => "session-owner-arbitrary",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend({ workspaceTargetId: workspaceRoot.uri.toString() });

    assert.equal(state.status, "healthy");
    assert.equal(terminalCwd, runtimeRoot.toString());
    assert.match(startCommand, /KDENSE_WORKSPACE_ROOT='\/workspace\/arbitrary-project' BACKEND_PORT=\d+ LITELLM_PORT=\d+ KDENSE_RUNTIME_OWNER='session-owner-arbitrary' bash \.\/start_kdense_backend\.sh/);
    adapter.dispose();
  });

  test("startBackend force-stops the existing runtime before relaunching", async () => {
    const runtimeCommands: string[] = [];
    let startCommand = "";
    const workspaceRoot = createWorkspaceFolder("file:///workspace/arbitrary-project", 0, "arbitrary-project");
    const runtimeRoot = vscode.Uri.parse("file:///extension/dist/runtime");
    const fs = createWorkspaceBootstrapFs(runtimeRoot, workspaceRoot, { preparedRuntime: true });
    const adapter = new BackendServiceAdapter({
      fetch: async (input) => {
        if (String(input).endsWith("/health")) {
          return new Response(null, { status: 200, statusText: "OK" });
        }
        if (String(input).endsWith("/skills")) {
          return Response.json([createSkillRecord()]);
        }
        return new Response(null, { status: 200, statusText: "OK" });
      },
      createTerminal: () => ({
        sendText(text) {
          startCommand = text;
        },
        show() {},
      }),
      runRuntimeCommand: async ({ command }) => {
        runtimeCommands.push(command);
      },
      getWorkspaceFolders: () => [workspaceRoot],
      runtimeRootUri: runtimeRoot,
      stat: fs.stat,
      readDirectory: fs.readDirectory,
      sleep: async () => undefined,
      healthPollAttempts: 1,
      healthPollIntervalMs: 0,
      sessionOwnerId: "session-owner-2",
      baseUrl: "http://127.0.0.1:8000",
    });

    const state = await adapter.startBackend({ workspaceTargetId: workspaceRoot.uri.toString() });

    assert.equal(state.status, "healthy");
    assert.equal(runtimeCommands.length, 1);
    assert.match(runtimeCommands[0], /BACKEND_PORT=8000 LITELLM_PORT=17400 KDENSE_RUNTIME_OWNER='session-owner-2' KDENSE_RUNTIME_FORCE=1 bash \.\/stop_kdense_backend\.sh/);
    assert.match(startCommand, /KDENSE_RUNTIME_OWNER='session-owner-2'.*bash \.\/start_kdense_backend\.sh/);
    adapter.dispose();
  });

  test("dispose stops only the runtime owned by the current session", async () => {
    const runtimeCommands: string[] = [];
    const adapter = new BackendServiceAdapter({
      runRuntimeCommand: async ({ command }) => {
        runtimeCommands.push(command);
      },
      runtimeRootUri: vscode.Uri.parse("file:///extension/dist/runtime"),
      stat: async () => ({ ctime: 0, mtime: 0, size: 0, type: vscode.FileType.File }),
      readDirectory: async () => [],
      sessionOwnerId: "session-owner-3",
    });

    adapter.dispose();
    await flushAsyncWork();

    assert.equal(runtimeCommands.length, 1);
    assert.match(runtimeCommands[0], /KDENSE_RUNTIME_OWNER='session-owner-3' bash \.\/stop_kdense_backend\.sh/);
    assert.doesNotMatch(runtimeCommands[0], /KDENSE_RUNTIME_FORCE=1/);
  });
});

function createWorkspaceFolder(folderUri: string, index = 0, name?: string): vscode.WorkspaceFolder {
  const uri = vscode.Uri.parse(folderUri);
  return {
    uri,
    name: name ?? (uri.path.split("/").filter(Boolean).at(-1) ?? "workspace"),
    index,
  };
}

function createWorkspaceBootstrapFs(
  runtimeRoot: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  options: { preparedRuntime: boolean; runtimeState?: { prepared: boolean } },
): {
  stat(uri: vscode.Uri): Promise<vscode.FileStat>;
  readDirectory(uri: vscode.Uri): Promise<readonly [string, vscode.FileType][]>;
} {
    const sourceFiles = [
      "server.py",
      "initialize_kdense_workspace.sh",
      "start_kdense_backend.sh",
      "stop_kdense_backend.sh",
      "prep_sandbox.py",
    "litellm_config.yaml",
    "pyproject.toml",
    "kady_agent",
    "kady_agent/__init__.py",
    "kady_agent/agent.py",
    "kady_agent/mcps.py",
    "kady_agent/utils.py",
    "kady_agent/gemini_settings.py",
    "kady_agent/runtime_paths.py",
    "kady_agent/instructions/main_agent.md",
    "kady_agent/instructions/gemini_cli.md",
    "kady_agent/tools/__init__.py",
    "kady_agent/tools/gemini_cli.py",
  ];
  const preparedFiles = [
    "sandbox/.venv",
    "sandbox/pyproject.toml",
    "sandbox/GEMINI.md",
    "sandbox/.gemini/settings.json",
  ];
  const sourceEntries = new Map<string, vscode.FileType>();

  for (const relativePath of sourceFiles) {
    sourceEntries.set(joinUriPath(runtimeRoot, relativePath), fileTypeFor(relativePath));
  }

  return {
    async stat(uri) {
      const statEntries = new Map(sourceEntries);
      const preparedRuntime = options.preparedRuntime || options.runtimeState?.prepared;

      if (preparedRuntime) {
        for (const relativePath of preparedFiles) {
          statEntries.set(joinWorkspacePath(workspaceRoot, relativePath), fileTypeFor(relativePath));
        }
        statEntries.set(
          joinWorkspacePath(workspaceRoot, "sandbox/.gemini/skills"),
          vscode.FileType.Directory,
        );
      }

      const fileType = statEntries.get(uri.path);
      if (fileType === undefined) {
        throw new Error(`Missing test stat for ${uri.path}`);
      }
      return {
        ctime: 0,
        mtime: 0,
        size: 0,
        type: fileType,
      };
    },
    async readDirectory(uri) {
      if (
        (options.preparedRuntime || options.runtimeState?.prepared) &&
        uri.path === joinWorkspacePath(workspaceRoot, "sandbox/.gemini/skills")
      ) {
        return [["peer-review", vscode.FileType.Directory]];
      }
      throw new Error(`Missing test directory for ${uri.path}`);
    },
  };
}

function createSkillRecord() {
  return {
    id: "peer-review",
    name: "Peer Review",
    description: "Review manuscripts critically",
    author: "K-Dense",
    license: "MIT",
    compatibility: "built-in",
  };
}

function joinWorkspacePath(workspaceRoot: vscode.WorkspaceFolder, relativePath: string): string {
  return joinUriPath(workspaceRoot.uri, relativePath);
}

function joinUriPath(baseUri: vscode.Uri, relativePath: string): string {
  return vscode.Uri.joinPath(baseUri, ...relativePath.split("/")).path;
}

function fileTypeFor(relativePath: string): vscode.FileType {
  return relativePath.endsWith("kady_agent") ||
    relativePath.endsWith("instructions") ||
    relativePath.endsWith("tools") ||
    relativePath.endsWith(".venv")
    ? vscode.FileType.Directory
    : vscode.FileType.File;
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
