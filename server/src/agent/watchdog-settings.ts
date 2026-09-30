/**
 * pi-subagents watchdog: an opt-in second model that reviews each turn's
 * edits and steers findings back into the transcript (custom message
 * `subagent_watchdog_warning`, rendered by the SystemCard).
 *
 * Its configuration lives where pi-subagents reads it — `sandbox/.pi/settings.json`
 * under `subagents.watchdog` — and is validated strictly upstream (unknown keys
 * throw at session start), so this module only ever writes the keys below and
 * preserves everything else in the file. Changes apply to new chat tabs.
 *
 * Kady always writes `lsp.enabled: false` (the TypeScript LSP pre-pass is
 * irrelevant to scientific work and would probe for a language server) and
 * seeds `sandbox/.pi/WATCHDOG.md` with scientific standing instructions the
 * reviewer reads on every pass.
 *
 * Kady's pinned host adapter meters watchdog model requests and applies the
 * same billing and admission policy as other child model work.
 */
import fs from "node:fs";
import { upgradeSeededText } from "./seeded-text.ts";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";
import { THINKING_LEVELS } from "./agent-files.ts";

export const WATCHDOG_SEVERITIES = ["concern", "blocker"] as const;
export type WatchdogSeverity = (typeof WATCHDOG_SEVERITIES)[number];

export interface WatchdogSettings {
  enabled: boolean;
  /** `provider/model` in Kady's ref format; empty = inherit the chat's model. */
  model: string;
  /** Pi thinking level for the review; empty = inherit. */
  thinking: string;
  /** Review every N tool results mid-turn; null = boundary reviews only. */
  cadenceEveryNTools: number | null;
  severityThreshold: WatchdogSeverity;
  /** Also review background specialists' own turns. */
  children: boolean;
  /** Read `sandbox/.pi/WATCHDOG.md` standing instructions. */
  watchdogMd: boolean;
  stalemateRepeats: number;
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = {
  enabled: false,
  model: "",
  thinking: "",
  cadenceEveryNTools: null,
  severityThreshold: "concern",
  children: false,
  watchdogMd: true,
  stalemateRepeats: 3,
};

type Rec = Record<string, unknown>;
const asRecord = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

function loadForWrite(paths: ProjectPaths): Rec | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8")));
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

export function readWatchdogSettings(paths: ProjectPaths): WatchdogSettings {
  const settings = loadForWrite(paths) ?? {};
  const wd = asRecord(asRecord(settings.subagents).watchdog);
  const main = asRecord(wd.main);
  const cadence = asRecord(wd.cadence);
  const children = asRecord(wd.children);
  const guidance = asRecord(wd.guidance);
  const everyN = cadence.everyNTools;
  return {
    enabled: wd.enabled === true,
    model: typeof main.model === "string" ? main.model : "",
    thinking: typeof main.thinking === "string" ? main.thinking : "",
    cadenceEveryNTools: typeof everyN === "number" && Number.isInteger(everyN) && everyN >= 5 ? everyN : null,
    severityThreshold: wd.severityThreshold === "blocker" ? "blocker" : "concern",
    children: children.enabled === true,
    watchdogMd: guidance.watchdogMd !== false,
    stalemateRepeats:
      typeof wd.stalemateRepeats === "number" && Number.isInteger(wd.stalemateRepeats) && wd.stalemateRepeats >= 1
        ? wd.stalemateRepeats
        : DEFAULT_WATCHDOG_SETTINGS.stalemateRepeats,
  };
}

export type WatchdogPatch = Partial<WatchdogSettings>;

/** Returns an error message or null. Model refs are checked by the caller. */
export function validateWatchdogPatch(patch: unknown): string | null {
  const body = asRecord(patch);
  if ("enabled" in body && typeof body.enabled !== "boolean") return "enabled must be a boolean";
  if ("children" in body && typeof body.children !== "boolean") return "children must be a boolean";
  if ("watchdogMd" in body && typeof body.watchdogMd !== "boolean") return "watchdogMd must be a boolean";
  if ("model" in body && typeof body.model !== "string") return "model must be a string";
  if ("thinking" in body) {
    const t = body.thinking;
    if (typeof t !== "string" || (t !== "" && !THINKING_LEVELS.includes(t as never))) {
      return `thinking must be empty or one of: ${THINKING_LEVELS.join(", ")}`;
    }
  }
  if ("cadenceEveryNTools" in body) {
    const n = body.cadenceEveryNTools;
    if (n !== null && (!Number.isInteger(n) || (n as number) < 5 || (n as number) > 500)) {
      return "cadenceEveryNTools must be null or an integer between 5 and 500";
    }
  }
  if ("severityThreshold" in body && !WATCHDOG_SEVERITIES.includes(body.severityThreshold as WatchdogSeverity)) {
    return `severityThreshold must be one of: ${WATCHDOG_SEVERITIES.join(", ")}`;
  }
  if ("stalemateRepeats" in body) {
    const n = body.stalemateRepeats;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 20) return "stalemateRepeats must be an integer between 1 and 20";
  }
  return null;
}

/**
 * Merge a validated patch into `subagents.watchdog`, rewriting only the keys
 * Kady owns. Returns null when the settings file is malformed (left untouched).
 */
export function writeWatchdogSettings(paths: ProjectPaths, patch: WatchdogPatch): WatchdogSettings | null {
  const settings = loadForWrite(paths);
  if (settings === null) return null;
  const next = { ...readWatchdogSettings(paths), ...patch };
  const subagents = { ...asRecord(settings.subagents) };
  const wd = { ...asRecord(subagents.watchdog) };
  const main = { ...asRecord(wd.main) };
  const children = { ...asRecord(wd.children) };
  const guidance = { ...asRecord(wd.guidance) };
  const lsp = { ...asRecord(wd.lsp) };

  wd.enabled = next.enabled;
  wd.severityThreshold = next.severityThreshold;
  wd.stalemateRepeats = next.stalemateRepeats;
  if (next.cadenceEveryNTools === null) delete wd.cadence;
  else wd.cadence = { ...asRecord(wd.cadence), everyNTools: next.cadenceEveryNTools };
  if (next.model) main.model = next.model;
  else delete main.model;
  if (next.thinking) main.thinking = next.thinking;
  else delete main.thinking;
  if (Object.keys(main).length > 0) wd.main = main;
  else delete wd.main;
  children.enabled = next.children;
  wd.children = children;
  guidance.watchdogMd = next.watchdogMd;
  wd.guidance = guidance;
  // The TypeScript LSP pre-pass is for code repos; never probe for it here.
  lsp.enabled = false;
  wd.lsp = lsp;

  subagents.watchdog = wd;
  writePiSettings(paths, { ...settings, subagents });
  return readWatchdogSettings(paths);
}

// --- WATCHDOG.md ----------------------------------------------------------------

export const WATCHDOG_MD = `# Watchdog instructions

You review what the agent just did in a scientific analysis sandbox. Say
nothing when the turn is clean. You receive a bounded turn delta, not the full
history. Absence from that delta is not proof that a check or notebook entry
never happened. For a concrete concern, use available read/search tools to
inspect the relevant notebook, plan, output or provenance record. If evidence
is inaccessible, label the claim unverified and identify the missing evidence;
do not report a confirmed omission. Raise only actionable, evidenced findings:

- **Raw data touched.** Any write, move or delete under \`user_data/\` (uploads
  are read-only; work happens on copies).
- **Silent data loss.** Rows or samples dropped, NAs filled or filtered without
  the count being reported and logged in the lab notebook.
- **Unlogged parameter changes.** Thresholds, seeds, filters or model choices
  changed without a notebook entry saying what changed and why.
- **Claims without evidence.** "Tests pass", "QC done", "results reproduced"
  without supporting execution/output evidence in the supplied delta or
  relevant accessible records. Authored claims and unchanged artifact hashes
  alone do not establish successful execution or scientific validity.
- **Analysis drifting from the frozen plan.** Outcome, model or exclusion rule
  differs from the frozen analysis plan without a recorded deviation.
- **Selective analysis/reporting.** Evidence of outcome-driven selection of
  favorable specifications or undisclosed outcome switching. Repeated runs,
  debugging, exploratory work and disclosed sensitivity analyses alone are
  not evidence of significance chasing. Cite the selection and omitted context.
- **Figures inconsistent with tables**, axes that materially misrepresent the
  relevant effect, or captions that overclaim. Assess the chart type, labels
  and scientific comparison; a nonzero axis baseline is not itself an error.
- **Overwritten outputs.** Results regenerated in place with no version or note
  when they underpin earlier notebook entries.

Prefer one precise finding with the exact file or command as evidence over a
list of possibilities. Do not comment on code style.
Explain the consequence for the requested result and the smallest remedy.
Respect the current scope and existing authorization; do not impose new
approvals on routine authorized work. Use blocker only for a confirmed issue
that must stop acceptance, and concern for a material limitation or unresolved
evidence gap. Do not warn merely because evidence is outside your turn delta.
`;

function watchdogMdMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "watchdog-md-seeded");
}

/** Seed once and upgrade only known unchanged guidance; edits/deletions stick. */
export function seedWatchdogGuidance(paths: ProjectPaths): boolean {
  const file = path.join(paths.sandbox, ".pi", "WATCHDOG.md");
  const upgraded = upgradeSeededText(file, WATCHDOG_MD, ["0e17a2f84d1658eaccf1f9a0fe77ceed192a664f848f69d5958c64de18d12072"]);
  if (fs.existsSync(watchdogMdMarker(paths))) return upgraded;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let written = upgraded;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, WATCHDOG_MD, "utf-8");
    written = true;
  }
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  fs.writeFileSync(watchdogMdMarker(paths), new Date().toISOString() + "\n", "utf-8");
  return written;
}
