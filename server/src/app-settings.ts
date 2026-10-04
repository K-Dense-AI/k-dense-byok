/**
 * App-wide defaults for new chats: `<agentDir>/kady-settings.json`.
 *
 * Global across projects and Kady-owned (Pi never reads this file), edited
 * from Settings. It holds the model a new chat starts on, its thinking level,
 * the compute target its Modal selector starts on, the image model
 * `generate_image` uses, and the model verifier specialists run on. The chat
 * model is consumed server-side (`configuredDefaultRef` in agent/models.ts,
 * which puts it ahead of DEFAULT_MODEL_PROVIDER / DEFAULT_MODEL_ID), and so
 * are the image model (agent/image-tool.ts, read on every call) and the
 * verifier model (agent/verifier-models.ts, projected into each project's
 * agent overrides); the rest seeds a new tab in the web UI.
 *
 * Same read/validate/write trio as compaction-settings.ts: a missing or
 * malformed file reads as no defaults, a malformed one is never rewritten
 * (write → null, route → 409), and unknown top-level keys survive a write.
 */
import fs from "node:fs";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { atomicJson } from "./atomic-json.ts";
import { KADY_PI_AGENT_DIR } from "./config.ts";
import { THINKING_LEVELS, parseThinkingLevel } from "./agent/thinking.ts";

export const APP_SETTINGS_VERSION = 1;
const MAX_MODEL_REF_LENGTH = 300;
const MAX_COMPUTE_ID_LENGTH = 100;
const MAX_GPU_FALLBACK = 8;
export const COMPUTE_CACHE_MODES = ["project", "none"] as const;

export interface ComputeDefaults {
  /** `"local"` or a Modal instance id (modal/catalog.ts). */
  target: string;
  gpuCount?: number;
  gpuFallback?: string[];
  cache?: (typeof COMPUTE_CACHE_MODES)[number];
}

export interface AppDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  compute?: ComputeDefaults;
  /** `generate_image`'s model, a `<provider>/<image-model-id>` ref. */
  imageModel?: string;
  /** Model the verifier specialists run on (agent/verifier-models.ts). */
  verifierModel?: string;
}

/** A present key set to `null` clears it; an absent key is left unchanged. `compute` is replaced whole. */
export type AppDefaultsPatch = { [K in keyof AppDefaults]?: AppDefaults[K] | null };

const DEFAULT_KEYS = new Set<string>(["model", "thinkingLevel", "compute", "imageModel", "verifierModel"]);
const COMPUTE_KEYS = new Set<string>(["target", "gpuCount", "gpuFallback", "cache"]);

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const asRecord = (v: unknown): Rec => (isRecord(v) ? v : {});

export function appSettingsPath(agentDir = KADY_PI_AGENT_DIR): string {
  return path.join(agentDir, "kady-settings.json");
}

/**
 * Why `value` cannot be stored as a default model ref, or null. Canonical refs
 * are `<provider>/<model-id>` (see agent/models.ts). A `fusion/<preset>` ref is
 * refused because it only resolves together with the panel configuration the
 * browser sends on each run; the server could never start a chat on it.
 */
export function invalidModelRef(value: unknown, field = "model"): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} must be a non-empty model ref`;
  const ref = value.trim();
  if (ref.length > MAX_MODEL_REF_LENGTH) return `${field} must be at most ${MAX_MODEL_REF_LENGTH} characters`;
  if (!/^[^/\s]+\/\S+$/.test(ref)) return `${field} must look like <provider>/<model-id>, with no spaces`;
  if (ref.startsWith("fusion/")) return `${field} cannot be a Fusion preset`;
  return null;
}

function invalidComputeId(value: unknown, field: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} must be a non-empty string`;
  if (value.trim().length > MAX_COMPUTE_ID_LENGTH) return `${field} must be at most ${MAX_COMPUTE_ID_LENGTH} characters`;
  return null;
}

/**
 * Validate a compute default. Optional fields may be `null` (the same as
 * omitting them), since the object replaces the stored one whole.
 */
function invalidCompute(value: unknown): string | null {
  if (!isRecord(value)) return "compute must be an object, or null to clear it";
  for (const key of Object.keys(value)) {
    if (!COMPUTE_KEYS.has(key)) return `Unknown compute setting "${key}" (expected ${[...COMPUTE_KEYS].join(", ")})`;
  }
  const targetError = invalidComputeId(value.target, "compute.target");
  if (targetError) return targetError;
  const { gpuCount, gpuFallback, cache } = value;
  if (gpuCount != null && (!Number.isInteger(gpuCount) || (gpuCount as number) < 1 || (gpuCount as number) > 8)) {
    return "compute.gpuCount must be an integer between 1 and 8";
  }
  if (gpuFallback != null) {
    if (!Array.isArray(gpuFallback) || gpuFallback.length > MAX_GPU_FALLBACK) {
      return `compute.gpuFallback must be an array of at most ${MAX_GPU_FALLBACK} instance ids`;
    }
    for (const entry of gpuFallback) {
      const error = invalidComputeId(entry, "compute.gpuFallback entries");
      if (error) return error;
    }
  }
  if (cache != null && !COMPUTE_CACHE_MODES.includes(cache as never)) {
    return `compute.cache must be one of: ${COMPUTE_CACHE_MODES.join(", ")}`;
  }
  return null;
}

/** Validate a PUT /settings/defaults body; returns an error message or null. */
export function validateAppDefaultsPatch(patch: unknown): string | null {
  if (!isRecord(patch)) return "Body must be a JSON object";
  for (const key of Object.keys(patch)) {
    if (!DEFAULT_KEYS.has(key)) return `Unknown setting "${key}" (expected ${[...DEFAULT_KEYS].join(", ")})`;
  }
  if (patch.model != null) {
    const error = invalidModelRef(patch.model);
    if (error) return error;
  }
  if (patch.thinkingLevel != null && !parseThinkingLevel(patch.thinkingLevel)) {
    return `thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}, or null to clear it`;
  }
  if (patch.imageModel != null) {
    const error = invalidModelRef(patch.imageModel, "imageModel");
    if (error) return error;
  }
  if (patch.verifierModel != null) {
    const error = invalidModelRef(patch.verifierModel, "verifierModel");
    if (error) return error;
  }
  if (patch.compute != null) return invalidCompute(patch.compute);
  return null;
}

function normalizeCompute(value: Rec): ComputeDefaults {
  const gpuFallback = Array.isArray(value.gpuFallback)
    ? (value.gpuFallback as string[]).map((entry) => entry.trim())
    : undefined;
  return {
    target: (value.target as string).trim(),
    ...(typeof value.gpuCount === "number" ? { gpuCount: value.gpuCount } : {}),
    ...(gpuFallback ? { gpuFallback } : {}),
    ...(typeof value.cache === "string" ? { cache: value.cache as ComputeDefaults["cache"] } : {}),
  };
}

/**
 * The saved defaults. Missing or malformed file → `{}`; each field is
 * re-validated so a hand edit cannot hand the server an unusable value.
 */
export function readAppDefaults(agentDir = KADY_PI_AGENT_DIR): AppDefaults {
  const defaults = asRecord(loadForWrite(agentDir)?.defaults);
  const out: AppDefaults = {};
  if (!invalidModelRef(defaults.model)) out.model = (defaults.model as string).trim();
  const thinkingLevel = parseThinkingLevel(defaults.thinkingLevel);
  if (thinkingLevel) out.thinkingLevel = thinkingLevel;
  if (isRecord(defaults.compute) && !invalidCompute(defaults.compute)) {
    out.compute = normalizeCompute(defaults.compute);
  }
  if (!invalidModelRef(defaults.imageModel, "imageModel")) out.imageModel = (defaults.imageModel as string).trim();
  if (!invalidModelRef(defaults.verifierModel, "verifierModel")) out.verifierModel = (defaults.verifierModel as string).trim();
  return out;
}

/** Parse the file for writing. Missing → `{}`; malformed → null. */
function loadForWrite(agentDir: string): Rec | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(appSettingsPath(agentDir), "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

/**
 * Apply a validated patch. Other top-level keys (and keys under `defaults`
 * this version does not model) are preserved. Returns the resulting
 * defaults, or null when the existing file is malformed (left untouched —
 * the caller reports 409).
 */
export function writeAppDefaults(patch: AppDefaultsPatch, agentDir = KADY_PI_AGENT_DIR): AppDefaults | null {
  const file = loadForWrite(agentDir);
  if (file === null) return null;
  const defaults = { ...asRecord(file.defaults) };
  if (patch.model !== undefined) {
    if (patch.model === null) delete defaults.model;
    else defaults.model = patch.model.trim();
  }
  if (patch.thinkingLevel !== undefined) {
    if (patch.thinkingLevel === null) delete defaults.thinkingLevel;
    else defaults.thinkingLevel = patch.thinkingLevel;
  }
  if (patch.compute !== undefined) {
    if (patch.compute === null) delete defaults.compute;
    else defaults.compute = normalizeCompute(patch.compute as unknown as Rec);
  }
  if (patch.imageModel !== undefined) {
    if (patch.imageModel === null) delete defaults.imageModel;
    else defaults.imageModel = patch.imageModel.trim();
  }
  if (patch.verifierModel !== undefined) {
    if (patch.verifierModel === null) delete defaults.verifierModel;
    else defaults.verifierModel = patch.verifierModel.trim();
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  atomicJson(appSettingsPath(agentDir), { ...file, version: APP_SETTINGS_VERSION, defaults });
  return readAppDefaults(agentDir);
}
