/** IO-free robustness protocol shared by the notebook UI and backend. */
import type { PlanSource } from "./notebook-plans";
export interface RobustnessSpecification {
  key: string;
  label: string;
  rationale: string;
  seed: number;
  parametersJson: string;
}
export interface RobustnessDraft {
  title: string;
  script: string;
  inputs: string[];
  metric: string;
  unit: string;
  nullValue: number;
  instance: string;
  timeoutSec: number;
  packages: string[];
  specifications: RobustnessSpecification[];
}
export interface RobustnessFile { path: string; size: number; sha256: string }
export interface RobustnessPreview {
  version: 1;
  projectId: string;
  id: string;
  digest: string;
  source: PlanSource;
  sourceDigest: string;
  planId: string;
  planRevision: number;
  planHead: string;
  draft: RobustnessDraft;
  createdAt: number;
  expiresAt: number;
  inputFiles: RobustnessFile[];
  generatedFiles: RobustnessFile[];
  scriptSource: string;
  warnings: string[];
  totalReservationUsd: number;
  jobs: { specificationKey: string; jobId: string; command: string; filesIn: string[]; outputPath: string; reservationUsd: number }[];
}
export interface RobustnessResult {
  schemaVersion: 1;
  metric: string;
  unit: string;
  /** QC-fail outputs may omit an estimate rather than invent a number. */
  estimate?: number;
  interval?: { low: number; high: number; level: number };
  sampleSize?: number;
  qc: "pass" | "warn" | "fail";
  notes?: string;
}
export interface RobustnessAttempt {
  specification: RobustnessSpecification;
  jobId: string;
  state: string;
  error?: string;
  outputPath: string;
  result?: RobustnessResult;
  resultStatus: "pending" | "available" | "missing" | "invalid" | "unverified";
  resultReason?: string;
  estimatedCostUsd?: number;
  reconciled: boolean;
}
export interface RobustnessWorkflow {
  preview: RobustnessPreview;
  approvedAt?: number;
  cancelled: boolean;
  admissionError?: string;
  attempts: RobustnessAttempt[];
}
export const ROBUSTNESS_MAX_SPECIFICATIONS = 16;
export function normalizeRobustnessDraft(input: unknown): RobustnessDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Robustness proposal must be an object");
  const raw = input as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${key} is required (at most ${max} characters)`);
    return value.trim();
  };
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 32 || raw.inputs.some((x) => typeof x !== "string" || !x.trim() || x.length > 1000)) throw new Error("inputs must contain at most 32 explicit file paths (no directories/globs)");
  if (!Array.isArray(raw.packages) || raw.packages.length > 32 || raw.packages.some((x) => typeof x !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9][A-Za-z0-9.!+_-]*$/.test(x))) throw new Error("packages must be exact name==version pins; URLs and unpinned installs are not accepted");
  if (typeof raw.nullValue !== "number" || !Number.isFinite(raw.nullValue)) throw new Error("nullValue must be a finite number");
  if (!Number.isInteger(raw.timeoutSec) || (raw.timeoutSec as number) < 1 || (raw.timeoutSec as number) > 3600) throw new Error("timeoutSec must be 1–3600 seconds per specification");
  if (!Array.isArray(raw.specifications) || raw.specifications.length < 2 || raw.specifications.length > ROBUSTNESS_MAX_SPECIFICATIONS) throw new Error("Specify 2–16 defensible analysis variations");
  const seen = new Set<string>();
  const specifications = raw.specifications.map((s): RobustnessSpecification => {
    if (!s || typeof s !== "object" || typeof s.key !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(s.key) || seen.has(s.key)) throw new Error("Specification keys must be unique lowercase identifiers (1–40 characters)");
    seen.add(s.key);
    if (typeof s.label !== "string" || !s.label.trim() || s.label.length > 200 || typeof s.rationale !== "string" || !s.rationale.trim() || s.rationale.length > 2000) throw new Error("Every variation needs a label and scientific rationale");
    if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2147483647) throw new Error("Every variation needs an integer seed between 0 and 2147483647");
    if (typeof s.parametersJson !== "string" || s.parametersJson.length > 8000) throw new Error("parametersJson must be a JSON object of at most 8,000 characters");
    let parsed: unknown;
    try { parsed = JSON.parse(s.parametersJson); } catch { throw new Error(`Invalid parameter JSON for ${s.key}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Specification parameters must be JSON objects");
    const check = (value: unknown, depth: number): void => {
      if (depth > 8) throw new Error("Specification parameters are nested too deeply");
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Specification numbers must be finite");
      if (value && typeof value === "object") for (const child of Object.values(value)) check(child, depth + 1);
    };
    check(parsed, 0);
    return { key: s.key, label: s.label.trim(), rationale: s.rationale.trim(), seed: s.seed, parametersJson: JSON.stringify(parsed) };
  });
  return { title: text("title", 200), script: text("script", 1000), inputs: [...new Set((raw.inputs as string[]).map((x) => x.trim()))], metric: text("metric", 200), unit: text("unit", 100), nullValue: raw.nullValue, instance: text("instance", 80), timeoutSec: raw.timeoutSec as number, packages: [...new Set(raw.packages as string[])], specifications };
}
export function parseRobustnessResult(input: unknown, metric: string, unit: string): RobustnessResult {
  const r = input as RobustnessResult | null;
  if (!r || r.schemaVersion !== 1 || r.metric !== metric || r.unit !== unit || !["pass", "warn", "fail"].includes(r.qc)) throw new Error("Result must provide schemaVersion=1, matching metric/unit and qc=pass|warn|fail");
  if ((r.estimate === undefined && r.qc !== "fail") || (r.estimate !== undefined && (typeof r.estimate !== "number" || !Number.isFinite(r.estimate)))) throw new Error("A finite estimate is required unless QC failed; never invent an estimate");
  if (r.interval && (!Number.isFinite(r.interval.low) || !Number.isFinite(r.interval.high) || r.interval.low > r.interval.high || !Number.isFinite(r.interval.level) || r.interval.level <= 0 || r.interval.level >= 1)) throw new Error("Invalid uncertainty interval");
  if (r.sampleSize !== undefined && (!Number.isInteger(r.sampleSize) || r.sampleSize < 1)) throw new Error("Invalid sample size");
  if (r.notes !== undefined && (typeof r.notes !== "string" || r.notes.length > 4000)) throw new Error("Result notes exceed the limit");
  return { schemaVersion: 1, metric, unit, ...(r.estimate !== undefined ? { estimate: r.estimate } : {}), qc: r.qc, ...(r.interval ? { interval: { low: r.interval.low, high: r.interval.high, level: r.interval.level } } : {}), ...(r.sampleSize !== undefined ? { sampleSize: r.sampleSize } : {}), ...(r.notes ? { notes: r.notes } : {}) };
}
/** Descriptive sensitivity summary only: no significance vote or truth probability. */
export function summarizeRobustness(attempts: RobustnessAttempt[]) {
  const eligible = attempts.filter((a) => a.state === "succeeded" && a.resultStatus === "available" && a.result?.qc === "pass" && Number.isFinite(a.result.estimate));
  const estimates = eligible.map((a) => a.result!.estimate!).sort((a, b) => a - b);
  return { total: attempts.length, eligible: eligible.length, excluded: attempts.length - eligible.length,
    min: estimates[0], max: estimates.at(-1),
    median: estimates.length ? estimates[Math.floor((estimates.length - 1) / 2)] / 2 + estimates[Math.floor(estimates.length / 2)] / 2 : undefined };
}
export function robustnessText(workflows: RobustnessWorkflow[]): string {
  return workflows.map((w) => {
    const s = summarizeRobustness(w.attempts);
    return [`### Robustness workflow: ${w.preview.draft.title}`, `Workflow ${w.preview.id} · frozen plan revision ${w.preview.planRevision} · ${w.approvedAt ? "user-approved" : "preview only"}`,
      `Maximum estimated sandbox commitment: $${w.preview.totalReservationUsd.toFixed(6)} (not an invoice cap).`,
      "Sensitivity analyses are not independent replications or probabilities of truth. All approved specifications are listed, including failures; only successful, valid QC-pass results enter the descriptive range.",
      w.admissionError ? `Admission failed: ${w.admissionError}` : "", w.cancelled ? "Cancellation requested; completed attempts remain recorded." : "",
      `Comparable results: ${s.eligible}/${s.total}; ${s.eligible ? `estimate range ${s.min} to ${s.max}, median ${s.median}` : "no eligible estimates"}. Metric: ${w.preview.draft.metric}; unit: ${w.preview.draft.unit}.`,
      ...w.attempts.map((a) => `- ${a.specification.label} (${a.specification.key}; seed ${a.specification.seed}): ${a.state}; result ${a.resultStatus}${a.result ? `; estimate ${a.result.estimate ?? "not estimated"}; QC ${a.result.qc}${a.result.interval ? `; interval [${a.result.interval.low}, ${a.result.interval.high}] at ${a.result.interval.level}` : "; interval not provided"}` : ""}. ${a.resultReason ?? a.error ?? ""} Job: ${a.jobId}. Rationale: ${a.specification.rationale}. Parameters: ${a.specification.parametersJson}`),
    ].filter(Boolean).join("\n\n");
  }).join("\n\n");
}
