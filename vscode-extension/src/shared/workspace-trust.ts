export const WORKSPACE_CAPABILITY_ORDER = [
  "readOnlyUi",
  "previewOpen",
  "write",
  "execute",
  "backendStart",
  "secretSensitive",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITY_ORDER)[number];
export type WorkspaceTrustMode = "trusted" | "restricted";

export type WorkspaceCapabilityMatrix = Record<WorkspaceCapability, boolean>;

export type WorkspaceTrustState = {
  isTrusted: boolean;
  mode: WorkspaceTrustMode;
  statusLabel: string;
  summary: string;
  detail: string;
  capabilities: WorkspaceCapabilityMatrix;
  allowedCapabilities: WorkspaceCapability[];
  blockedCapabilities: WorkspaceCapability[];
};

const WORKSPACE_CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
  readOnlyUi: "Read-only UI",
  previewOpen: "Preview open",
  write: "Write actions",
  execute: "Execute actions",
  backendStart: "Backend start",
  secretSensitive: "Secret-sensitive actions",
};

export function createWorkspaceTrustState(isTrusted: boolean): WorkspaceTrustState {
  const capabilities: WorkspaceCapabilityMatrix = {
    readOnlyUi: true,
    previewOpen: true,
    write: isTrusted,
    execute: isTrusted,
    backendStart: isTrusted,
    secretSensitive: isTrusted,
  };

  const allowedCapabilities = WORKSPACE_CAPABILITY_ORDER.filter(
    (capability) => capabilities[capability],
  );
  const blockedCapabilities = WORKSPACE_CAPABILITY_ORDER.filter(
    (capability) => !capabilities[capability],
  );

  return {
    isTrusted,
    mode: isTrusted ? "trusted" : "restricted",
    statusLabel: isTrusted ? "Trusted Mode" : "Restricted Mode",
    summary: isTrusted
      ? "This workspace is trusted, so K-Dense can expose read, preview, write, execute, backend-start, and secret-sensitive actions when those features land."
      : "This workspace is untrusted, so K-Dense stays in Restricted Mode and only exposes read-only browsing plus explicit preview actions.",
    detail: isTrusted
      ? "Trust has been granted, so future write, execution, backend, and secret-handling flows may be enabled by host policy."
      : "Write, execution, backend start, and secret-sensitive flows remain blocked in host code even if a hidden or future UI path is triggered.",
    capabilities,
    allowedCapabilities,
    blockedCapabilities,
  };
}

export function getWorkspaceCapabilityLabel(capability: WorkspaceCapability) {
  return WORKSPACE_CAPABILITY_LABELS[capability];
}

export function isWorkspaceCapabilityAllowed(
  trustState: WorkspaceTrustState,
  capability: WorkspaceCapability,
) {
  return trustState.capabilities[capability];
}
