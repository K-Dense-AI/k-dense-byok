/**
 * Server-side Modal compute instance catalog — the authoritative table the
 * `modal_run` tool reads to map a user-facing instance id (e.g. "h100") onto
 * concrete Modal Sandbox resources (GPU string, CPU cores, memory) and the
 * hourly rate used to meter compute cost.
 *
 * This MUST stay in sync with the display catalog the UI shows the user
 * (web/src/data/modal-instances.json). The two are kept separate because the
 * server table additionally carries execution details (cpu/memory/defaultImage)
 * and is the single source of truth for billing; the web JSON is display-only.
 * GPU strings are the values Modal's SDK accepts (see SandboxCreateParams.gpu).
 */

export interface ModalInstanceSpec {
  id: string;
  label: string;
  /** Modal GPU string (SandboxCreateParams.gpu), or null for CPU-only. */
  gpu: string | null;
  /** Reserved physical CPU cores. */
  cpu: number;
  /** Reserved memory in MiB. */
  memoryMiB: number;
  /** Hourly rate (USD) used to estimate compute cost from wall-time. */
  pricePerHour: number;
  /** Default base registry image when the caller doesn't specify one. */
  defaultImage: string;
}

/** Universal default base image — slim Python; torch/etc. bring their own CUDA
 *  runtime, and Modal attaches GPU drivers regardless of the base image. */
const DEFAULT_IMAGE = "python:3.13-slim";

export const MODAL_INSTANCES: ModalInstanceSpec[] = [
  { id: "cpu", label: "CPU", gpu: null, cpu: 1, memoryMiB: 2048, pricePerHour: 0.05, defaultImage: DEFAULT_IMAGE },
  { id: "t4", label: "T4", gpu: "T4", cpu: 2, memoryMiB: 8192, pricePerHour: 0.59, defaultImage: DEFAULT_IMAGE },
  { id: "l4", label: "L4", gpu: "L4", cpu: 2, memoryMiB: 8192, pricePerHour: 0.8, defaultImage: DEFAULT_IMAGE },
  { id: "a10g", label: "A10G", gpu: "A10G", cpu: 4, memoryMiB: 16384, pricePerHour: 1.1, defaultImage: DEFAULT_IMAGE },
  { id: "a100-40gb", label: "A100 40GB", gpu: "A100-40GB", cpu: 4, memoryMiB: 32768, pricePerHour: 2.78, defaultImage: DEFAULT_IMAGE },
  { id: "a100-80gb", label: "A100 80GB", gpu: "A100-80GB", cpu: 8, memoryMiB: 65536, pricePerHour: 3.4, defaultImage: DEFAULT_IMAGE },
  { id: "h100", label: "H100", gpu: "H100", cpu: 8, memoryMiB: 65536, pricePerHour: 4.56, defaultImage: DEFAULT_IMAGE },
];

const BY_ID = new Map(MODAL_INSTANCES.map((i) => [i.id, i]));

/** Valid instance ids, for error messages and schema hints. */
export const MODAL_INSTANCE_IDS = MODAL_INSTANCES.map((i) => i.id);

/** Default instance when the session/caller hasn't picked one. */
export const DEFAULT_INSTANCE_ID = "cpu";

/** Look up an instance spec by id; returns null for unknown ids ("local" included). */
export function resolveInstance(id: string | null | undefined): ModalInstanceSpec | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}
