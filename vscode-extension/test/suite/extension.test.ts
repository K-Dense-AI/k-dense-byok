import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  CHAT_VIEW_ID,
  FOCUS_SIDEBAR_COMMAND_ID,
  KADY_PREVIEW_EDITOR_VIEW_TYPE,
  OPEN_PREVIEW_COMMAND_ID,
  SIDEBAR_CONTAINER_ID,
} from "../../src/constants";

const EXTENSION_ID = "kdense.vscode-extension";

suite("K-Dense BYOK extension activation", () => {
  test("activates, keeps native text open by default, and opens Kady Preview explicitly", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.ok(extension, `Expected extension ${EXTENSION_ID} to be installed.`);

    await extension.activate();

    assert.equal(extension.isActive, true);
    assert.equal(extension.packageJSON.main, "./dist/extension.js");
    assert.equal(
      extension.packageJSON.contributes.customEditors[0].priority,
      "option",
    );
    assert.equal(
      extension.packageJSON.contributes.customEditors[0].viewType,
      KADY_PREVIEW_EDITOR_VIEW_TYPE,
    );
    assert.ok(
      extension.packageJSON.contributes.customEditors[0].selector.some(
        (selector: { filenamePattern: string }) => selector.filenamePattern === "*.bcf",
      ),
    );

    const contributedView = extension.packageJSON.contributes.views[
      SIDEBAR_CONTAINER_ID
    ].find((view: { id: string }) => view.id === CHAT_VIEW_ID);

    assert.ok(contributedView, `Expected view contribution ${CHAT_VIEW_ID}.`);

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes(FOCUS_SIDEBAR_COMMAND_ID));
    assert.ok(commands.includes(OPEN_PREVIEW_COMMAND_ID));

    const markdownUri = getFixtureResourceUri("workspace-a", "notes.md");
    const document = await vscode.workspace.openTextDocument(markdownUri);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand(FOCUS_SIDEBAR_COMMAND_ID);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.One,
    });

    const nativeTab = await waitForTab(
      (candidate) =>
        candidate.input instanceof vscode.TabInputText &&
        candidate.input.uri.toString() === markdownUri.toString(),
    );

    assert.ok(nativeTab.input instanceof vscode.TabInputText);

    await vscode.commands.executeCommand(OPEN_PREVIEW_COMMAND_ID, markdownUri);

    const previewTab = await waitForTab(
      (candidate) =>
        candidate.input instanceof vscode.TabInputCustom &&
        candidate.input.viewType === KADY_PREVIEW_EDITOR_VIEW_TYPE &&
        candidate.input.uri.toString() === markdownUri.toString(),
    );

    assert.ok(previewTab.input instanceof vscode.TabInputCustom);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});

function getFixtureResourceUri(folderName: string, fileName: string) {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.name === folderName,
  );

  assert.ok(folder, `Expected fixture workspace folder ${folderName}.`);

  return vscode.Uri.joinPath(folder.uri, fileName);
}

async function waitForTab(predicate: (tab: vscode.Tab) => boolean) {
  const timeoutAt = Date.now() + 10000;

  while (Date.now() < timeoutAt) {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(predicate);

    if (tab) {
      return tab;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for the expected tab to open.");
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
