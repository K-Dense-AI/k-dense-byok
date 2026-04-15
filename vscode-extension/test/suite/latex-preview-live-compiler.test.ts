import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { LatexPreviewLiveCompiler } from "../../src/host/latex-preview-live-compiler";
import type { LatexCompileSummary, LatexEngine } from "../../src/host/latex-compile";
import { parseHostMessage } from "../../src/shared/webview-bridge";
import { createPreviewLatexStateEvent, type PreviewLatexStateEventPayload } from "../../src/shared/webview-bridge";
import { createWorkspaceTrustState } from "../../src/shared/workspace-trust";

suite("latex preview live compiler", () => {
  test("auto compiles on open and source changes in trusted mode", async () => {
    const timers = createTimerHarness();
    const resource = vscode.Uri.parse("file:///workspace/paper.tex");
    const compileCalls: LatexEngine[] = [];
    const events: PreviewLatexStateEventPayload[] = [];
    const compiler = new LatexPreviewLiveCompiler(resource, {
      compileLatexDocument: async (_resource, engine) => {
        compileCalls.push(engine);
        return createSummary(engine);
      },
      postState: async (payload) => {
        events.push(payload);
      },
      getTrustState: () => createWorkspaceTrustState(true),
      debounceMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    compiler.prime();
    await timers.flushNext();
    compiler.notifyDocumentChanged(resource, true);
    await timers.flushNext();

    assert.deepEqual(compileCalls, ["pdflatex", "pdflatex"]);
    assert.equal(events.filter((event) => event.phase === "running").length, 2);
    assert.equal(events.filter((event) => event.phase === "completed").length, 2);
    compiler.dispose();
  });

  test("does not auto compile in Restricted Mode", async () => {
    const timers = createTimerHarness();
    const resource = vscode.Uri.parse("file:///workspace/paper.tex");
    let compileCalls = 0;
    const compiler = new LatexPreviewLiveCompiler(resource, {
      compileLatexDocument: async () => {
        compileCalls += 1;
        return createSummary("pdflatex");
      },
      getTrustState: () => createWorkspaceTrustState(false),
      debounceMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    compiler.prime();
    compiler.notifyDocumentChanged(resource, true);
    compiler.notifyDocumentSaved(resource);

    assert.equal(timers.size(), 0);
    assert.equal(compileCalls, 0);
    compiler.dispose();
  });

  test("manual engine choice becomes the engine for later live recompiles", async () => {
    const timers = createTimerHarness();
    const resource = vscode.Uri.parse("file:///workspace/paper.tex");
    const compileCalls: LatexEngine[] = [];
    const compiler = new LatexPreviewLiveCompiler(resource, {
      compileLatexDocument: async (_resource, engine) => {
        compileCalls.push(engine);
        return createSummary(engine);
      },
      postState: async () => undefined,
      getTrustState: () => createWorkspaceTrustState(true),
      debounceMs: 25,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await compiler.compileNow("xelatex", "manual");
    compiler.notifyDocumentChanged(resource, true);
    await timers.flushNext();

    assert.deepEqual(compileCalls, ["xelatex", "xelatex"]);
    compiler.dispose();
  });

  test("bridge payload parser accepts preview latex live state events", () => {
    const parsed = parseHostMessage(
      createPreviewLatexStateEvent({
        phase: "running",
        trigger: "auto",
        engine: "pdflatex",
        statusMessage: "Live compile running with pdflatex through the extension host…",
        commandLine: "Auto compile (pdflatex)",
      }),
    );

    assert.equal(parsed.ok, true);
  });
});

function createSummary(engine: LatexEngine): LatexCompileSummary {
  return {
    success: true,
    engine,
    command: engine,
    commandLine: `${engine} paper.tex`,
    statusMessage: `Compilation succeeded with ${engine}.`,
    stdout: "stdout",
    stderr: "",
    log: "log",
    pdfUri: vscode.Uri.parse("file:///workspace/paper.pdf"),
  };
}

function createTimerHarness() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();

  return {
    setTimeout(callback: () => void) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      callbacks.delete(handle as unknown as number);
    },
    async flushNext() {
      const first = callbacks.entries().next();
      if (first.done) {
        throw new Error("No timer callback was queued.");
      }
      callbacks.delete(first.value[0]);
      await first.value[1]();
      await Promise.resolve();
      await Promise.resolve();
    },
    size() {
      return callbacks.size;
    },
  };
}
