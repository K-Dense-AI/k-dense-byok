import * as vscode from "vscode";
import type { LatexCompileSummary, LatexEngine } from "./latex-compile";
import type {
  PreviewLatexCompileTrigger,
  PreviewLatexStateEventPayload,
} from "../shared/webview-bridge";
import type { WorkspaceTrustState } from "../shared/workspace-trust";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface LatexPreviewLiveCompilerDependencies {
  compileLatexDocument(
    resource: vscode.Uri,
    engine: LatexEngine,
  ): Promise<LatexCompileSummary>;
  postState(payload: PreviewLatexStateEventPayload): Promise<void> | void;
  getTrustState(): WorkspaceTrustState;
  debounceMs: number;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultDependencies: LatexPreviewLiveCompilerDependencies = {
  compileLatexDocument: async () => {
    throw new Error("LatexPreviewLiveCompiler requires a compileLatexDocument dependency.");
  },
  postState: async () => undefined,
  getTrustState: () => ({
    isTrusted: true,
    mode: "trusted",
    statusLabel: "Trusted Mode",
    summary: "trusted",
    detail: "trusted",
    capabilities: {
      readOnlyUi: true,
      previewOpen: true,
      write: true,
      execute: true,
      backendStart: true,
      secretSensitive: true,
    },
    allowedCapabilities: [
      "readOnlyUi",
      "previewOpen",
      "write",
      "execute",
      "backendStart",
      "secretSensitive",
    ],
    blockedCapabilities: [],
  }),
  debounceMs: 300,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class LatexPreviewLiveCompiler implements vscode.Disposable {
  private readonly dependencies: LatexPreviewLiveCompilerDependencies;
  private currentEngine: LatexEngine = "pdflatex";
  private pendingTimer: TimerHandle | undefined;
  private compilePromise: Promise<LatexCompileSummary> | null = null;
  private queuedAutoCompile = false;

  constructor(
    private readonly resource: vscode.Uri,
    dependencies: Partial<LatexPreviewLiveCompilerDependencies> = {},
  ) {
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies,
    };
  }

  prime() {
    this.scheduleAutoCompile();
  }

  notifyDocumentChanged(documentUri: vscode.Uri, hasChanges = true) {
    if (!hasChanges || !this.matchesResource(documentUri)) {
      return;
    }

    this.scheduleAutoCompile();
  }

  notifyDocumentSaved(documentUri: vscode.Uri) {
    if (!this.matchesResource(documentUri)) {
      return;
    }

    this.scheduleAutoCompile();
  }

  async compileNow(
    engine: LatexEngine = this.currentEngine,
    trigger: PreviewLatexCompileTrigger = "manual",
  ): Promise<LatexCompileSummary> {
    this.currentEngine = engine;
    this.clearPendingTimer();

    if (this.compilePromise) {
      if (trigger === "auto") {
        this.queuedAutoCompile = true;
        return this.compilePromise;
      }

      await this.compilePromise;
    }

    const compilePromise = this.runCompile(engine, trigger);
    this.compilePromise = compilePromise;

    try {
      return await compilePromise;
    } finally {
      this.compilePromise = null;
      if (this.queuedAutoCompile && this.dependencies.getTrustState().capabilities.execute) {
        this.queuedAutoCompile = false;
        void this.compileNow(this.currentEngine, "auto");
      }
    }
  }

  dispose() {
    this.clearPendingTimer();
  }

  private scheduleAutoCompile() {
    if (!this.dependencies.getTrustState().capabilities.execute) {
      return;
    }

    this.clearPendingTimer();
    this.pendingTimer = this.dependencies.setTimeout(() => {
      this.pendingTimer = undefined;
      void this.compileNow(this.currentEngine, "auto");
    }, this.dependencies.debounceMs);
  }

  private clearPendingTimer() {
    if (!this.pendingTimer) {
      return;
    }

    this.dependencies.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  private async runCompile(
    engine: LatexEngine,
    trigger: PreviewLatexCompileTrigger,
  ) {
    if (trigger === "auto") {
      await this.dependencies.postState({
        phase: "running",
        trigger,
        engine,
        statusMessage: `Live compile running with ${engine} through the extension host…`,
        commandLine: `Auto compile (${engine})`,
        log: "Compilation started…",
      });
    }

    const result = await this.dependencies.compileLatexDocument(this.resource, engine);

    if (trigger === "auto") {
      await this.dependencies.postState({
        phase: "completed",
        trigger,
        success: result.success,
        engine: result.engine,
        command: result.command,
        commandLine: result.commandLine,
        statusMessage: result.statusMessage,
        stdout: result.stdout,
        stderr: result.stderr,
        log: result.log,
        pdfUri: result.pdfUri?.toString(),
      });
    }

    return result;
  }

  private matchesResource(documentUri: vscode.Uri) {
    return documentUri.toString() === this.resource.toString();
  }
}
