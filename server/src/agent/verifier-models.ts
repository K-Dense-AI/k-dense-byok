/**
 * Verifier model routing (Settings → Defaults → Verifier model).
 *
 * Specialists that check other agents' work (the `verifier` personas in
 * subagents.ts plus pi-subagents' builtin `reviewer` and `evidence-auditor`)
 * can run on a different model than the one that produced the work, so a
 * reviewer does not share its author's blind spots.
 *
 * The routing has to reach every way a child is launched: structured
 * `{ agent, task }` calls, workflow scripts (whose children live in source
 * text Kady cannot rewrite, and run in a detached runner) and schedule fires.
 * The only lever pi-subagents resolves per child in all of those is
 * `subagents.agentOverrides.<name>.model` in the project's `.pi/settings.json`,
 * so the app-wide default is projected into each project as those entries.
 *
 * Kady owns only the entries it wrote. The sidecar `.kady/verifier-models.json`
 * records them; an entry whose value no longer matches (the user edited or
 * removed it) is released and never touched again. pi-subagents applies an
 * override *over* agent frontmatter, so a verifier whose definition pins its
 * own model gets no entry: its own choice stays authoritative. A
 * project-level `subagents.defaultModel` is weaker than an override, so the
 * verifier model wins over it, which is the point of setting one.
 *
 * Reconciled on every session build, before every delegation (bridge
 * `tool_call` hook, so a disconnected provider or a newly pinned frontmatter
 * model takes effect before the launch), and for every project when the
 * default changes. A malformed settings file is never rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";
import { atomicJson } from "../atomic-json.ts";
import { readAppDefaults } from "../app-settings.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";
import { listAgents } from "./agent-files.ts";
import { SUBAGENT_TYPES } from "./subagents.ts";

/** pi-subagents builtins that review rather than produce. */
export const BUILTIN_VERIFIER_AGENTS = ["reviewer", "evidence-auditor"] as const;

/** Every specialist name the verifier model applies to. */
export function verifierAgentNames(): string[] {
  return [...SUBAGENT_TYPES.filter((type) => type.verifier).map((type) => type.name), ...BUILTIN_VERIFIER_AGENTS];
}

const VERIFIER_NAMES = new Set(verifierAgentNames());

export function isVerifierAgent(name: string): boolean {
  return VERIFIER_NAMES.has(name);
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function sidecarPath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "verifier-models.json");
}

/** Agent name → model ref Kady wrote. Missing or malformed reads as none. */
function readOwned(paths: ProjectPaths): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sidecarPath(paths), "utf-8"));
    const owned = isRecord(parsed) && isRecord(parsed.owned) ? parsed.owned : {};
    return Object.fromEntries(Object.entries(owned).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export interface VerifierReconcileResult {
  /** The settings file was rewritten. */
  changed: boolean;
  /** Verifiers now routed to the verifier model by Kady. */
  routed: string[];
  /** Why nothing could be applied, when that is the case. */
  skipped?: "malformed-settings" | "unavailable";
}

/**
 * Project the verifier model into one project's agent overrides.
 *
 * `verifierModel` undefined (not set) removes every entry Kady owns.
 * `isAvailable` says whether the model can run now (resolves, provider
 * connected); an unavailable model is treated like an unset one, so verifiers
 * fall back to their usual model instead of failing at launch.
 *
 * A project without a settings file has never had a session built; it is
 * left untouched (its first session build reconciles it) unless
 * `createSettings` asks for the file, as listing its specialists does.
 */
export function reconcileVerifierModels(
  paths: ProjectPaths,
  verifierModel: string | undefined,
  isAvailable: (ref: string) => boolean = () => true,
  { createSettings = false }: { createSettings?: boolean } = {},
): VerifierReconcileResult {
  let settings: Rec;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8"));
    if (!isRecord(parsed)) return { changed: false, routed: [], skipped: "malformed-settings" };
    settings = parsed;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return { changed: false, routed: [], skipped: "malformed-settings" };
    if (!createSettings) return { changed: false, routed: [] };
    settings = {};
  }
  const subagents = isRecord(settings.subagents) ? { ...settings.subagents } : {};
  if (subagents.agentOverrides !== undefined && !isRecord(subagents.agentOverrides)) {
    return { changed: false, routed: [], skipped: "malformed-settings" };
  }
  const overrides: Rec = { ...((subagents.agentOverrides as Rec | undefined) ?? {}) };
  const owned = readOwned(paths);
  const nextOwned: Record<string, string> = {};
  const available = Boolean(verifierModel) && isAvailable(verifierModel!);
  const desired = available ? verifierModel : undefined;
  const agents = new Map(listAgents(paths).map((agent) => [agent.name, agent] as const));
  let changed = false;

  for (const name of new Set([...verifierAgentNames(), ...Object.keys(owned)])) {
    const entry = overrides[name];
    if (entry !== undefined && !isRecord(entry)) continue; // malformed user entry
    const current = isRecord(entry) ? entry.model : undefined;
    const ownedValue = owned[name];
    // Released: the user changed or removed what Kady wrote.
    if (ownedValue !== undefined && current !== ownedValue) continue;
    const isOwned = ownedValue !== undefined;
    // The user's own override (a model, or `false` to clear one) wins.
    if (!isOwned && current !== undefined) continue;
    const want = desired && isVerifierAgent(name) && agents.has(name) && !agents.get(name)!.model ? desired : undefined;
    if (want) {
      nextOwned[name] = want;
      if (current !== want) {
        overrides[name] = { ...(entry ?? {}), model: want };
        changed = true;
      }
    } else if (isOwned) {
      const { model: _model, ...rest } = entry ?? {};
      if (Object.keys(rest).length > 0) overrides[name] = rest;
      else delete overrides[name];
      changed = true;
    }
  }

  const ownedChanged = JSON.stringify(Object.entries(owned).sort()) !== JSON.stringify(Object.entries(nextOwned).sort());
  if (changed) {
    if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides;
    else delete subagents.agentOverrides;
    const next: Rec = { ...settings, subagents };
    // Removing the last entry Kady wrote must not leave an empty block behind.
    if (Object.keys(subagents).length === 0) delete next.subagents;
    writePiSettings(paths, next);
  }
  if (ownedChanged) {
    if (Object.keys(nextOwned).length > 0) atomicJson(sidecarPath(paths), { version: 1, owned: nextOwned });
    else fs.rmSync(sidecarPath(paths), { force: true });
  }
  return {
    changed,
    routed: Object.keys(nextOwned).sort(),
    ...(verifierModel && !available ? { skipped: "unavailable" as const } : {}),
  };
}

/** The verifiers Kady currently routes in this project, and their model. */
export function routedVerifiers(paths: ProjectPaths): { model: string; agents: string[] } | null {
  const owned = readOwned(paths);
  const agents = Object.keys(owned).sort();
  const models = new Set(Object.values(owned));
  return agents.length > 0 && models.size === 1 ? { model: [...models][0], agents } : null;
}

/** Reconcile one project against the saved app default. Never throws. */
export function applyVerifierDefault(
  paths: ProjectPaths,
  isAvailable: (ref: string) => boolean,
  options?: { createSettings?: boolean },
): VerifierReconcileResult | null {
  try {
    return reconcileVerifierModels(paths, readAppDefaults().verifierModel, isAvailable, options);
  } catch (error) {
    // Routing is an optimization of who checks the work; a failure here must
    // never block a session build or a delegation.
    console.warn(`[verifier-models] ${paths.sandbox}: ${(error as Error).message}`);
    return null;
  }
}
