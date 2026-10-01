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
];

function seedMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "prompts-seeded");
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

/** Seed once, then upgrade only unchanged shipped versions; deletions stick. */
export function seedPromptTemplates(paths: ProjectPaths): number {
  const seeded = fs.existsSync(seedMarker(paths));
  const dir = promptsDir(paths, "project");
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const template of SEEDED_TEMPLATES) {
    const file = path.join(dir, `${template.name}.md`);
    if (fs.existsSync(file)) {
      if (upgradeSeededText(file, template.content, PREVIOUS_TEMPLATE_DIGESTS[template.name] ?? [])) written++;
      continue;
    }
    if (seeded) continue;
    fs.writeFileSync(file, template.content, "utf-8");
    written++;
  }
  if (seeded) return written;
  fs.mkdirSync(paths.kadyDir, { recursive: true });
  fs.writeFileSync(seedMarker(paths), new Date().toISOString() + "\n", "utf-8");
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
  return SEEDED_TEMPLATES.length;
}
