/**
 * Prompt templates: Markdown files Pi expands from `/name args` in the chat.
 *
 * Two scopes, mirroring skills: per-project `sandbox/.pi/prompts/*.md` and
 * user-level `<KADY_PI_AGENT_DIR>/prompts/*.md` (Pi's own discovery dirs, so a
 * template also works in a standalone Pi pointed at the same agent dir).
 * Project entries win on a name clash. Discovery is non-recursive, like Pi's.
 *
 * Frontmatter: `description` (else the first non-empty body line) and
 * `argument-hint` (`<required> [optional]`). The body is the template; Kady's
 * `prompt-expansion.ts` performs the `$1`/`$ARGUMENTS` substitution.
 *
 * Scientific templates are seeded per project and unchanged historic defaults
 * upgrade by digest (marker-gated so deletions stick); `restoreDefaultPromptTemplates` puts them back.
 */
import fs from "node:fs";
import path from "node:path";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import { stripFrontmatterBlock } from "./prompt-expansion.ts";
import { upgradeSeededText } from "./seeded-text.ts";

export type PromptScope = "project" | "global";
export const PROMPT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 64 * 1024;

export interface PromptTemplateInfo {
  name: string;
  description: string;
  argumentHint?: string;
  scope: PromptScope;
  /** Same name exists in the other scope; project wins. */
  shadowed?: boolean;
  seeded?: boolean;
}

export interface PromptTemplateSource {
  name: string;
  scope: PromptScope;
  content: string;
}

export class PromptOperationFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export function promptsDir(paths: ProjectPaths, scope: PromptScope): string {
  return scope === "global" ? path.join(KADY_PI_AGENT_DIR, "prompts") : path.join(paths.sandbox, ".pi", "prompts");
}

function assertName(name: string): void {
  if (!PROMPT_NAME_RE.test(name)) throw new PromptOperationFailure(400, `Invalid template name "${name}"`);
}

/** Frontmatter as flat `key: value` lines (Pi's own parser is equally lenient here). */
export function parseTemplateFrontmatter(content: string): { description?: string; argumentHint?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const out: { description?: string; argumentHint?: string } = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (m[1] === "description") out.description = value;
    else if (m[1] === "argument-hint") out.argumentHint = value;
  }
  return out;
}

function describe(content: string): string {
  const fm = parseTemplateFrontmatter(content);
  if (fm.description) return fm.description;
  const first = stripFrontmatterBlock(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return "";
  return first.length > 60 ? `${first.slice(0, 60)}...` : first;
}

function listDir(dir: string, scope: PromptScope): Array<PromptTemplateInfo & { content: string }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<PromptTemplateInfo & { content: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!PROMPT_NAME_RE.test(name)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }
    const fm = parseTemplateFrontmatter(content);
    out.push({
      name,
      description: describe(content),
      ...(fm.argumentHint ? { argumentHint: fm.argumentHint } : {}),
      scope,
      content,
      seeded: SEEDED_TEMPLATES.some((t) => t.name === name && scope === "project"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Templates for one scope, or both merged (project wins) when scope is omitted. */
export function listPromptTemplates(paths: ProjectPaths, scope?: PromptScope): PromptTemplateInfo[] {
  if (scope) {
    const other = listDir(promptsDir(paths, scope === "global" ? "project" : "global"), scope === "global" ? "project" : "global");
    const otherNames = new Set(other.map((t) => t.name));
    return listDir(promptsDir(paths, scope), scope).map(({ content: _c, ...info }) => ({
      ...info,
      ...(otherNames.has(info.name) ? { shadowed: true } : {}),
    }));
  }
  const byName = new Map<string, PromptTemplateInfo>();
  for (const { content: _c, ...info } of listDir(promptsDir(paths, "global"), "global")) byName.set(info.name, info);
  for (const { content: _c, ...info } of listDir(promptsDir(paths, "project"), "project")) byName.set(info.name, info);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Name → body (frontmatter stripped), project winning, for expansion. */
export function expandableTemplates(paths: ProjectPaths): Array<{ name: string; content: string }> {
  const byName = new Map<string, string>();
  for (const t of listDir(promptsDir(paths, "global"), "global")) byName.set(t.name, stripFrontmatterBlock(t.content));
  for (const t of listDir(promptsDir(paths, "project"), "project")) byName.set(t.name, stripFrontmatterBlock(t.content));
  return [...byName.entries()].map(([name, content]) => ({ name, content }));
}

export function readPromptTemplate(paths: ProjectPaths, scope: PromptScope, name: string): PromptTemplateSource | null {
  assertName(name);
  const file = path.join(promptsDir(paths, scope), `${name}.md`);
  try {
    return { name, scope, content: fs.readFileSync(file, "utf-8") };
  } catch {
    return null;
  }
}

export function writePromptTemplate(paths: ProjectPaths, scope: PromptScope, name: string, content: string): void {
  assertName(name);
  if (typeof content !== "string" || !content.trim()) throw new PromptOperationFailure(400, "Template content is required");
  if (Buffer.byteLength(content, "utf-8") > MAX_TEMPLATE_BYTES) {
    throw new PromptOperationFailure(400, `Template exceeds ${MAX_TEMPLATE_BYTES / 1024} KiB`);
  }
  const dir = promptsDir(paths, scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function createPromptTemplate(
  paths: ProjectPaths,
  scope: PromptScope,
  input: { name: string; description?: string; argumentHint?: string; content?: string },
): PromptTemplateSource {
  assertName(input.name);
  const file = path.join(promptsDir(paths, scope), `${input.name}.md`);
  if (fs.existsSync(file)) throw new PromptOperationFailure(409, `A template named "${input.name}" already exists in this scope`);
  const description = (input.description ?? "").trim() || `Prompt template ${input.name}`;
  const hint = (input.argumentHint ?? "").trim();
  const body =
    (input.content ?? "").trim() ||
    `Describe what the agent should do. Use $1, $2… for positional arguments or $ARGUMENTS for all of them.`;
  const content = `---\ndescription: ${description}\n${hint ? `argument-hint: ${hint}\n` : ""}---\n\n${body}\n`;
  writePromptTemplate(paths, scope, input.name, content);
  return { name: input.name, scope, content };
}

export function deletePromptTemplate(paths: ProjectPaths, scope: PromptScope, name: string): void {
  assertName(name);
  const file = path.join(promptsDir(paths, scope), `${name}.md`);
  if (!fs.existsSync(file)) throw new PromptOperationFailure(404, `No such template: ${name}`);
  fs.rmSync(file);
}

// --- seeding -----------------------------------------------------------------

export const SEEDED_TEMPLATES: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: "qc",
    content: `---
description: Quality-control report for a dataset before any analysis
argument-hint: <file>
---

Run a quality-control pass on \`$1\` before any modelling. Do not modify the file.

1. Inspect format, schema and file size before loading. Use metadata, streaming/chunks or a reproducible bounded sample when a full scan would exceed available memory/time. Report shape, column types, estimated memory footprint and exactly which checks covered the full dataset versus a sample; do not extrapolate sample counts as exact totals.
2. Missing values per column (count and %), duplicated rows, constant columns, and obvious type problems (numbers stored as text, mixed date formats).
3. Numeric columns: range, mean/median and distribution-appropriate unusual-value checks. Use 3 MAD only when meaningful (handle zero MAD explicitly); a flagged value is not automatically erroneous. Establish units and domain constraints before calling negative values, percentages over 100 or future dates impossible. Do not remove or impute anything during QC.
4. Categorical columns: cardinality and the top levels; flag near-duplicate spellings.
5. Identify the independent sampling unit, repeated measurements, replicates, conditions and batches. Compare observed samples with a supplied manifest/design, report balance without assuming imbalance is an error, and distinguish unknown expected samples from confirmed missing ones.

Create a report under \`derived/\` using \`qc_<safe-basename>_<unique-run-id>.md\`: derive the basename from the final filename component, keep only letters, digits, underscores and hyphens, and check for collisions. Never interpolate the input path or URI directly into an output path. Record the source location without credentials or signed query strings, inspection scope and limitations. Log the key findings in the lab notebook and separate blockers from non-blocking observations.
`,
  },
  {
    name: "stats-check",
    content: `---
description: Audit the statistics behind a result or script
argument-hint: <file-or-result>
---

Audit the statistical reasoning in \`$1\` as a sceptical methods reviewer.

Establish the question/estimand, independent unit and study design first. Check only assumptions relevant to the actual model and inference: clustering/repeated measurements, technical vs biological replicates, missingness, multiplicity across the intended family, appropriate effect estimates and uncertainty, and outcome-informed choices. Do not require raw-data normality for every test or choose a method solely from an assumption-test p-value.

Re-run the key computation where inputs and safe output destinations are available; otherwise label it unverified and explain what is missing. Cite the exact evidence for each finding, distinguish confirmed errors from concerns, and record severity (blocker = invalidates the requested conclusion; concern = material limitation; note = non-blocking context). Propose the minimal fix for each blocker.
`,
  },
  {
    name: "figure-audit",
    content: `---
description: Check a figure against the data and code that produced it
argument-hint: <figure>
---

Audit the figure \`$1\`.

1. Use available read/grep/find tools to locate the producing script and data. Inspect relevant \`.kady/provenance/<sessionId>/steps.jsonl\` records and notebook citations when available; match exact paths and recorded versions. A filename match or an inferred/harvest-time edge does not prove that the current file produced this figure. State identified inputs and any uncertain or stale links.
2. When the producing data and transformations are available, re-derive the plotted numbers in a fresh output directory and compare axis ranges, group counts and error-bar definitions. Otherwise provide a visual-only audit and mark numerical correspondence unverified; do not invent values read from an image.
3. Check labels, units, legends and colour choices for accessibility; flag truncated axes or dual axes that exaggerate effects.
4. Note anything the caption claims that the data does not show.

Report as a lab-notebook observation citing the figure and its inputs, and regenerate a corrected figure only if asked.
`,
  },
  {
    name: "methods-review",
    content: `---
description: Review the methods used so far for reproducibility
---

Review the methods relevant to this chat's requested result/deliverable. Use notebook_search and relevant provenance records to identify that scope; for an explicit project-wide request, cover the project and state any bounds or omitted records. Do not rerun every historical analysis merely to review it.

List planned, attempted, completed and unverified steps separately, with evidence references. Read relevant \`.kady/provenance/<sessionId>/steps.jsonl\` records and their \`.kady/environments/<environmentId>.json\` snapshots using available file tools; preserve snapshot timing and never substitute today's environment for an unrecorded historical one. Report inputs, parameters, versions and full output paths only where supported. Flag undocumented manual edits, missing scripts and unknown/stale lineage, distinguishing inaccessible evidence from a confirmed omission. Propose specific remedies.

Write the review to the lab notebook as a decision entry and offer to generate a Methods draft.
`,
  },
  {
    name: "replicate",
    content: `---
description: Re-run a script from scratch and compare its outputs with the existing ones
argument-hint: <script>
---

Check computational reproducibility of \`$1\`. A rerun of the same data is not an independent scientific replication.

Identify the script's actual inputs from its configuration and recorded provenance. Verify access on the BYOK host: inputs may be browser uploads in \`user_data/\`, other project files, host/mounted paths, or data locations accessible through configured tools/connectors. Do not require a new upload or assume every input lives in \`user_data/\`. If a source is inaccessible, report it and ask only blocking questions before running.

Before running, inspect the script, imported helpers and configuration for output paths and side effects, including absolute paths and remote writes. Changing the working directory alone does not isolate a script. Create a fresh \`derived/replicate/<unique-run-id>/\` directory and redirect every write there using supported configuration or a documented copy of the script. If writes cannot be safely redirected, report the blocker before execution. Do not overwrite originals or previously generated results.

Capture a read-only comparison baseline before execution: copy the expected original outputs when feasible and record hashes, source paths, parameters, seeds and available environment versions. Stage only necessary inputs. Run with the same scientific parameters; disclose any unavoidable differences. Compare output inventories, byte hashes where meaningful, and semantic table values/plot source data with justified absolute/relative tolerances chosen before inspecting differences. Separate metadata/formatting differences from numerical differences. Missing/extra outputs are findings. Diagnose causes only with evidence; label untested explanations as hypotheses. Save the baseline manifest, run logs and comparison table in the new run directory.

Log the outcome in the lab notebook and link the comparison table.
`,
  },
  {
    name: "prove-verify",
    content: `---
description: Rounds of parallel investigation and adversarial verification until a result passes review or the budget runs out
argument-hint: <question or claim> [rounds N] [investigators N] [budget $N]
---

Run prove–verify rounds on this question or claim:

$ARGUMENTS

You are the orchestrator. Decide what gets worked on, brief specialists, keep the records and stop the loop. Do not do the derivations or analyses yourself, and do not form an opinion on the answer: never accept a result, call a direction promising or dead, or overrule a verifier on your own judgment. Results are accepted only by verification; a direction is dropped only for a recorded objection or a verified counterexample.

Limits: use any round, investigator or dollar limit given above. Otherwise run at most 3 rounds with at most 3 investigators per round. For a dollar limit, record \`date +%s\` before round 1 and, before each later round, total the project spend since then with \`node -e "const fs=require('fs'),t=+process.argv[1];let s=0;for(const d of fs.readdirSync('.kady/runs')){const f='.kady/runs/'+d+'/costs.jsonl';if(fs.existsSync(f))for(const l of fs.readFileSync(f,'utf8').split('\\\\n'))if(l.trim()){const r=JSON.parse(l);if(r.ts>=t)s+=r.costUsd||0}}console.log(s.toFixed(2))" <start>\`; it counts every chat in the project, so it errs high. Check it again before any retry or repair workflow, and stop before work that would likely exceed the limit. The project spend limit remains the hard stop.

Setup:
1. State the target precisely: the claim, its assumptions and scope, and what would count as established or refuted. If the question is too ambiguous to state, ask the user before spending anything.
2. Create \`derived/prove-verify/<short-slug>-<YYYYMMDD-HHMM>/\` and a \`ledger.md\` in it with three sections: Verified (results that passed verification, reusable without re-proof), Excluded (directions or claims ruled out, each with its counterexample or objection) and Attempts (per direction: round, approach, verdict, the objection it failed on).
3. When the answer depends on prior work, have literature-researcher collect the relevant definitions, known results and methods into \`literature.md\` first.

Each round is one workflow (a \`\`\`js workflow block plus \`subagent({ workflow: true })\`), awaited before the next round starts:
1. Directions: give each investigator a different direction: a specific claim, bound or estimate, a counterexample search, or (later) repairing a draft that verifiers marked "repair". Assign what to attempt, never how. Spread effort across genuinely different approaches; do not send two investigators down the same path.
2. Briefs: each investigator's brief names its direction, its draft path (\`round-<n>/draft-<k>.md\`), the ledger and literature paths, and the earlier attempts on its direction with the objections that defeated them. Pass long material by path. Write each brief separately so the investigators see different readings of the history. Have every specialist save its own draft or verdict at the path you name; do not forbid file writes to a specialist whose result must land in a file.
3. Launch the investigators in parallel (agent "investigator"; write each child's \`agent\` as a literal string).
4. Verify each draft separately with the reviewer that fits its claim (math-checker for derivations, statistical-reviewer for inference, code-reviewer or ml-auditor for computation, citation-checker or fact-checker for sourced claims, simulation-reviewer for simulations). Open each verifier's brief with "Verification gate:" and give it only the draft path and the claim, not the investigator's reasoning about why it should pass.
5. Run one comparative-reviewer over all of the round's drafts and their verdicts together, also as a verification gate.

After each round:
- A draft is accepted only when its own verifier and the comparative review both accept it.
- Update the ledger: append every attempt with its verdict and objection. Move a result to Verified only when a gate accepted it. When a verifier confirmed specific steps inside a draft it otherwise rejected, record them as candidate fragments and have one re-verified on its own, as a self-contained statement, before promoting it. Record refuted claims and verified counterexamples under Excluded.
- Look across all verdicts so far for recurring mistakes, gaps or verifier disagreements, and add a short warning about each to the next round's briefs.
- When attempts keep failing at the same step, send literature-researcher to search for that specific obstacle before the next round.
- Tell the user in two or three lines what the round tried, what passed and what the next round will do.

Stop when a result passes both gates and no remaining direction could plausibly improve it, when every direction is excluded or exhausted, or at the limits. Then:
1. If more than one result passed, pick the one whose consequential steps the verifiers checked most thoroughly, and say why.
2. Write \`report.md\` in the run folder: the precise statement, the full argument or analysis with every lemma, input and command it depends on, the verification record, and the remaining limitations, readable by someone who never saw this conversation.
3. Have a fresh verifier check \`report.md\` against the accepted draft as a verification gate, so the write-up introduces no new errors, and fix what it finds.
4. Log the outcome in the lab notebook: the verified result, the excluded directions with their counterexamples, and what remains open. If nothing passed, report the furthest verified progress and the strongest objection still standing; that is a valid outcome, not a failure to hide.
`,
  },
];

function seedMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "prompts-seeded");
}

/** Template names already offered to this project, so later additions seed once. */
function seededNamesFile(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "prompts-seeded-names.json");
}

/**
 * What a `prompts-seeded` marker without a names file stands for: the
 * templates shipped before per-name tracking. Never extend this list.
 */
const LEGACY_SEEDED_TEMPLATES: readonly string[] = ["qc", "stats-check", "figure-audit", "methods-review", "replicate"];

function readSeededNames(paths: ProjectPaths): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(seededNamesFile(paths), "utf-8"));
    if (Array.isArray(parsed)) return new Set(parsed.filter((name): name is string => typeof name === "string"));
  } catch {
    /* missing or malformed: the legacy set */
  }
  return new Set(LEGACY_SEEDED_TEMPLATES);
}

function writeSeededNames(paths: ProjectPaths, names: Iterable<string>): void {
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  fs.writeFileSync(seededNamesFile(paths), JSON.stringify([...new Set(names)].sort()) + "\n", "utf-8");
}

// Canonical SHA-256 of the previously shipped bodies, including frontmatter.
// Keep historic digests when changing defaults; never infer an edit from a name.
const PREVIOUS_TEMPLATE_DIGESTS: Record<string, string[]> = {
  qc: ["8e858d6ae8c8806e3a016f5158debaa73140cade0cac5af590f88a4a97dc633d"],
  "stats-check": ["fe0e0f0e3400f96c97ab76208757b78748aae816a8d623dd72d20ed0546de03c"],
  "figure-audit": ["043ec013badbbc1f5eac315b4b613b166a6a85fd7e1b1558cf3f20e6d1dbb112"],
  "methods-review": ["1b54e12a144a4a5b9a7628d911bd581058bc15ee8309e9862cb2e5f362932b63"],
  replicate: ["7ae7cf27e62c7841fd606522fe8c1333af1df3ee0dd4ef7c07a8079d1a945291"],
};

/**
 * Seed once (a template added to the shipped set later is offered once, by
 * name), then upgrade only unchanged shipped versions; deletions stick.
 */
export function seedPromptTemplates(paths: ProjectPaths): number {
  const seeded = fs.existsSync(seedMarker(paths));
  const offered = seeded ? readSeededNames(paths) : new Set<string>();
  const dir = promptsDir(paths, "project");
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const template of SEEDED_TEMPLATES) {
    const file = path.join(dir, `${template.name}.md`);
    if (fs.existsSync(file)) {
      if (upgradeSeededText(file, template.content, PREVIOUS_TEMPLATE_DIGESTS[template.name] ?? [])) written++;
      continue;
    }
    if (offered.has(template.name)) continue;
    fs.writeFileSync(file, template.content, "utf-8");
    written++;
  }
  const names = SEEDED_TEMPLATES.map((template) => template.name);
  if (!seeded) {
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    fs.writeFileSync(seedMarker(paths), new Date().toISOString() + "\n", "utf-8");
  }
  if (!seeded || names.some((name) => !offered.has(name))) writeSeededNames(paths, [...offered, ...names]);
  return written;
}

/** Overwrite the seeded templates with the shipped versions; user templates untouched. */
export function restoreDefaultPromptTemplates(paths: ProjectPaths): number {
  const dir = promptsDir(paths, "project");
  fs.mkdirSync(dir, { recursive: true });
  for (const template of SEEDED_TEMPLATES) {
    fs.writeFileSync(path.join(dir, `${template.name}.md`), template.content, "utf-8");
  }
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  fs.writeFileSync(seedMarker(paths), new Date().toISOString() + "\n", "utf-8");
  writeSeededNames(paths, [...readSeededNames(paths), ...SEEDED_TEMPLATES.map((template) => template.name)]);
  return SEEDED_TEMPLATES.length;
}
