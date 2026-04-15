import * as vscode from "vscode";
import {
  createWorkspaceTrustState,
  getWorkspaceCapabilityLabel,
  isWorkspaceCapabilityAllowed,
  type WorkspaceCapability,
  type WorkspaceTrustState,
} from "../shared/workspace-trust";

export interface WorkspaceTrustDependencies {
  isWorkspaceTrusted(): boolean;
  showWarningMessage(message: string): Thenable<unknown> | Promise<unknown>;
}

export interface RunWorkspaceCapabilityActionOptions<T> {
  capability: WorkspaceCapability;
  dependencies?: WorkspaceTrustDependencies;
  action: () => T | Promise<T>;
}

const defaultDependencies: WorkspaceTrustDependencies = {
  isWorkspaceTrusted: () => vscode.workspace.isTrusted,
  showWarningMessage: (message) => vscode.window.showWarningMessage(message),
};

export function getCurrentWorkspaceTrustState(
  dependencies: WorkspaceTrustDependencies = defaultDependencies,
): WorkspaceTrustState {
  return createWorkspaceTrustState(dependencies.isWorkspaceTrusted());
}

export async function ensureWorkspaceCapability(
  capability: WorkspaceCapability,
  dependencies: WorkspaceTrustDependencies = defaultDependencies,
) {
  const trustState = getCurrentWorkspaceTrustState(dependencies);

  if (isWorkspaceCapabilityAllowed(trustState, capability)) {
    return true;
  }

  await dependencies.showWarningMessage(createWorkspaceCapabilityDeniedMessage(capability));
  return false;
}

export async function runWorkspaceCapabilityAction<T>(
  options: RunWorkspaceCapabilityActionOptions<T>,
): Promise<T | false> {
  const allowed = await ensureWorkspaceCapability(
    options.capability,
    options.dependencies,
  );

  if (!allowed) {
    return false;
  }

  return options.action();
}

export function createWorkspaceCapabilityDeniedMessage(capability: WorkspaceCapability) {
  return `${getWorkspaceCapabilityLabel(capability)} are unavailable in Restricted Mode. Trust this workspace to enable that capability.`;
}
