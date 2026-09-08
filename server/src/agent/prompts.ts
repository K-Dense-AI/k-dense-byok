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
 * A handful of scientific templates are seeded into each project once (marker
 * file, so deletions stick); `restoreDefaultPromptTemplates` puts them back.
 */
import fs from "node:fs";
import path from "node:path";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import { stripFrontmatterBlock } from "./prompt-expansion.ts";

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

1. Load it with the right reader for its format; report shape, column types and memory footprint.
2. Missing values per column (count and %), duplicated rows, constant columns, and obvious type problems (numbers stored as text, mixed date formats).
3. Numeric columns: range, mean/median, and outliers beyond 3 MAD; flag impossible values (negative counts, percentages over 100, dates in the future).
4. Categorical columns: cardinality and the top levels; flag near-duplicate spellings.
5. If the data has a design (samples × conditions, replicates, batches), check the design is balanced and every expected sample is present.

Write the report to \`derived/qc_$1.md\` (create \`derived/\` if needed), log the key findings in the lab notebook as an observation, and end with a short list of issues that must be resolved before analysis.
`,
  },
  {
    name: "stats-check",
    content: `---
description: Audit the statistics behind a result or script
argument-hint: <file-or-result>
---

Audit the statistical reasoning in \`$1\` as a sceptical methods reviewer.

Check: the test or model matches the design and data type; independence and replication (technical vs biological replicates); multiple-testing correction where several comparisons are made; effect sizes and confidence intervals reported alongside p-values; sample sizes; assumptions (normality, variance, missingness mechanism) and whether they were checked; and whether any step depends on having looked at the outcome first.

Re-run the key computation yourself where possible and compare. Write findings to the lab notebook as a decision or observation with severity (blocker / concern / note), and propose the minimal fix for each blocker.
`,
  },
  {
    name: "figure-audit",
    content: `---
description: Check a figure against the data and code that produced it
argument-hint: <figure>
---

Audit the figure \`$1\`.

1. Find the script and data that produced it (use the provenance panel or search the sandbox); state them explicitly.
2. Re-derive the plotted numbers from the data and confirm they match the figure (axis ranges, group counts, error-bar definitions).
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

Review everything done in this project so far as if writing the Methods section for a paper.

List each analysis step with its inputs, parameters, software versions (from the environment snapshot) and outputs. Flag steps that are not reproducible from the sandbox alone: manual edits, undocumented parameters, results with no producing script, and files whose provenance is unknown or stale. Propose the specific changes (scripts, seeds, logging) that would make each flagged step reproducible.

Write the review to the lab notebook as a decision entry and offer to generate a Methods draft.
`,
  },
  {
    name: "replicate",
    content: `---
description: Re-run a script from scratch and compare its outputs with the existing ones
argument-hint: <script>
---

Replicate \`$1\` independently.

Copy any raw inputs it needs from \`user_data/\` into \`derived/replicate/\` (never modify the originals), run the script there with the same parameters, and compare every output file against the current version byte-for-byte and, for tables and figures, value-by-value with a tolerance you state. Report exact matches, numerical drift, and outright differences with the most likely cause (random seed, environment, data version).

Log the outcome in the lab notebook and link the comparison table.
`,
  },
];

function seedMarker(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "prompts-seeded");
}

/** One-time seeding into a project (marker-gated so deletions stick). */
export function seedPromptTemplates(paths: ProjectPaths): number {
  if (fs.existsSync(seedMarker(paths))) return 0;
  const dir = promptsDir(paths, "project");
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const template of SEEDED_TEMPLATES) {
    const file = path.join(dir, `${template.name}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, template.content, "utf-8");
    written++;
  }
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
