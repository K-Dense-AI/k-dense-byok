import * as vscode from "vscode";
import type { WorkspaceTrustState } from "../shared/workspace-trust";

type WebviewModel = {
  title: string;
  heading: string;
  body: string;
  bodyIsHtml?: boolean;
  kind: "sidebar" | "preview";
  trust?: WorkspaceTrustState;
};

export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  model: WebviewModel,
) {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(model.title)}</title>
    <style>
      html,
      body,
      #app {
        height: 100%;
      }

      body {
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__KDENSE_WEBVIEW__ = ${JSON.stringify(model)};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return nonce;
}
