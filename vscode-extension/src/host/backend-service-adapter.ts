import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  BACKEND_HEALTH_PATH,
  createBackendServiceState,
  type BackendChatResult,
  type BackendChatToolEvent,
  type BackendExecutionLocation,
  type BackendServiceState,
} from "../shared/backend-service";
import {
  resolveWorkspaceTarget,
  type WorkspaceTargetResolution,
  type WorkspaceTargetingDependencies,
} from "./workspace";
import type { SidebarControlAvailability, SidebarSkill } from "../shared/sidebar-controls";

const APP_NAME = "kady_agent";
const USER_ID = "user";
const MAX_TOOL_EVENTS = 16;
const WORKSPACE_TARGET_URI_HEADER = "X-KDense-Workspace-Target-Uri";
const WORKSPACE_TARGET_NAME_HEADER = "X-KDense-Workspace-Target-Name";
const WORKSPACE_TARGET_INDEX_HEADER = "X-KDense-Workspace-Target-Index";

type BackendTerminal = {
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
};

type ResolvedWorkspaceRoot = {
  uri: vscode.Uri;
  label: string;
};

type BackendRuntimeEnvironment = {
  defaultModelId?: string;
  openRouterApiKey?: string;
  parallelApiKey?: string;
  modalTokenId?: string;
  modalTokenSecret?: string;
};

type RuntimeCommandOptions = {
  cwd: vscode.Uri;
  command: string;
};

type SessionResponse = {
  id: string;
};

type RunSseEvent = {
  error?: string;
  modelVersion?: string;
  partial?: boolean;
  content?: {
    parts?: Array<{
      text?: string;
      functionCall?: {
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
      };
      functionResponse?: {
        id?: string;
        name?: string;
        response?: Record<string, unknown>;
      };
    }>;
  };
};

type RunSseToolCallPart = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

type RunSseToolResponsePart = {
  id?: string;
  name?: string;
  response?: Record<string, unknown>;
};

export interface BackendServiceAdapterDependencies {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  createTerminal(options: vscode.TerminalOptions): BackendTerminal;
  getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined;
  runtimeRootUri: vscode.Uri | undefined;
  stat(uri: vscode.Uri): Thenable<vscode.FileStat> | Promise<vscode.FileStat>;
  readDirectory(
    uri: vscode.Uri,
  ): Thenable<readonly [string, vscode.FileType][]> | Promise<readonly [string, vscode.FileType][]>;
  remoteName: string | undefined;
  sleep(ms: number): Promise<void>;
  now(): Date;
  baseUrl: string;
  healthTimeoutMs: number;
  healthPollAttempts: number;
  healthPollIntervalMs: number;
  initializationPollAttempts: number;
  initializationPollIntervalMs: number;
  litellmPort: number;
  initializeCommand: string;
  startCommand: string;
  stopCommand: string;
  sessionOwnerId: string;
  readRuntimeOwner(ports: { backendPort: number; litellmPort: number }): Promise<string | undefined>;
  runRuntimeCommand(options: RuntimeCommandOptions): Promise<void>;
  getRuntimeEnvironment?(): Promise<BackendRuntimeEnvironment> | BackendRuntimeEnvironment;
}

const defaultDependencies: BackendServiceAdapterDependencies = {
  fetch: (input, init) => fetch(input, init),
  createTerminal: (options) => vscode.window.createTerminal(options),
  getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
  runtimeRootUri: undefined,
  stat: (uri) => vscode.workspace.fs.stat(uri),
  readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri),
  remoteName: vscode.env.remoteName,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  baseUrl: resolveDefaultBackendBaseUrl(),
  healthTimeoutMs: 1_500,
  healthPollAttempts: 8,
  healthPollIntervalMs: 1_000,
  initializationPollAttempts: 600,
  initializationPollIntervalMs: 1_000,
  litellmPort: resolveDefaultLiteLlmPort(),
  initializeCommand: "bash ./initialize_kdense_workspace.sh",
  startCommand: "bash ./start_kdense_backend.sh",
  stopCommand: "bash ./stop_kdense_backend.sh",
  sessionOwnerId: `kdense-session-${Date.now()}`,
  readRuntimeOwner: (ports) => readRuntimeOwner(ports),
  runRuntimeCommand: (options) => runRuntimeCommand(options),
  getRuntimeEnvironment: () => ({}),
};

export class BackendServiceAdapter implements vscode.Disposable {
  private readonly onDidChangeStateEmitter =
    new vscode.EventEmitter<BackendServiceState>();
  private readonly dependencies: BackendServiceAdapterDependencies;
  private state: BackendServiceState;
  private sessionId: string | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(dependencies: Partial<BackendServiceAdapterDependencies> = {}) {
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies,
      baseUrl: dependencies.baseUrl ?? defaultDependencies.baseUrl,
    };

    this.state = createBackendServiceState("unavailable", {
      detail: this.describeUnavailableRoot(),
      baseUrl: this.dependencies.baseUrl,
      executionLocation: this.getExecutionLocation(),
    });
  }

  get onDidChangeState(): vscode.Event<BackendServiceState> {
    return this.onDidChangeStateEmitter.event;
  }

  getState(): BackendServiceState {
    return this.state;
  }

  async refreshStatus(): Promise<BackendServiceState> {
    const workspaceRoot = await this.getHealthCheckWorkspaceRoot();
    if (workspaceRoot) {
      const runtimeParity = await this.verifyBootstrapRuntime(workspaceRoot.uri);
      if (!runtimeParity.ok) {
        return this.setState(
          createBackendServiceState("failed", {
            detail: runtimeParity.detail,
            baseUrl: this.dependencies.baseUrl,
            executionLocation: this.getExecutionLocation(),
            requiresInitialization: true,
            skillsReady: false,
            workspaceRootLabel: workspaceRoot.label,
            checkedAt: this.dependencies.now(),
          }),
        );
      }
    }
    const healthResult = await this.checkHealth(workspaceRoot);

    if (healthResult.ok) {
      const runtimeOwner = await this.dependencies.readRuntimeOwner({
        backendPort: extractPortFromBaseUrl(this.dependencies.baseUrl),
        litellmPort: this.dependencies.litellmPort,
      });

      if (runtimeOwner !== this.dependencies.sessionOwnerId) {
        return this.setState(
          createBackendServiceState("unavailable", {
            detail: runtimeOwner
              ? "A K-Dense backend is already running on the configured ports, but it is owned by another VS Code session. Use Start backend from this session to take over cleanly."
              : "A backend is responding on the configured ports, but it is not registered to this VS Code session. Use Start backend from this session to take over cleanly.",
            baseUrl: this.dependencies.baseUrl,
            executionLocation: this.getExecutionLocation(),
            requiresInitialization: false,
            skillsReady: false,
            workspaceRootLabel: healthResult.workspaceRootLabel,
            checkedAt: this.dependencies.now(),
          }),
        );
      }

      const skillsReadiness = healthResult.workspaceRoot
        ? await this.checkSkillsReadiness(healthResult.workspaceRoot.uri)
        : { ok: true as const };

      return this.setState(
        createBackendServiceState("healthy", {
          detail: skillsReadiness.ok
            ? `Host-managed backend responded at ${this.dependencies.baseUrl}${BACKEND_HEALTH_PATH}, the prepared runtime in workspace '${healthResult.workspaceRootLabel ?? "current"}' is present, and /skills is available.`
            : `Host-managed backend responded at ${this.dependencies.baseUrl}${BACKEND_HEALTH_PATH} and the prepared runtime in workspace '${healthResult.workspaceRootLabel ?? "current"}' is present, but /skills is not ready yet. ${skillsReadiness.detail}`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: false,
          skillsReady: skillsReadiness.ok,
          workspaceRootLabel: healthResult.workspaceRootLabel,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    return this.setState(
        createBackendServiceState("unavailable", {
          detail: healthResult.detail,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: false,
          skillsReady: false,
          workspaceRootLabel: healthResult.workspaceRootLabel,
          checkedAt: this.dependencies.now(),
        }),
      );
  }

  async initializeWorkspace(options: { workspaceTargetId?: string } = {}): Promise<BackendServiceState> {
    const workspaceRoot = await this.resolveBackendWorkspaceRoot(options.workspaceTargetId);

    if (!workspaceRoot.ok) {
      return this.setState(
        createBackendServiceState("unavailable", {
          detail: workspaceRoot.message,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: true,
          skillsReady: false,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    const runtimeRoot = await this.resolveBundledRuntimeRoot();
    if (!runtimeRoot.ok) {
      return this.setState(
        createBackendServiceState("unavailable", {
          detail: runtimeRoot.message,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: true,
          skillsReady: false,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    const resolvedWorkspaceRoot = workspaceRoot.value;

    this.setState(
      createBackendServiceState("starting", {
        detail: `Preparing the K-Dense workspace runtime in '${resolvedWorkspaceRoot.label}' (sandbox/.venv, .gemini/settings.json, scientific skills).`,
        baseUrl: this.dependencies.baseUrl,
        executionLocation: this.getExecutionLocation(),
        requiresInitialization: true,
        skillsReady: false,
        workspaceRootLabel: resolvedWorkspaceRoot.label,
        checkedAt: this.dependencies.now(),
      }),
    );

    try {
      const terminal = this.dependencies.createTerminal({
        name: "K-Dense Initialize",
        cwd: runtimeRoot.value.uri,
        isTransient: true,
      });
      terminal.sendText(
        await this.createBundledRuntimeCommand(
          this.dependencies.initializeCommand,
          resolvedWorkspaceRoot.uri,
        ),
        true,
      );
      terminal.show(true);
    } catch (error) {
      return this.setState(
        createBackendServiceState("failed", {
          detail: `Failed to launch the workspace initialization command: ${getErrorMessage(error)}`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: true,
          skillsReady: false,
          workspaceRootLabel: resolvedWorkspaceRoot.label,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    void this.watchInitializationAndStart(resolvedWorkspaceRoot);
    return this.state;
  }

  async startBackend(options: { workspaceTargetId?: string } = {}): Promise<BackendServiceState> {
    const workspaceRoot = await this.resolveBackendWorkspaceRoot(options.workspaceTargetId);

    if (!workspaceRoot.ok) {
      return this.setState(
        createBackendServiceState("unavailable", {
          detail: workspaceRoot.message,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    const runtimeRoot = await this.resolveBundledRuntimeRoot();
    if (!runtimeRoot.ok) {
      return this.setState(
        createBackendServiceState("unavailable", {
          detail: runtimeRoot.message,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    const resolvedWorkspaceRoot = workspaceRoot.value;
    const runtimeParity = await this.verifyBootstrapRuntime(resolvedWorkspaceRoot.uri);
    if (!runtimeParity.ok) {
      return this.setState(
        createBackendServiceState("failed", {
          detail: runtimeParity.detail,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: true,
          skillsReady: false,
          workspaceRootLabel: resolvedWorkspaceRoot.label,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    await this.stopBackend({ force: true, silent: true });

    this.sessionId = null;

    this.setState(
      createBackendServiceState("starting", {
        detail: `Starting the K-Dense backend stack from workspace root '${resolvedWorkspaceRoot.label}' on the ${this.getExecutionLocation()} extension host.`,
        baseUrl: this.dependencies.baseUrl,
        executionLocation: this.getExecutionLocation(),
        requiresInitialization: false,
        skillsReady: false,
        workspaceRootLabel: resolvedWorkspaceRoot.label,
        checkedAt: this.dependencies.now(),
      }),
    );

    try {
      const terminal = this.dependencies.createTerminal({
        name: "K-Dense Backend",
        cwd: runtimeRoot.value.uri,
        isTransient: true,
      });
      terminal.sendText(
        await this.createBundledRuntimeCommand(
          this.dependencies.startCommand,
          resolvedWorkspaceRoot.uri,
        ),
        true,
      );
      terminal.show(true);
    } catch (error) {
      return this.setState(
        createBackendServiceState("failed", {
          detail: `Failed to launch the backend start command: ${getErrorMessage(error)}`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: false,
          skillsReady: false,
          workspaceRootLabel: resolvedWorkspaceRoot.label,
          checkedAt: this.dependencies.now(),
        }),
      );
    }

    let lastSkillsReadinessDetail: string | undefined;

    for (
      let attempt = 0;
      attempt < this.dependencies.healthPollAttempts;
      attempt += 1
    ) {
      const healthResult = await this.checkHealth(resolvedWorkspaceRoot);
      if (healthResult.ok) {
        const skillsReadiness = await this.checkSkillsReadiness(resolvedWorkspaceRoot.uri);
        if (skillsReadiness.ok) {
          return this.setState(
            createBackendServiceState("healthy", {
              detail: `Backend-only start succeeded, ${BACKEND_HEALTH_PATH} is responding, the prepared sandbox runtime (.venv, .gemini/settings.json, skills) is available, and /skills is ready for the sidebar.`,
              baseUrl: this.dependencies.baseUrl,
              executionLocation: this.getExecutionLocation(),
              requiresInitialization: false,
              skillsReady: true,
              workspaceRootLabel: resolvedWorkspaceRoot.label,
              checkedAt: this.dependencies.now(),
            }),
          );
        }

        lastSkillsReadinessDetail = skillsReadiness.detail;
      }

      await this.dependencies.sleep(this.dependencies.healthPollIntervalMs);
    }

    return this.setState(
        createBackendServiceState("failed", {
          detail: lastSkillsReadinessDetail
            ? `The backend-only start command ran from '${resolvedWorkspaceRoot.label}' and ${BACKEND_HEALTH_PATH} responded, but /skills never became ready for the sidebar. ${lastSkillsReadinessDetail}`
            : `The backend start command ran from '${resolvedWorkspaceRoot.label}', but ${BACKEND_HEALTH_PATH} did not become healthy at ${this.dependencies.baseUrl}.`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          requiresInitialization: false,
          skillsReady: false,
          workspaceRootLabel: resolvedWorkspaceRoot.label,
          checkedAt: this.dependencies.now(),
        }),
    );
  }

  async stopBackend(options: { force?: boolean; silent?: boolean } = {}): Promise<BackendServiceState> {
    const runtimeRoot = await this.resolveBundledRuntimeRoot();
    if (!runtimeRoot.ok) {
      return this.state;
    }

    try {
      await this.dependencies.runRuntimeCommand({
        cwd: runtimeRoot.value.uri,
        command: this.createBundledRuntimeStopCommand(Boolean(options.force)),
      });
      this.sessionId = null;
      if (options.silent) {
        return this.state;
      }
      return this.setState(
        createBackendServiceState("unavailable", {
          detail: `Stopped the host-managed backend runtime owned by this VS Code session on ${this.getExecutionLocation()}.`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          checkedAt: this.dependencies.now(),
        }),
      );
    } catch (error) {
      if (options.silent) {
        return this.state;
      }
      return this.setState(
        createBackendServiceState("failed", {
          detail: `Failed to stop the backend runtime: ${getErrorMessage(error)}`,
          baseUrl: this.dependencies.baseUrl,
          executionLocation: this.getExecutionLocation(),
          checkedAt: this.dependencies.now(),
        }),
      );
    }
  }

  async getSidebarControlAvailability(): Promise<SidebarControlAvailability> {
    return {
      modalConfigured: await this.fetchModalConfigured(),
      availableSkills: await this.fetchSkills(),
    };
  }

  async sendChat(
    text: string,
    options: { workspaceTargetId?: string; modelId?: string } = {},
  ): Promise<BackendChatResult> {
    const prompt = text.trim();
    if (!prompt) {
      throw new Error("Enter a message before sending it to Kady.");
    }

    const targetResolution = this.resolveSidebarWorkspaceTarget(options.workspaceTargetId);
    if (!targetResolution.ok) {
      throw new Error(targetResolution.message);
    }

    const workspaceTargetHeaders = createWorkspaceTargetHeaders(targetResolution);
    const backendState = await this.refreshStatus();
    if (backendState.status !== "healthy") {
      throw new Error(
        `Kady backend is ${backendState.statusLabel.toLowerCase()}. ${backendState.detail}`,
      );
    }

    const sessionId = await this.ensureSession();
    const response = await this.dependencies.fetch(
      `${this.dependencies.baseUrl}/run_sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...workspaceTargetHeaders,
        },
        body: JSON.stringify({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId,
          newMessage: {
            role: "user",
            parts: [{ text: prompt }],
          },
          streaming: true,
          ...(options.modelId ? { state_delta: { _model: options.modelId } } : {}),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`SSE request failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Backend response did not include a readable stream.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";
    let modelVersion: string | undefined;
    let reportedError: string | undefined;
    const toolEvents: BackendChatToolEvent[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const rawEvent = line.slice(6).trim();
        if (!rawEvent) {
          continue;
        }

        let event: RunSseEvent;
        try {
          event = JSON.parse(rawEvent) as RunSseEvent;
        } catch {
          continue;
        }

        if (event.error) {
          reportedError = event.error;
          continue;
        }

        if (event.modelVersion) {
          modelVersion = event.modelVersion;
        }

        const parts = event.content?.parts;
        if (!parts) {
          continue;
        }

        for (const part of parts) {
          if (part.functionCall) {
            toolEvents.push(formatToolCall(part.functionCall, toolEvents.length + 1));
            continue;
          }

          if (part.functionResponse) {
            toolEvents.push(
              formatToolResponse(part.functionResponse, toolEvents.length + 1),
            );
            continue;
          }

          if (part.text) {
            assistantText = event.partial ? assistantText + part.text : part.text;
          }
        }
      }
    }

    if (buffer.trim().length > 0) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const rawEvent = line.slice(6).trim();
        if (!rawEvent) {
          continue;
        }

        let event: RunSseEvent;
        try {
          event = JSON.parse(rawEvent) as RunSseEvent;
        } catch {
          continue;
        }

        if (event.error) {
          reportedError = event.error;
          continue;
        }

        if (event.modelVersion) {
          modelVersion = event.modelVersion;
        }

        const parts = event.content?.parts;
        if (!parts) {
          continue;
        }

        for (const part of parts) {
          if (part.functionCall) {
            toolEvents.push(formatToolCall(part.functionCall, toolEvents.length + 1));
            continue;
          }

          if (part.functionResponse) {
            toolEvents.push(
              formatToolResponse(part.functionResponse, toolEvents.length + 1),
            );
            continue;
          }

          if (part.text) {
            assistantText = event.partial ? assistantText + part.text : part.text;
          }
        }
      }
    }

    const finalAssistantText =
      assistantText.trim().length > 0
        ? assistantText
        : reportedError
          ? `Error: ${reportedError}`
          : "Kady did not return any text for this request.";

    return {
      userText: prompt,
      assistantText: finalAssistantText,
      sessionId,
      modelVersion,
      toolEvents: toolEvents.slice(-MAX_TOOL_EVENTS),
    };
  }


  private async fetchModalConfigured(): Promise<boolean> {
    try {
      const response = await this.dependencies.fetch(`${this.dependencies.baseUrl}/config`, {
        method: "GET",
      });
      if (!response.ok) {
        return false;
      }
      const data = (await response.json()) as { modal_configured?: unknown } | null;
      return Boolean(data?.modal_configured);
    } catch {
      return false;
    }
  }

  private async fetchSkills(): Promise<SidebarSkill[]> {
    const workspaceRoot = await this.getHealthCheckWorkspaceRoot();
    if (workspaceRoot) {
      const runtimeParity = await this.verifyBootstrapRuntime(workspaceRoot.uri);
      if (!runtimeParity.ok) {
        return [];
      }
    }

    const skillsReadiness = await this.checkSkillsReadiness(workspaceRoot?.uri);
    return skillsReadiness.ok ? skillsReadiness.skills : [];
  }

  dispose() {
    if (!this.disposePromise) {
      this.disposePromise = this.stopBackend({ silent: true }).then(() => undefined, () => undefined);
    }
    this.onDidChangeStateEmitter.dispose();
  }

  private async ensureSession() {
    if (this.sessionId) {
      return this.sessionId;
    }

    const response = await this.dependencies.fetch(
      `${this.dependencies.baseUrl}/apps/${APP_NAME}/users/${USER_ID}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create backend session: ${response.status} ${response.statusText}`,
      );
    }

    const session = (await response.json()) as SessionResponse;
    if (!session?.id) {
      throw new Error("Backend session response did not include a session id.");
    }

    this.sessionId = session.id;
    return this.sessionId;
  }

  private async checkSkillsReadiness(folderUri?: vscode.Uri) {
    try {
      const response = await this.dependencies.fetch(`${this.dependencies.baseUrl}/skills`, {
        method: "GET",
      });
      if (!response.ok) {
        return {
          ok: false as const,
          detail: `/skills returned ${response.status} ${response.statusText}.`,
        };
      }

      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        return {
          ok: false as const,
          detail: "/skills did not return the expected array payload.",
        };
      }

      const skills = data
        .filter((item): item is SidebarSkill => isSidebarSkillRecord(item))
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          author: item.author,
          license: item.license,
          compatibility: item.compatibility,
        }));

      if (skills.length === 0) {
        return {
          ok: false as const,
          detail: folderUri
            ? `/skills is reachable, but it returned no installed skills for workspace '${this.labelForFolderUri(folderUri)}'.`
            : "/skills is reachable, but it returned no installed skills.",
        };
      }

      return {
        ok: true as const,
        skills,
      };
    } catch (error) {
      return {
        ok: false as const,
        detail: `Failed to reach /skills: ${getErrorMessage(error)}`,
      };
    }
  }

  private async checkHealth(workspaceRoot?: ResolvedWorkspaceRoot) {
    const timeoutSignal = AbortSignal.timeout(this.dependencies.healthTimeoutMs);

    try {
      const response = await this.dependencies.fetch(
        `${this.dependencies.baseUrl}${BACKEND_HEALTH_PATH}`,
        {
          method: "GET",
          signal: timeoutSignal,
        },
      );

      if (response.ok) {
        return {
          ok: true as const,
          workspaceRootLabel: workspaceRoot?.label,
          workspaceRoot,
        };
      }

      return {
        ok: false as const,
        detail: `Backend health check returned ${response.status} ${response.statusText}.`,
        workspaceRootLabel: workspaceRoot?.label,
      };
    } catch (error) {
      return {
        ok: false as const,
        detail: workspaceRoot
          ? `Backend is not reachable yet at ${this.dependencies.baseUrl}; start remains host-managed and tied to '${workspaceRoot.label}'.`
          : `${this.describeUnavailableRoot()} Backend health check failed: ${getErrorMessage(error)}`,
        workspaceRootLabel: workspaceRoot?.label,
      };
    }
  }

  private async watchInitializationAndStart(workspaceRoot: ResolvedWorkspaceRoot) {
    for (let attempt = 0; attempt < this.dependencies.initializationPollAttempts; attempt += 1) {
      const runtimeParity = await this.verifyBootstrapRuntime(workspaceRoot.uri);
      if (runtimeParity.ok) {
        await this.startBackend({ workspaceTargetId: workspaceRoot.uri.toString() });
        return;
      }

      await this.dependencies.sleep(this.dependencies.initializationPollIntervalMs);
    }

    this.setState(
      createBackendServiceState("failed", {
        detail: `Workspace initialization did not finish within the expected time window for '${workspaceRoot.label}'. Refresh after the terminal completes, or rerun initialization if bootstrap failed.`,
        baseUrl: this.dependencies.baseUrl,
        executionLocation: this.getExecutionLocation(),
        requiresInitialization: true,
        skillsReady: false,
        workspaceRootLabel: workspaceRoot.label,
        checkedAt: this.dependencies.now(),
      }),
    );
  }

  private async getHealthCheckWorkspaceRoot() {
    const folders = this.dependencies.getWorkspaceFolders() ?? [];
    if (folders.length !== 1) {
      return undefined;
    }

    return {
      uri: folders[0].uri,
      label: folders[0].name,
    };
  }

  private async resolveBackendWorkspaceRoot(workspaceTargetId?: string): Promise<
    | { ok: true; value: ResolvedWorkspaceRoot }
    | { ok: false; message: string }
  > {
    const targetResolution = this.resolveSidebarWorkspaceTarget(workspaceTargetId);
    if (!targetResolution.ok) {
      return {
        ok: false,
        message: targetResolution.message,
      };
    }

    return {
      ok: true,
      value: {
        uri: targetResolution.targetFolder.uri,
        label: targetResolution.targetFolder.name,
      },
    };
  }

  private resolveSidebarWorkspaceTarget(workspaceTargetId?: string): WorkspaceTargetResolution {
    return resolveWorkspaceTarget(
      {
        explicitTarget: workspaceTargetId ? vscode.Uri.parse(workspaceTargetId) : undefined,
      },
      this.getWorkspaceTargetingDependencies(),
    );
  }

  private getWorkspaceTargetingDependencies(): WorkspaceTargetingDependencies {
    return {
      getWorkspaceFolders: this.dependencies.getWorkspaceFolders,
      getWorkspaceFolder: (uri) => {
        const folders = this.dependencies.getWorkspaceFolders() ?? [];
        return folders.find((folder) => isEqualOrParent(folder.uri, uri));
      },
    };
  }

  private async hasBackendMarkers(folderUri: vscode.Uri) {
    const markers = [
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
    ] as const;
    const checks = await Promise.all(
      markers.map((marker) =>
        this.pathExists(vscode.Uri.joinPath(folderUri, marker)),
      ),
    );
    return checks.every(Boolean);
  }

  private async pathExists(uri: vscode.Uri) {
    try {
      await this.dependencies.stat(uri);
      return true;
    } catch {
      return false;
    }
  }


  private async directoryHasEntries(uri: vscode.Uri) {
    try {
      const entries = await this.dependencies.readDirectory(uri);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private async verifyBootstrapRuntime(folderUri: vscode.Uri) {
    const requiredArtifacts = [
      { path: "sandbox/.venv", label: "sandbox/.venv" },
      { path: "sandbox/pyproject.toml", label: "sandbox/pyproject.toml" },
      { path: "sandbox/GEMINI.md", label: "sandbox/GEMINI.md" },
      { path: "sandbox/.gemini/settings.json", label: "sandbox/.gemini/settings.json" },
    ] as const;

    const missingArtifacts: string[] = [];
    for (const artifact of requiredArtifacts) {
      const exists = await this.pathExists(vscode.Uri.joinPath(folderUri, artifact.path));
      if (!exists) {
        missingArtifacts.push(artifact.label);
      }
    }

    const skillsUri = vscode.Uri.joinPath(folderUri, "sandbox", ".gemini", "skills");
    const skillsReady = await this.directoryHasEntries(skillsUri);
    if (!skillsReady) {
      missingArtifacts.push("sandbox/.gemini/skills");
    }

    if (missingArtifacts.length > 0) {
      return {
        ok: false as const,
        detail:
          `Backend health is reachable, but the prepared runtime expected by the web app is missing from workspace '${this.labelForFolderUri(folderUri)}': ${missingArtifacts.join(", ")}. ` +
          "The extension ships its own backend/runtime payload, but each target workspace still needs initialization output from initialize_kdense_workspace.sh → prep_sandbox.py before chat/runtime features are treated as ready.",
      };
    }

    return { ok: true as const };
  }

  private describeUnavailableRoot() {
    const location = this.getExecutionLocation();
    const resolution = this.resolveSidebarWorkspaceTarget();

    if (!resolution.ok) {
      return `${resolution.message} The ${location} extension host uses workspace targeting rules before it can initialize or start the bundled backend runtime.`;
    }

    return `The selected workspace '${resolution.targetFolder.name}' is waiting for initialization or backend startup from the bundled extension runtime on the ${location} extension host.`;
  }

  private async resolveBundledRuntimeRoot(): Promise<
    | { ok: true; value: ResolvedWorkspaceRoot }
    | { ok: false; message: string }
  > {
    const runtimeRootUri = this.dependencies.runtimeRootUri;
    if (!runtimeRootUri) {
      return {
        ok: false,
        message:
          "The bundled backend runtime path is unavailable. Rebuild or reinstall the extension so dist/runtime is present.",
      };
    }

    if (!(await this.hasBackendMarkers(runtimeRootUri))) {
      return {
        ok: false,
        message:
          "The bundled backend runtime payload is incomplete. Rebuild or reinstall the extension so dist/runtime contains server.py, the startup scripts, and kady_agent runtime files.",
      };
    }

    return {
      ok: true,
      value: {
        uri: runtimeRootUri,
        label: "bundled runtime",
      },
    };
  }

  private async createBundledRuntimeCommand(command: string, workspaceRootUri: vscode.Uri) {
    const backendPort = extractPortFromBaseUrl(this.dependencies.baseUrl);
    const runtimeEnvironment = await this.dependencies.getRuntimeEnvironment?.();
    const envAssignments = [
      `KDENSE_WORKSPACE_ROOT=${shellQuote(workspaceRootUri.fsPath)}`,
      `BACKEND_PORT=${backendPort}`,
      `LITELLM_PORT=${this.dependencies.litellmPort}`,
      `KDENSE_RUNTIME_OWNER=${shellQuote(this.dependencies.sessionOwnerId)}`,
    ];

    if (runtimeEnvironment?.defaultModelId) {
      envAssignments.push(
        `DEFAULT_AGENT_MODEL=${shellQuote(runtimeEnvironment.defaultModelId)}`,
      );
    }

    if (runtimeEnvironment?.openRouterApiKey) {
      envAssignments.push(
        `OPENROUTER_API_KEY=${shellQuote(runtimeEnvironment.openRouterApiKey)}`,
      );
    }

    if (runtimeEnvironment?.parallelApiKey) {
      envAssignments.push(
        `PARALLEL_API_KEY=${shellQuote(runtimeEnvironment.parallelApiKey)}`,
      );
    }

    if (runtimeEnvironment?.modalTokenId) {
      envAssignments.push(
        `MODAL_TOKEN_ID=${shellQuote(runtimeEnvironment.modalTokenId)}`,
      );
    }

    if (runtimeEnvironment?.modalTokenSecret) {
      envAssignments.push(
        `MODAL_TOKEN_SECRET=${shellQuote(runtimeEnvironment.modalTokenSecret)}`,
      );
    }

    return `${envAssignments.join(" ")} ${command}`;
  }

  private createBundledRuntimeStopCommand(force: boolean) {
    const backendPort = extractPortFromBaseUrl(this.dependencies.baseUrl);
    const envAssignments = [
      `BACKEND_PORT=${backendPort}`,
      `LITELLM_PORT=${this.dependencies.litellmPort}`,
      `KDENSE_RUNTIME_OWNER=${shellQuote(this.dependencies.sessionOwnerId)}`,
    ];

    if (force) {
      envAssignments.push("KDENSE_RUNTIME_FORCE=1");
    }

    return `${envAssignments.join(" ")} ${this.dependencies.stopCommand}`;
  }

  private labelForFolderUri(folderUri: vscode.Uri) {
    const folders = this.dependencies.getWorkspaceFolders() ?? [];
    const match = folders.find((folder) => folder.uri.toString() === folderUri.toString());
    return match?.name ?? folderUri.path.split("/").filter(Boolean).at(-1) ?? folderUri.toString();
  }

  private getExecutionLocation(): BackendExecutionLocation {
    return this.dependencies.remoteName ? "remote" : "desktop";
  }

  private setState(state: BackendServiceState) {
    this.state = state;
    this.onDidChangeStateEmitter.fire(state);
    return state;
  }
}

function resolveDefaultBackendBaseUrl() {
  const configured = process.env.KDENSE_BACKEND_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const port = process.env.KDENSE_BACKEND_PORT?.trim() || process.env.BACKEND_PORT?.trim() || "17800";
  return `http://127.0.0.1:${port}`;
}

function resolveDefaultLiteLlmPort() {
  const raw = process.env.KDENSE_LITELLM_PORT?.trim() || process.env.LITELLM_PORT?.trim() || "17400";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 17400;
}

function extractPortFromBaseUrl(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    const port = Number.parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
    return Number.isFinite(port) ? port : 17800;
  } catch {
    return 17800;
  }
}

function formatToolCall(
  tool: RunSseToolCallPart | undefined,
  index: number,
): BackendChatToolEvent {
  const name = tool?.name ?? "tool";
  const prompt = truncateText(tool?.args?.prompt);

  return {
    id: String(tool?.id ?? `${name}-${index}`),
    stage: "call",
    toolName: name,
    label:
      name === "delegate_task"
        ? "Delegating to a specialist"
        : `Running ${humanizeToolName(name)}`,
    detail: prompt,
    status: "running",
  };
}

function formatToolResponse(
  tool: RunSseToolResponsePart | undefined,
  index: number,
): BackendChatToolEvent {
  const name = tool?.name ?? "tool";
  const response = tool?.response;
  const detail =
    truncateText(response?.result) ??
    truncateText(response?.message) ??
    truncateText(response?.error);
  const status = response?.error ? "error" : "complete";

  return {
    id: String(tool?.id ?? `${name}-${index}`),
    stage: "response",
    toolName: name,
    label:
      name === "delegate_task"
        ? "Specialist finished"
        : `Finished ${humanizeToolName(name)}`,
    detail,
    status,
  };
}

function humanizeToolName(name: string) {
  return name.replace(/_/g, " ");
}

function truncateText(value: unknown, max = 120) {
  if (typeof value !== "string") {
    return undefined;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }

  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function createWorkspaceTargetHeaders(resolution: WorkspaceTargetResolution & { ok: true }) {
  return {
    [WORKSPACE_TARGET_URI_HEADER]: resolution.targetFolderUri.toString(),
    [WORKSPACE_TARGET_NAME_HEADER]: resolution.targetFolder.name,
    [WORKSPACE_TARGET_INDEX_HEADER]: String(resolution.targetFolder.index),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isEqualOrParent(parent: vscode.Uri, child: vscode.Uri): boolean {
  if (parent.scheme !== child.scheme || parent.authority !== child.authority) {
    return false;
  }

  const parentPath = trimTrailingSlash(parent.path);
  const childPath = trimTrailingSlash(child.path);

  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function isSidebarSkillRecord(value: unknown): value is SidebarSkill {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { description?: unknown }).description === "string" &&
    typeof (value as { author?: unknown }).author === "string" &&
    typeof (value as { license?: unknown }).license === "string" &&
    typeof (value as { compatibility?: unknown }).compatibility === "string"
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runRuntimeCommand(options: RuntimeCommandOptions) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", options.command], {
      cwd: options.cwd.fsPath,
      stdio: "ignore",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Runtime command exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function readRuntimeOwner(ports: { backendPort: number; litellmPort: number }) {
  const stateFile = `/tmp/kdense-backend-${ports.backendPort}-${ports.litellmPort}.env`;

  try {
    const contents = await readFile(stateFile, "utf8");
    const match = contents.match(/^KDENSE_RUNTIME_OWNER='([^']*)'$/m);
    return match?.[1] || undefined;
  } catch {
    return undefined;
  }
}
