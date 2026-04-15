import * as vscode from "vscode";
import {
  CHAT_VIEW_ID,
  FOCUS_SIDEBAR_COMMAND_ID,
  KADY_PREVIEW_EDITOR_VIEW_TYPE,
  OPEN_PREVIEW_COMMAND_ID,
  SIDEBAR_CONTAINER_ID,
} from "./constants";
import { runWorkspaceCapabilityAction } from "./host/workspace-trust";
import { KadyPreviewEditorProvider } from "./panels/kady-preview-panel";
import { openKadyPreview } from "./preview/kady-preview-entrypoint";
import { KadyChatViewProvider } from "./views/kady-chat-view-provider";

export function activate(context: vscode.ExtensionContext) {
  const chatViewProvider = new KadyChatViewProvider(context);
  const previewEditorProvider = new KadyPreviewEditorProvider(context);
  const focusSidebarContainerCommandId = `workbench.view.extension.${SIDEBAR_CONTAINER_ID}`;

  const revealSidebar = async () => {
    await vscode.commands.executeCommand(focusSidebarContainerCommandId);
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatViewProvider),
    vscode.commands.registerCommand(FOCUS_SIDEBAR_COMMAND_ID, async () =>
      runWorkspaceCapabilityAction({
        capability: "readOnlyUi",
        action: async () => {
          await revealSidebar();
          return true;
        },
      })),
    vscode.window.registerCustomEditorProvider(
      KADY_PREVIEW_EDITOR_VIEW_TYPE,
      previewEditorProvider,
    ),
    vscode.commands.registerCommand(OPEN_PREVIEW_COMMAND_ID, (resource?: vscode.Uri) =>
      runWorkspaceCapabilityAction({
        capability: "previewOpen",
        action: () => openKadyPreview(resource),
      })),
  );

  setTimeout(() => {
    void revealSidebar();
  }, 0);
}

export function deactivate() {
  // Intentionally empty while the scaffold has no disposable singleton state.
}
