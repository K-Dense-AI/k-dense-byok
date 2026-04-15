import * as vscode from "vscode";
import { KADY_PREVIEW_EDITOR_VIEW_TYPE } from "../constants";
import {
  resolveWorkspaceTarget,
  type WorkspaceTargetRequest,
  type WorkspaceTargetResolution,
} from "../host/workspace";

const SUPPORTED_KADY_PREVIEW_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".tex",
  ".latex",
  ".csv",
  ".tsv",
  ".fasta",
  ".fa",
  ".fna",
  ".ffn",
  ".faa",
  ".frn",
  ".fastq",
  ".fq",
  ".vcf",
  ".gff",
  ".gff3",
  ".bed",
  ".sam",
  ".bcf",
]);

export interface OpenKadyPreviewDependencies {
  getActiveResource(): vscode.Uri | undefined;
  resolveWorkspaceTarget(
    request: WorkspaceTargetRequest,
  ): WorkspaceTargetResolution;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  showErrorMessage(message: string): Thenable<unknown>;
}

const defaultDependencies: OpenKadyPreviewDependencies = {
  getActiveResource: () => vscode.window.activeTextEditor?.document.uri,
  resolveWorkspaceTarget,
  executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  showErrorMessage: (message) => vscode.window.showErrorMessage(message),
};

export async function openKadyPreview(
  resource?: vscode.Uri,
  dependencies: OpenKadyPreviewDependencies = defaultDependencies,
): Promise<boolean> {
  const targetResource = resource ?? dependencies.getActiveResource();

  if (!targetResource) {
    await dependencies.showErrorMessage(
      "Open a supported workspace file or pass a resource to Kady Preview.",
    );
    return false;
  }

  if (!isKadyPreviewResource(targetResource)) {
    await dependencies.showErrorMessage(
      "Kady Preview currently supports Markdown, LaTeX, CSV, and bundled bioinformatics file formats.",
    );
    return false;
  }

  const resolution = dependencies.resolveWorkspaceTarget({
    referencedResource: targetResource,
  });

  if (!resolution.ok) {
    await dependencies.showErrorMessage(resolution.message);
    return false;
  }

  await dependencies.executeCommand(
    "vscode.openWith",
    targetResource,
    KADY_PREVIEW_EDITOR_VIEW_TYPE,
    vscode.ViewColumn.Beside,
  );

  return true;
}

export function isKadyPreviewResource(resource: vscode.Uri) {
  if (resource.scheme === "untitled") {
    return false;
  }

  return SUPPORTED_KADY_PREVIEW_EXTENSIONS.has(getResourceExtension(resource));
}

function getResourceExtension(resource: vscode.Uri) {
  const name = basename(resource).toLowerCase();
  const extensionIndex = name.lastIndexOf(".");

  return extensionIndex >= 0 ? name.slice(extensionIndex) : "";
}

function basename(resource: vscode.Uri) {
  const segments = resource.path.split("/").filter(Boolean);
  return segments.at(-1) ?? resource.authority ?? resource.scheme;
}
