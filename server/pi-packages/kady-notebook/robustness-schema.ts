import { Type } from "typebox";
/** Proposal only; approval and execution metadata are intentionally absent. */
export const RobustnessDraftSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  script: Type.String({ minLength: 1, maxLength: 1000, description: "Existing UTF-8 Python script. Accept --spec JSON_PATH and --output RESULT_PATH. Read metric/unit/seed/parameters from spec, honor the seed in all libraries, write schemaVersion=1, metric, unit, estimate, qc and optional interval {low,high,level}, sampleSize, notes. Never fabricate a result." }),
  inputs: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 32, description: "Explicit visible files, including every frozen-plan dataset and imported helper/config file. No directories/globs or credentials." }),
  metric: Type.String({ minLength: 1, maxLength: 200 }),
  unit: Type.String({ minLength: 1, maxLength: 100 }),
  nullValue: Type.Number(),
  instance: Type.String({ description: "Modal catalogue id, e.g. cpu-2. One GPU at most; no automatic fallback." }),
  timeoutSec: Type.Integer({ minimum: 1, maximum: 3600 }),
  packages: Type.Array(Type.String({ description: "Exact PyPI package==version pin" }), { maxItems: 32 }),
  specifications: Type.Array(Type.Object({
    key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    rationale: Type.String({ minLength: 1, maxLength: 2000 }),
    seed: Type.Integer({ minimum: 0, maximum: 2147483647 }),
    parametersJson: Type.String({ minLength: 2, maxLength: 8000, description: "JSON object of parameter values; defensible alternatives only, not a significance search" }),
  }), { minItems: 2, maxItems: 16 }),
}, { description: "DRAFT robustness workflow on a hypothesis. User must freeze a plan, review exact script/input snapshots/specifications and explicitly approve remote upload and worst-case estimated cost. This tool does not launch jobs." });
