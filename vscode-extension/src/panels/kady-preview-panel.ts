import * as vscode from "vscode";
import { compileLatexDocument, type LatexEngine } from "../host/latex-compile";
import { LatexPreviewLiveCompiler } from "../host/latex-preview-live-compiler";
import { getCurrentWorkspaceTrustState } from "../host/workspace-trust";
import { resolveWorkspaceTarget } from "../host/workspace";
import { attachWebviewBridgeRouter } from "../host/webview-bridge-router";
import {
  createBridgeState,
  createPreviewLatexStateEvent,
  type PreviewLatexStateEventPayload,
} from "../shared/webview-bridge";
import {
  basename,
  directoryUri,
  renderKadyPreview,
} from "../preview/kady-preview-renderer";
import { renderWebviewHtml } from "../webview/render-webview-html";

export class KadyPreviewEditorProvider
  implements vscode.CustomReadonlyEditorProvider<KadyPreviewDocument>
{
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<KadyPreviewDocument> {
    return {
      uri,
      dispose() {
        // Stateless scaffold for Task 7. Task 8 will add renderer-specific lifecycle.
      },
    };
  }

  async resolveCustomEditor(
    document: KadyPreviewDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const trustState = getCurrentWorkspaceTrustState();
    webviewPanel.title = `${basename(document.uri)} • Kady Preview`;
    const resolution = resolveWorkspaceTarget({ referencedResource: document.uri });
    const liveCompiler = isLatexPreviewResource(document.uri)
      ? new LatexPreviewLiveCompiler(document.uri, {
          compileLatexDocument: (resource, engine) => compileLatexDocument(resource, engine),
          getTrustState: () => getCurrentWorkspaceTrustState(),
          postState: async (payload) => {
            await webviewPanel.webview.postMessage(
              createPreviewLatexStateEvent(
                serializePreviewLatexStateEventPayload(payload, webviewPanel.webview),
              ),
            );
          },
        })
      : undefined;
    const bridgeDisposable = attachWebviewBridgeRouter(webviewPanel.webview, "preview", {
      getBridgeState: (surface) => createBridgeState(surface, getCurrentWorkspaceTrustState()),
      handlePreviewLatexCompile: async (payload) => liveCompiler
        ? liveCompiler.compileNow(payload.engine as LatexEngine, "manual")
        : compileLatexDocument(document.uri, payload.engine as LatexEngine),
    });
    const companionPdfUri = await findCompanionPdf(document.uri);
    const localResourceRoots = uniqueUris([
      vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      directoryUri(document.uri),
      resolution.ok ? resolution.targetFolderUri : undefined,
      companionPdfUri ? directoryUri(companionPdfUri) : undefined,
    ]);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    const preview = await createPreviewModel(
      document.uri,
      webviewPanel.webview,
      resolution,
      companionPdfUri,
      trustState,
    );

    const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      liveCompiler?.notifyDocumentChanged(document.uri, event.document.uri.toString() === document.uri.toString() && event.contentChanges.length > 0);
    });
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
      liveCompiler?.notifyDocumentSaved(savedDocument.uri);
    });

    webviewPanel.onDidDispose(() => {
      bridgeDisposable.dispose();
      changeDisposable.dispose();
      saveDisposable.dispose();
      liveCompiler?.dispose();
    });

    webviewPanel.webview.html = renderWebviewHtml(
      webviewPanel.webview,
      this.context.extensionUri,
      {
        title: "Kady Preview",
        heading: preview.heading,
        body: preview.body,
        bodyIsHtml: preview.bodyIsHtml,
        kind: "preview",
        trust: trustState,
      },
    );

    liveCompiler?.prime();
  }
}

interface KadyPreviewDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

async function createPreviewModel(
  resource: vscode.Uri,
  webview: vscode.Webview,
  resolution: ReturnType<typeof resolveWorkspaceTarget>,
  companionPdfUri: vscode.Uri | undefined,
  trustState: ReturnType<typeof getCurrentWorkspaceTrustState>,
) {
  if (!resolution.ok) {
    return {
      heading: `${basename(resource)} • Kady Preview`,
      body: [
        '<div class="preview-stack">',
        '<section class="preview-banner">',
        "<div>",
        '<span class="eyebrow">Open With Kady Preview</span>',
        `<h2 class="preview-title">${escapeHtml(basename(resource))} stays an explicit preview surface.</h2>`,
        `<p class="preview-copy">${escapeHtml(resolution.message)}</p>`,
        "</div>",
        `</section><section class="preview-card"><pre class="preview-pre">${escapeHtml(resource.toString())}</pre></section></div>`,
      ].join(""),
      bodyIsHtml: true as const,
    };
  }

  const rawBytes = await readResourceBytes(resource);
  const content = decodeResourceText(rawBytes);
  const preview = await renderKadyPreview({
    resource,
    content,
    rawBytes,
    sizeBytes: rawBytes.byteLength,
    workspaceTargetName: resolution.targetFolder.name,
    workspaceTargetUri: resolution.targetFolderUri,
    toWebviewUri: (uri) => webview.asWebviewUri(uri),
    companionPdfUri,
    trustState,
  });

  return {
    heading: preview.heading,
    body: preview.bodyHtml,
    bodyIsHtml: preview.bodyIsHtml,
  };
}

async function readResourceBytes(resource: vscode.Uri) {
  return vscode.workspace.fs.readFile(resource);
}

function decodeResourceText(bytes: Uint8Array) {
  return new TextDecoder(undefined, { fatal: false }).decode(bytes);
}

async function findCompanionPdf(resource: vscode.Uri) {
  const extensionIndex = resource.path.lastIndexOf(".");

  if (extensionIndex < 0) {
    return undefined;
  }

  const candidate = resource.with({ path: `${resource.path.slice(0, extensionIndex)}.pdf` });

  try {
    await vscode.workspace.fs.stat(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

function isLatexPreviewResource(resource: vscode.Uri) {
  const extension = resource.path.slice(resource.path.lastIndexOf(".")).toLowerCase();
  return extension === ".tex" || extension === ".latex";
}

function serializePreviewLatexStateEventPayload(
  payload: PreviewLatexStateEventPayload,
  webview: vscode.Webview,
): PreviewLatexStateEventPayload {
  if (payload.phase === "running") {
    return payload;
  }

  return {
    ...payload,
    pdfUri: payload.pdfUri ? toWebviewPdfUri(vscode.Uri.parse(payload.pdfUri), webview) : undefined,
  };
}

function toWebviewPdfUri(resource: vscode.Uri, webview: vscode.Webview) {
  return appendCacheBust(webview.asWebviewUri(resource).toString(), Date.now());
}

function appendCacheBust(value: string, stamp: number) {
  const [withoutHash, hash = ""] = value.split("#", 2);
  const separator = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${separator}kdense-preview=${stamp}${hash ? `#${hash}` : ""}`;
}

function uniqueUris(values: Array<vscode.Uri | undefined>) {
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const key = value.toString();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
