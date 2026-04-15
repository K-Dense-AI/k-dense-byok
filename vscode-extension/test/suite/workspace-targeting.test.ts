import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  listWorkspaceTargetOptions,
  resolveWorkspaceTarget,
  type WorkspaceTargetingDependencies,
} from "../../src/host/workspace";

suite("workspace targeting", () => {
  test("resolves an explicit target in a multi-root workspace", () => {
    const folders = createWorkspaceFolders([
      "vscode-remote://ssh-remote+research/home/clay/project-a",
      "vscode-remote://ssh-remote+research/home/clay/project-b",
    ]);

    const result = resolveWorkspaceTarget(
      {
        explicitTarget: vscode.Uri.parse(
          "vscode-remote://ssh-remote+research/home/clay/project-b/src/notebook.py",
        ),
      },
      createDependencies(folders),
    );

    assert.equal(result.ok, true);
    assert.equal(result.source, "explicit");
    assert.equal(result.targetFolder.name, "project-b");
    assert.equal(
      result.targetFolderUri.toString(),
      folders[1].uri.toString(),
    );
  });

  test("resolves a referenced resource when no explicit target is provided", () => {
    const folders = createWorkspaceFolders([
      "memfs:/workspace-alpha",
      "memfs:/workspace-beta",
    ]);

    const result = resolveWorkspaceTarget(
      {
        referencedResource: vscode.Uri.parse(
          "memfs:/workspace-beta/data/results.tsv",
        ),
      },
      createDependencies(folders),
    );

    assert.equal(result.ok, true);
    assert.equal(result.source, "reference");
    assert.equal(result.targetFolder.name, "workspace-beta");
  });

  test("falls back to the lone folder for a single-root workspace", () => {
    const folders = createWorkspaceFolders(["file:///tmp/kdense-workspace"]);

    const result = resolveWorkspaceTarget({}, createDependencies(folders));

    assert.equal(result.ok, true);
    assert.equal(result.source, "single-root");
    assert.equal(result.targetFolder.name, "kdense-workspace");
  });

  test("fails safely when a multi-root action has no deterministic target", () => {
    const folders = createWorkspaceFolders([
      "file:///workspace-a",
      "file:///workspace-b",
    ]);

    const result = resolveWorkspaceTarget({}, createDependencies(folders));

    assert.deepEqual(result, {
      ok: false,
      code: "ambiguous-workspace-target",
      message: "Choose a target workspace folder before running this action.",
    });
  });

  test("fails when no workspace folders are open", () => {
    const result = resolveWorkspaceTarget({}, createDependencies([]));

    assert.deepEqual(result, {
      ok: false,
      code: "no-workspace-folders",
      message: "Open a workspace folder before running workspace actions.",
    });
  });

  test("fails when an explicit target no longer maps to an open folder", () => {
    const folders = createWorkspaceFolders(["file:///workspace-a"]);
    const result = resolveWorkspaceTarget(
      {
        explicitTarget: vscode.Uri.parse("file:///workspace-b/file.txt"),
      },
      createDependencies(folders),
    );

    assert.deepEqual(result, {
      ok: false,
      code: "invalid-explicit-target",
      message:
        "The selected target folder is no longer part of this window's workspace.",
    });
  });

  test("fails when a referenced resource is outside the workspace", () => {
    const folders = createWorkspaceFolders(["memfs:/workspace-a"]);
    const result = resolveWorkspaceTarget(
      {
        referencedResource: vscode.Uri.parse("memfs:/other-workspace/file.txt"),
      },
      createDependencies(folders),
    );

    assert.deepEqual(result, {
      ok: false,
      code: "invalid-referenced-resource",
      message:
        "The referenced resource does not belong to an open workspace folder.",
    });
  });

  test("lists target options using URI-safe folder identifiers", () => {
    const folders = createWorkspaceFolders([
      "vscode-remote://ssh-remote+research/home/clay/project-a",
      "memfs:/workspace-b",
    ]);

    const options = listWorkspaceTargetOptions(createDependencies(folders));

    assert.deepEqual(
      options.map((option) => ({
        id: option.id,
        name: option.name,
        index: option.index,
      })),
      [
        {
          id: folders[0].uri.toString(),
          name: "project-a",
          index: 0,
        },
        {
          id: folders[1].uri.toString(),
          name: "workspace-b",
          index: 1,
        },
      ],
    );
  });
});

function createWorkspaceFolders(folderUris: string[]): vscode.WorkspaceFolder[] {
  return folderUris.map((value, index) => {
    const uri = vscode.Uri.parse(value);
    return {
      uri,
      name: basename(uri),
      index,
    };
  });
}

function createDependencies(
  folders: vscode.WorkspaceFolder[],
): WorkspaceTargetingDependencies {
  return {
    getWorkspaceFolders: () => folders,
    getWorkspaceFolder: (uri) => findWorkspaceFolder(folders, uri),
  };
}

function findWorkspaceFolder(
  folders: vscode.WorkspaceFolder[],
  target: vscode.Uri,
): vscode.WorkspaceFolder | undefined {
  const exactMatch = folders.find(
    (folder) => folder.uri.toString() === target.toString(),
  );

  if (exactMatch) {
    return exactMatch;
  }

  return folders.find((folder) => isEqualOrParent(folder.uri, target));
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

function basename(uri: vscode.Uri): string {
  const segments = uri.path.split("/").filter(Boolean);
  return segments.at(-1) ?? uri.authority ?? uri.scheme;
}
