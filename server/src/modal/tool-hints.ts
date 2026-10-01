/**
 * What the model should do after a Modal tool failure, by `ModalJobError`
 * code. Shared by the lead's tools (agent/modal-tool.ts) and the child
 * package (pi-packages/kady-modal), so both tell the model the same thing.
 * Kept dependency-free: the child imports it through jiti.
 */
const HINTS: Record<string, string> = {
  NOT_CONFIGURED:
    "Modal is not connected. Tell the user it can be added under Settings → Services (Modal token id and secret), and run the work locally with bash in the meantime when that is feasible.",
  BUDGET_EXCEEDED:
    "The project spend cap does not cover this job's reservation, which scales with timeout_sec and the most expensive instance in the fallback chain. Shorten timeout_sec, choose a cheaper instance or drop the GPU fallback, or ask the user to raise the project limit.",
  INVALID_GPU_COUNT:
    "Use gpu_count only with a GPU instance and within its maximum; CPU instances take none.",
  INVALID_FALLBACK:
    "gpu_fallback takes at most 7 distinct GPU instance ids.",
  INVALID_REQUEST:
    "Fix the request arguments named in the message and retry.",
  INVALID_IMAGE:
    "image takes optional base, pip and apt fields with plain package names; omit it for the default image.",
  IMAGE_BUILD_FAILED:
    "The container image failed to build: check the package names and versions in image, or use fewer packages.",
  CAPACITY_UNAVAILABLE:
    "Modal has no capacity for this instance right now: retry later, or add a gpu_fallback instance.",
  OUTPUT_TOO_LARGE:
    "An output file is too large to collect: write a smaller summary file, or narrow files_out, then rerun.",
  TIMEOUT:
    "The job or a Modal request timed out: check the logs, then raise timeout_sec only if the work genuinely needs longer, or split it.",
  JOB_NOT_FOUND:
    "Check the job_id; it must be one returned by modal_run or modal_submit in this project.",
};

/** One-line recovery hint for a failure code, or undefined when none applies. */
export function modalFailureHint(code: string | undefined): string | undefined {
  return code ? HINTS[code] : undefined;
}
