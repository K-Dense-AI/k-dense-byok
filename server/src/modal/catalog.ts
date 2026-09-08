import { ModalJobError, type ModalImageRequest, type ModalJobRequest } from "./types.ts";

export interface ModalInstanceSpec {
  id: string;
  label: string;
  kind: "cpu" | "gpu";
  gpu: string | null;
  cpu: number;
  memoryMiB: number;
  pricePerHour: number;
  defaultImage: string;
  maxGpuCount: number;
  legacy?: boolean;
}

const DEFAULT_IMAGE = "python:3.13-slim";

export const MODAL_CATALOG_METADATA = {
  updatedAt: "2026-07-20",
  source: "K-Dense curated Modal resource estimates",
  estimated: true,
  unit: "USD/hour",
  /** Worst-case quotes cover timeout + this headroom; see transferHeadroomSec. */
  transferHeadroom: { minSec: 60, fraction: 0.1, maxSec: 900 },
} as const;

/**
 * Authoritative execution and estimated-billing catalogue.
 *
 * Rates are deliberately labelled estimates in API responses and ledger rows:
 * Modal's actual invoice can differ due to platform pricing changes and
 * resource-specific billing details.
 */
export const MODAL_INSTANCES: readonly ModalInstanceSpec[] = [
  { id: "cpu", label: "CPU · 1 core", kind: "cpu", gpu: null, cpu: 1, memoryMiB: 2048, pricePerHour: 0.05, defaultImage: DEFAULT_IMAGE, maxGpuCount: 1, legacy: true },
  { id: "cpu-2", label: "CPU · 2 cores", kind: "cpu", gpu: null, cpu: 2, memoryMiB: 4096, pricePerHour: 0.10, defaultImage: DEFAULT_IMAGE, maxGpuCount: 1 },
  { id: "cpu-4", label: "CPU · 4 cores", kind: "cpu", gpu: null, cpu: 4, memoryMiB: 8192, pricePerHour: 0.20, defaultImage: DEFAULT_IMAGE, maxGpuCount: 1 },
  { id: "cpu-8", label: "CPU · 8 cores", kind: "cpu", gpu: null, cpu: 8, memoryMiB: 16384, pricePerHour: 0.40, defaultImage: DEFAULT_IMAGE, maxGpuCount: 1 },
  { id: "cpu-16", label: "CPU · 16 cores", kind: "cpu", gpu: null, cpu: 16, memoryMiB: 32768, pricePerHour: 0.80, defaultImage: DEFAULT_IMAGE, maxGpuCount: 1 },
  { id: "t4", label: "NVIDIA T4", kind: "gpu", gpu: "T4", cpu: 2, memoryMiB: 8192, pricePerHour: 0.59, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8, legacy: true },
  { id: "l4", label: "NVIDIA L4", kind: "gpu", gpu: "L4", cpu: 2, memoryMiB: 8192, pricePerHour: 0.80, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8, legacy: true },
  { id: "a10g", label: "NVIDIA A10", kind: "gpu", gpu: "A10", cpu: 4, memoryMiB: 16384, pricePerHour: 1.10, defaultImage: DEFAULT_IMAGE, maxGpuCount: 4, legacy: true },
  { id: "l40s", label: "NVIDIA L40S", kind: "gpu", gpu: "L40S", cpu: 4, memoryMiB: 16384, pricePerHour: 1.95, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8 },
  { id: "a100-40gb", label: "NVIDIA A100 40GB", kind: "gpu", gpu: "A100-40GB", cpu: 4, memoryMiB: 32768, pricePerHour: 2.78, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8, legacy: true },
  { id: "a100-80gb", label: "NVIDIA A100 80GB", kind: "gpu", gpu: "A100-80GB", cpu: 8, memoryMiB: 65536, pricePerHour: 3.40, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8, legacy: true },
  { id: "h100", label: "NVIDIA H100", kind: "gpu", gpu: "H100", cpu: 8, memoryMiB: 65536, pricePerHour: 4.56, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8, legacy: true },
  { id: "h200", label: "NVIDIA H200", kind: "gpu", gpu: "H200", cpu: 8, memoryMiB: 65536, pricePerHour: 5.25, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8 },
  { id: "b200", label: "NVIDIA B200", kind: "gpu", gpu: "B200", cpu: 8, memoryMiB: 65536, pricePerHour: 6.25, defaultImage: DEFAULT_IMAGE, maxGpuCount: 8 },
] as const;

const BY_ID = new Map(MODAL_INSTANCES.map((spec) => [spec.id, spec]));

export const DEFAULT_INSTANCE_ID = "cpu";
export const MODAL_INSTANCE_IDS = MODAL_INSTANCES.map((spec) => spec.id);

export function resolveInstance(id: string | null | undefined): ModalInstanceSpec | null {
  return id ? BY_ID.get(id) ?? null : null;
}

export function gpuString(spec: ModalInstanceSpec, count: number): string | undefined {
  if (!spec.gpu) return undefined;
  return count === 1 ? spec.gpu : `${spec.gpu}:${count}`;
}

export function validateGpuCount(spec: ModalInstanceSpec, count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new ModalJobError("INVALID_GPU_COUNT", "gpuCount must be a positive integer");
  }
  if (spec.kind === "cpu" && count !== 1) {
    throw new ModalJobError("INVALID_GPU_COUNT", `CPU instance "${spec.id}" requires gpuCount=1`);
  }
  if (count > spec.maxGpuCount) {
    throw new ModalJobError(
      "INVALID_GPU_COUNT",
      `Instance "${spec.id}" supports at most ${spec.maxGpuCount} GPU(s)`,
    );
  }
}

export function validateInstanceChain(request: ModalJobRequest): ModalInstanceSpec[] {
  const ids = [request.instance ?? DEFAULT_INSTANCE_ID, ...(request.gpuFallback ?? [])];
  if (ids.length > 8) {
    throw new ModalJobError("INVALID_FALLBACK", "At most 7 fallback instances are allowed");
  }
  if (new Set(ids).size !== ids.length) {
    throw new ModalJobError("INVALID_FALLBACK", "Fallback instances must be unique");
  }
  const count = request.gpuCount ?? 1;
  return ids.map((id) => {
    const spec = resolveInstance(id);
    if (!spec) {
      throw new ModalJobError(
        "UNKNOWN_INSTANCE",
        `Unknown Modal instance "${id}". Valid instances: ${MODAL_INSTANCE_IDS.join(", ")}`,
      );
    }
    validateGpuCount(spec, count);
    return spec;
  });
}

export function hourlyEstimate(spec: ModalInstanceSpec, gpuCount: number): number {
  return spec.pricePerHour * (spec.kind === "gpu" ? gpuCount : 1);
}

/**
 * Extra sandbox lifetime beyond the command timeout, reserved for staging
 * inputs and collecting outputs so a command that legitimately uses its whole
 * timeout does not lose its outputs to the sandbox dying mid-download.
 * 10 % of the timeout, never less than a minute, never more than 15 minutes.
 */
export function transferHeadroomSec(timeoutSec: number): number {
  return Math.min(Math.max(60, Math.ceil(timeoutSec * 0.1)), 900);
}

/** Maximum lifetime requested from Modal for a job's sandbox. */
export function sandboxLifetimeSec(timeoutSec: number): number {
  return timeoutSec + transferHeadroomSec(timeoutSec);
}

/**
 * Strict worst case: the most expensive instance in the chain for the whole
 * sandbox lifetime (command timeout plus transfer headroom), since Modal bills
 * the sandbox for as long as it exists.
 */
export function worstCaseReservationUsd(request: ModalJobRequest): number {
  const count = request.gpuCount ?? 1;
  const timeout = request.timeoutSec ?? 600;
  return (
    Math.max(...validateInstanceChain(request).map((spec) => hourlyEstimate(spec, count))) *
    (sandboxLifetimeSec(timeout) / 3600)
  );
}

export function publicInstanceCatalog() {
  return MODAL_INSTANCES.map((spec) => ({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    gpu: spec.gpu,
    gpuCount: 1,
    cpu: spec.cpu,
    memoryMiB: spec.memoryMiB,
    pricePerHour: spec.pricePerHour,
    defaultImage: spec.defaultImage,
    maxGpuCount: spec.maxGpuCount,
    estimatedBilling: true,
    pricing: {
      estimated: true,
      unit: MODAL_CATALOG_METADATA.unit,
      totalPerHour: spec.pricePerHour,
      multiplier: spec.kind === "gpu" ? "per GPU" : "per preset",
    },
    legacy: spec.legacy ?? false,
  }));
}

const PACKAGE_TOKEN_RE = /^[A-Za-z0-9_.+@/:<>=!~,[\]-]+$/;
const IMAGE_RE = /^[A-Za-z0-9._:@/+-]+$/;

function checkedTokens(values: unknown, field: "pip" | "apt"): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > 200) {
    throw new ModalJobError("INVALID_IMAGE", `image.${field} must be an array of at most 200 package tokens`);
  }
  return values.map((raw) => {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || value.length > 240 || !PACKAGE_TOKEN_RE.test(value)) {
      throw new ModalJobError(
        "INVALID_IMAGE",
        `Unsafe or invalid ${field} package token: ${JSON.stringify(raw)}`,
      );
    }
    return value;
  });
}

export function checkedImageBase(value: unknown): string {
  const base = typeof value === "string" ? value.trim() : "";
  if (!base || base.length > 500 || !IMAGE_RE.test(base)) {
    throw new ModalJobError("INVALID_IMAGE", "Invalid registry image name");
  }
  return base;
}

/**
 * Validate and normalize a job's image request. Runs at submission, before any
 * budget reservation or remote call, so a malformed image is a synchronous 400
 * rather than a "retryable" failed job discovered inside the sandbox loop.
 */
export function validateImageRequest(raw: unknown): ModalImageRequest | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModalJobError("INVALID_IMAGE", "image must be an object with optional base, pip and apt fields");
  }
  const value = raw as Record<string, unknown>;
  const image: ModalImageRequest = {};
  if (value.base !== undefined && value.base !== null) image.base = checkedImageBase(value.base);
  const pip = checkedTokens(value.pip, "pip");
  const apt = checkedTokens(value.apt, "apt");
  if (pip.length) image.pip = pip;
  if (apt.length) image.apt = apt;
  return Object.keys(image).length ? image : undefined;
}
