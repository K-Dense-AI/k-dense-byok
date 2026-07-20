export const MODAL_JOB_STATES = [
  "queued",
  "preparing",
  "running",
  "collecting",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;

export type ModalJobState = (typeof MODAL_JOB_STATES)[number];
export type ModalTerminalState = Extract<
  ModalJobState,
  "succeeded" | "failed" | "cancelled" | "lost"
>;

export const TERMINAL_MODAL_JOB_STATES = new Set<ModalJobState>([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

export function isTerminalModalState(state: ModalJobState): state is ModalTerminalState {
  return TERMINAL_MODAL_JOB_STATES.has(state);
}

export interface ModalImageRequest {
  base?: string;
  pip?: string[];
  apt?: string[];
}

export interface ModalJobRequest {
  command: string;
  instance?: string;
  gpuCount?: number;
  gpuFallback?: string[];
  image?: ModalImageRequest;
  /** Named, reusable published image built from `image`. */
  environment?: string;
  /** Project cache Volume is the default; `none` keeps the job fully ephemeral. */
  cache?: "project" | "none";
  filesIn?: string[];
  filesOut?: string[];
  timeoutSec?: number;
  groupId?: string;
  label?: string;
}

export interface ModalJobOwner {
  sessionId: string;
  runId?: string;
  subagentRunId?: string;
  submittedBy: "lead" | "subagent" | "api";
}

export interface ModalTransferFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ModalJobErrorInfo {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ModalJobEvent {
  seq: number;
  ts: number;
  type: string;
  state?: ModalJobState;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ModalJob {
  version: 1;
  id: string;
  projectId: string;
  state: ModalJobState;
  request: Required<Pick<ModalJobRequest, "command" | "instance" | "gpuCount" | "timeoutSec">> &
    Omit<ModalJobRequest, "command" | "instance" | "gpuCount" | "timeoutSec">;
  owner: ModalJobOwner;
  createdAt: number;
  updatedAt: number;
  queuedAt: number;
  preparingAt?: number;
  runningAt?: number;
  collectingAt?: number;
  finishedAt?: number;
  cancelRequested: boolean;
  cancelRequestedAt?: number;
  reservationUsd: number;
  effectiveInstance?: string;
  effectiveGpu?: string | null;
  pricePerHour?: number;
  sandboxId?: string;
  sandboxName: string;
  sandboxTags: Record<string, string>;
  sandboxCreatedAt?: number;
  sandboxTerminatedAt?: number;
  exitCode?: number;
  error?: ModalJobErrorInfo;
  inputFiles: ModalTransferFile[];
  outputFiles: ModalTransferFile[];
  missingOutputs: string[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutBaseCursor: number;
  stderrBaseCursor: number;
  eventSeq: number;
  retryOf?: string;
  accounting: {
    reconciled: boolean;
    estimatedCostUsd?: number;
    ledgerEntryId?: string;
  };
}

export interface ModalJobResult {
  job: ModalJob;
  stdout: string;
  stderr: string;
}

export class ModalJobError extends Error {
  code: string;
  statusCode: number;
  retryable: boolean;

  constructor(code: string, message: string, statusCode = 400, retryable = false) {
    super(message);
    this.name = "ModalJobError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class ModalCancellationError extends ModalJobError {
  constructor(message = "Modal job was cancelled") {
    super("CANCELLED", message, 409, false);
  }
}
