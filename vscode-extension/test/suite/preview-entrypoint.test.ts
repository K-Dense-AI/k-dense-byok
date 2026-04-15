import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { KADY_PREVIEW_EDITOR_VIEW_TYPE } from "../../src/constants";
import {
  isKadyPreviewResource,
  openKadyPreview,
} from "../../src/preview/kady-preview-entrypoint";

suite("preview entrypoint", () => {
  test("accepts supported preview resources and rejects notebooks", () => {
    assert.equal(isKadyPreviewResource(vscode.Uri.parse("file:///workspace/notes.md")), true);
    assert.equal(isKadyPreviewResource(vscode.Uri.parse("file:///workspace/table.csv")), true);
    assert.equal(isKadyPreviewResource(vscode.Uri.parse("file:///workspace/variants.bcf")), true);
    assert.equal(isKadyPreviewResource(vscode.Uri.parse("file:///workspace/notebook.ipynb")), false);
  });

  test("opens supported files with vscode.openWith and the Kady preview view type", async () => {
    const resource = vscode.Uri.parse("file:///workspace-b/results.tsv");
    const workspaceFolderUri = vscode.Uri.parse("file:///workspace-b");
    const commands: unknown[][] = [];
    const targetRequests: unknown[] = [];

    const opened = await openKadyPreview(resource, {
      getActiveResource: () => undefined,
      resolveWorkspaceTarget: (request) => {
        targetRequests.push(request);
        return {
          ok: true,
          source: "reference",
          targetFolder: {
            uri: workspaceFolderUri,
            name: "workspace-b",
            index: 1,
          },
          targetFolderUri: workspaceFolderUri,
        };
      },
      executeCommand: async (command, ...args) => {
        commands.push([command, ...args]);
      },
      showErrorMessage: async (message) => {
        throw new Error(`Unexpected preview error: ${message}`);
      },
    });

    assert.equal(opened, true);
    assert.deepEqual(targetRequests, [{ referencedResource: resource }]);
    assert.deepEqual(commands, [
      [
        "vscode.openWith",
        resource,
        KADY_PREVIEW_EDITOR_VIEW_TYPE,
        vscode.ViewColumn.Beside,
      ],
    ]);
  });

  test("blocks explicit preview when the resource is outside the active workspace targeting context", async () => {
    const resource = vscode.Uri.parse("file:///outside-workspace/notes.md");
    const errors: string[] = [];
    let executeCount = 0;

    const opened = await openKadyPreview(resource, {
      getActiveResource: () => undefined,
      resolveWorkspaceTarget: () => ({
        ok: false,
        code: "invalid-referenced-resource",
        message: "The referenced resource does not belong to an open workspace folder.",
      }),
      executeCommand: async () => {
        executeCount += 1;
      },
      showErrorMessage: async (message) => {
        errors.push(message);
      },
    });

    assert.equal(opened, false);
    assert.equal(executeCount, 0);
    assert.deepEqual(errors, [
      "The referenced resource does not belong to an open workspace folder.",
    ]);
  });
});
