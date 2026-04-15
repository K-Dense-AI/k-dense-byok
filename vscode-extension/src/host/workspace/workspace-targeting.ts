import * as vscode from "vscode";

export type WorkspaceTargetFailureCode =
  | "no-workspace-folders"
  | "invalid-explicit-target"
  | "invalid-referenced-resource"
  | "ambiguous-workspace-target";

export type WorkspaceTargetResolutionSource =
  | "explicit"
  | "reference"
  | "single-root";

export interface WorkspaceTargetRequest {
  explicitTarget?: vscode.Uri;
  referencedResource?: vscode.Uri;
}

export interface WorkspaceTargetOption {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly uri: vscode.Uri;
}

export interface WorkspaceTargetSuccess {
  readonly ok: true;
  readonly source: WorkspaceTargetResolutionSource;
  readonly targetFolder: vscode.WorkspaceFolder;
  readonly targetFolderUri: vscode.Uri;
}

export interface WorkspaceTargetFailure {
  readonly ok: false;
  readonly code: WorkspaceTargetFailureCode;
  readonly message: string;
}

export type WorkspaceTargetResolution =
  | WorkspaceTargetSuccess
  | WorkspaceTargetFailure;

export interface WorkspaceTargetingDependencies {
  getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined;
  getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
}

const defaultDependencies: WorkspaceTargetingDependencies = {
  getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
  getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
};

export function listWorkspaceTargetOptions(
  dependencies: WorkspaceTargetingDependencies = defaultDependencies,
): WorkspaceTargetOption[] {
  return getWorkspaceFolders(dependencies).map((folder) => ({
    id: folder.uri.toString(),
    name: folder.name,
    index: folder.index,
    uri: folder.uri,
  }));
}

export function resolveWorkspaceTarget(
  request: WorkspaceTargetRequest,
  dependencies: WorkspaceTargetingDependencies = defaultDependencies,
): WorkspaceTargetResolution {
  const workspaceFolders = getWorkspaceFolders(dependencies);

  if (workspaceFolders.length === 0) {
    return failure(
      "no-workspace-folders",
      "Open a workspace folder before running workspace actions.",
    );
  }

  if (request.explicitTarget) {
    const explicitFolder = dependencies.getWorkspaceFolder(request.explicitTarget);

    if (!explicitFolder) {
      return failure(
        "invalid-explicit-target",
        "The selected target folder is no longer part of this window's workspace.",
      );
    }

    return success("explicit", explicitFolder);
  }

  if (request.referencedResource) {
    const referencedFolder = dependencies.getWorkspaceFolder(
      request.referencedResource,
    );

    if (!referencedFolder) {
      return failure(
        "invalid-referenced-resource",
        "The referenced resource does not belong to an open workspace folder.",
      );
    }

    return success("reference", referencedFolder);
  }

  if (workspaceFolders.length === 1) {
    return success("single-root", workspaceFolders[0]);
  }

  return failure(
    "ambiguous-workspace-target",
    "Choose a target workspace folder before running this action.",
  );
}

function getWorkspaceFolders(
  dependencies: WorkspaceTargetingDependencies,
): readonly vscode.WorkspaceFolder[] {
  return dependencies.getWorkspaceFolders() ?? [];
}

function success(
  source: WorkspaceTargetResolutionSource,
  targetFolder: vscode.WorkspaceFolder,
): WorkspaceTargetSuccess {
  return {
    ok: true,
    source,
    targetFolder,
    targetFolderUri: targetFolder.uri,
  };
}

function failure(
  code: WorkspaceTargetFailureCode,
  message: string,
): WorkspaceTargetFailure {
  return {
    ok: false,
    code,
    message,
  };
}
