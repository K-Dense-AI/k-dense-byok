# LaTeX Editor Power Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the built-in LaTeX editor into a power editor: async compile + SyncTeX on the server, a modular CodeMirror editor with autocomplete/outline/spellcheck/dark-mode, a scroll-preserving pdf.js pane, and AI assist (fix errors, Cmd+K edits, Ask-Kady handoff).

**Architecture:** Server logic lives in a new `server/src/latex/` module (compile, synctex, assist) with thin Fastify routes in `server/src/api/sandbox.ts`. The frontend splits `latex-editor.tsx` into `web/src/components/latex/` (shell, toolbar, outline, PDF pane, AI popover, log panel) over pure, tested helpers in `web/src/lib/latex/`. The shared `PdfViewer` gains reload-in-place + SyncTeX props.

**Tech Stack:** TypeScript, Fastify (server, run via tsx), Next.js 16 / React 19, CodeMirror 6 (`@uiw/react-codemirror`), pdfjs-dist, pi-ai `complete()`, typo-js (new dep), `@codemirror/merge` (new dep), vitest both sides.

**Spec:** `docs/superpowers/specs/2026-07-05-latex-editor-power-upgrade-design.md`

## Global Constraints

- Node ≥ 22.19; server and tests run via `tsx`/vitest — never `tsc` for emit (`tsconfig.json` is noEmit).
- Server tests: `cd server && npm test`. `KADY_PROJECTS_ROOT` points at a temp dir via `vitest.config.ts`; tests call functions directly (no HTTP client).
- Web tests: `cd web && npm test` (vitest, jsdom, globals on, `@` → `src`).
- Typecheck gates: `cd server && npm run typecheck` and `cd web && npx tsc --noEmit` must stay clean.
- Only two new npm deps allowed, both in `web`: `typo-js`, `@codemirror/merge`. `@codemirror/view`, `@codemirror/lint`, `@codemirror/state`, `@codemirror/language`, `@codemirror/autocomplete` are transitive deps of `@uiw/react-codemirror` and are already imported directly elsewhere without being declared — follow that existing pattern.
- All new sandbox routes resolve paths through `safePath()` (from `../sandbox-fs.ts`) and get project scope via `activePaths()` / `currentProjectId()`.
- Existing endpoint response conventions: errors are `{ detail: string }` with an HTTP code.
- Frontend API calls go through `apiFetch()` from `@/lib/projects` (adds `X-Project-Id`).
- Do NOT change `web/package.json` version (it deliberately has none) or bump `server/package.json` version.
- Commit after every task with a conventional-commit message ending in the Claude Fable co-author trailer.

---

### Task 1: Server async compile core

**Files:**
- Create: `server/src/latex/compile.ts`
- Test: `server/test/latex-compile.test.ts`

**Interfaces:**
- Consumes: nothing project-internal (only node builtins).
- Produces (used by Task 3's route):
  - `LATEX_ENGINES: ReadonlySet<string>`
  - `detectBibTool(src: string): "bibtex" | "biber" | null`
  - `buildCompilePlan(opts: { engine: string; targetAbs: string; hasLatexmk: boolean; bibTool: "bibtex" | "biber" | null }): string[][]`
  - `compileLatex(targetAbs: string, engine: string, sandboxRoot: string): Promise<CompileOutcome>` where `CompileOutcome = { success: boolean; pdf_path: string | null; log: string; errors: string[]; synctex: boolean }`
  - Coalescing: concurrent `compileLatex` calls for the same `targetAbs` share one promise.

- [ ] **Step 1: Write the failing tests**

Create `server/test/latex-compile.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LATEX_ENGINES,
  buildCompilePlan,
  compileLatex,
  detectBibTool,
} from "../src/latex/compile.ts";

describe("detectBibTool", () => {
  it("detects biber for biblatex/addbibresource", () => {
    expect(detectBibTool("\\usepackage{biblatex}\n\\addbibresource{x.bib}")).toBe("biber");
    expect(detectBibTool("\\usepackage[backend=biber]{biblatex}")).toBe("biber");
  });
  it("detects bibtex for classic \\bibliography", () => {
    expect(detectBibTool("\\bibliography{refs}")).toBe("bibtex");
  });
  it("ignores commented-out lines and returns null otherwise", () => {
    expect(detectBibTool("% \\bibliography{refs}")).toBeNull();
    expect(detectBibTool("\\section{Hi}")).toBeNull();
  });
});

describe("buildCompilePlan", () => {
  it("uses a single latexmk invocation with synctex when available", () => {
    const plan = buildCompilePlan({
      engine: "pdflatex", targetAbs: "/s/main.tex", hasLatexmk: true, bibTool: "bibtex",
    });
    expect(plan).toEqual([
      ["latexmk", "-pdflatex", "-interaction=nonstopmode", "-cd", "-file-line-error", "-synctex=1", "/s/main.tex"],
    ]);
  });
  it("without latexmk runs engine, bib tool, then two more engine passes", () => {
    const plan = buildCompilePlan({
      engine: "xelatex", targetAbs: "/s/dir/main.tex", hasLatexmk: false, bibTool: "biber",
    });
    const engine = ["xelatex", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "main.tex"];
    expect(plan).toEqual([engine, ["biber", "main"], engine, engine]);
  });
  it("without latexmk and no bibliography runs two engine passes", () => {
    const plan = buildCompilePlan({
      engine: "pdflatex", targetAbs: "/s/main.tex", hasLatexmk: false, bibTool: null,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0][0]).toBe("pdflatex");
  });
});

describe("LATEX_ENGINES", () => {
  it("contains exactly the supported engines", () => {
    expect([...LATEX_ENGINES].sort()).toEqual(["lualatex", "pdflatex", "xelatex"]);
  });
});

const hasPdflatex = spawnSync("which", ["pdflatex"]).status === 0;

describe.skipIf(!hasPdflatex)("compileLatex (integration, real TeX)", () => {
  function makeDoc(body: string): { dir: string; tex: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-latex-"));
    const tex = path.join(dir, "main.tex");
    fs.writeFileSync(tex, body);
    return { dir, tex };
  }

  it("compiles a valid doc, reports synctex, coalesces concurrent calls", async () => {
    const { dir, tex } = makeDoc(
      "\\documentclass{article}\\begin{document}Hello\\end{document}\n",
    );
    const [a, b] = await Promise.all([
      compileLatex(tex, "pdflatex", dir),
      compileLatex(tex, "pdflatex", dir),
    ]);
    expect(a.success).toBe(true);
    expect(a.pdf_path).toBe("main.pdf");
    expect(a.synctex).toBe(true);
    expect(b).toBe(a); // coalesced: same resolved object
    expect(fs.existsSync(path.join(dir, "main.pdf"))).toBe(true);
  }, 120_000);

  it("reports failure with parsed errors for a broken doc", async () => {
    const { dir, tex } = makeDoc(
      "\\documentclass{article}\\begin{document}\\badmacro\\end{document}\n",
    );
    const res = await compileLatex(tex, "pdflatex", dir);
    expect(res.success).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.log).toContain("badmacro");
  }, 120_000);

  it("returns a compiler-not-found message for a missing engine", async () => {
    const { dir, tex } = makeDoc("\\documentclass{article}\\begin{document}x\\end{document}\n");
    // Force the direct-engine path so the fake engine binary hits ENOENT.
    const res = await compileLatex(tex, "pdflatex-does-not-exist", dir, { useLatexmk: false });
    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/not found/i);
  }, 30_000);
});
```

Note: the "missing engine" test relies on `compileLatex` not validating the engine name itself (the route does that with `LATEX_ENGINES`); the `useLatexmk: false` option forces the direct-engine plan so ENOENT maps to the friendly message deterministically.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/latex-compile.test.ts`
Expected: FAIL — `Cannot find module '../src/latex/compile.ts'`

- [ ] **Step 3: Implement `server/src/latex/compile.ts`**

```ts
/**
 * Async LaTeX compilation.
 *
 * Replaces the old spawnSync flow (which blocked the event loop for up to
 * 60s per compile). Uses latexmk when available (single command, handles
 * bibtex/biber + reruns), otherwise falls back to a multi-pass plan so
 * cross-references and bibliographies still resolve. Always compiles with
 * -synctex=1 so the editor can do source<->PDF sync.
 *
 * Concurrent compile requests for the same target share one in-flight
 * promise (coalescing) so a double-fired Cmd+Enter can't stack processes.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LATEX_ENGINES: ReadonlySet<string> = new Set([
  "pdflatex",
  "xelatex",
  "lualatex",
]);

export interface CompileOutcome {
  success: boolean;
  pdf_path: string | null; // relative to sandboxRoot
  log: string;
  errors: string[];
  synctex: boolean;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_LOG_BUFFER = 16 * 1024 * 1024;
const MAX_LOG_RETURN = 8_000;

/** Which bibliography tool does this source need, if any? Ignores comments. */
export function detectBibTool(src: string): "bibtex" | "biber" | null {
  if (
    /^[^%\n]*\\addbibresource\b/m.test(src) ||
    /^[^%\n]*\\usepackage(\[[^\]]*\])?\{biblatex\}/m.test(src)
  ) {
    return "biber";
  }
  if (/^[^%\n]*\\bibliography\{/m.test(src)) return "bibtex";
  return null;
}

/** Ordered list of commands (argv arrays) to run in the target's directory. */
export function buildCompilePlan(opts: {
  engine: string;
  targetAbs: string;
  hasLatexmk: boolean;
  bibTool: "bibtex" | "biber" | null;
}): string[][] {
  if (opts.hasLatexmk) {
    return [[
      "latexmk",
      `-${opts.engine}`,
      "-interaction=nonstopmode",
      "-cd",
      "-file-line-error",
      "-synctex=1",
      opts.targetAbs,
    ]];
  }
  const base = path.basename(opts.targetAbs);
  const stem = base.replace(/\.(tex|latex)$/, "");
  const engine = [
    opts.engine,
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    base,
  ];
  const plan: string[][] = [engine];
  if (opts.bibTool) plan.push([opts.bibTool, stem], engine);
  plan.push(engine);
  return plan;
}

let latexmkAvailable: boolean | null = null;
function hasLatexmk(): boolean {
  if (latexmkAvailable === null) {
    latexmkAvailable = spawnSync("which", ["latexmk"]).status === 0;
  }
  return latexmkAvailable;
}

const inflight = new Map<string, Promise<CompileOutcome>>();

/** Compile `targetAbs` with `engine`; paths in the result are sandbox-relative. */
export function compileLatex(
  targetAbs: string,
  engine: string,
  sandboxRoot: string,
  opts?: { useLatexmk?: boolean },
): Promise<CompileOutcome> {
  const existing = inflight.get(targetAbs);
  if (existing) return existing;
  const p = doCompile(targetAbs, engine, sandboxRoot, opts).finally(() => {
    inflight.delete(targetAbs);
  });
  inflight.set(targetAbs, p);
  return p;
}

async function doCompile(
  targetAbs: string,
  engine: string,
  sandboxRoot: string,
  opts?: { useLatexmk?: boolean },
): Promise<CompileOutcome> {
  const workDir = path.dirname(targetAbs);
  const stem = path.basename(targetAbs).replace(/\.(tex|latex)$/, "");
  const pdfAbs = path.join(workDir, stem + ".pdf");
  const src = fs.readFileSync(targetAbs, "utf-8");
  const plan = buildCompilePlan({
    engine,
    targetAbs,
    hasLatexmk: opts?.useLatexmk ?? hasLatexmk(),
    bibTool: detectBibTool(src),
  });

  let log = "";
  let lastStatus = 0;
  for (const [cmd, ...args] of plan) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: workDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_LOG_BUFFER,
        encoding: "utf-8",
        killSignal: "SIGKILL",
      });
      log += `${stdout}${stderr}`;
      lastStatus = 0;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        code?: number | string;
      };
      log += `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (e.code === "ENOENT") {
        return {
          success: false,
          pdf_path: null,
          log: `LaTeX compiler not found. Install TeX Live or add ${cmd} to PATH.`,
          errors: [`${cmd} not found`],
          synctex: false,
        };
      }
      if (e.killed) {
        return {
          success: false,
          pdf_path: null,
          log: log + "\nCompilation timed out after 60 seconds.",
          errors: ["Timeout"],
          synctex: false,
        };
      }
      lastStatus = typeof e.code === "number" ? e.code : 1;
      // bibtex/biber failures shouldn't kill the run — the engine passes
      // that follow surface the real problem in the log. Engine failures
      // end the plan (later passes would only repeat the same error).
      if (cmd !== "bibtex" && cmd !== "biber") break;
    }
  }

  const errors = [...log.matchAll(/^! (.+)/gm)].map((m) => m[1]);
  const success = lastStatus === 0 && fs.existsSync(pdfAbs);
  return {
    success,
    pdf_path: fs.existsSync(pdfAbs) ? path.relative(sandboxRoot, pdfAbs) : null,
    log: log.length > MAX_LOG_RETURN ? log.slice(-MAX_LOG_RETURN) : log,
    errors,
    synctex: fs.existsSync(path.join(workDir, stem + ".synctex.gz")),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/latex-compile.test.ts`
Expected: PASS (integration block runs locally since pdflatex is installed; unit blocks always run)

- [ ] **Step 5: Typecheck and commit**

Run: `cd server && npm run typecheck`
Expected: clean

```bash
git add server/src/latex/compile.ts server/test/latex-compile.test.ts
git commit -m "feat(latex): async multi-pass compile core with coalescing + synctex"
```

---

### Task 2: Server SyncTeX module

**Files:**
- Create: `server/src/latex/synctex.ts`
- Test: `server/test/latex-synctex.test.ts`

**Interfaces:**
- Produces (used by Task 3's route and tests):
  - `SynctexBox = { page: number; h: number; v: number; W: number; H: number }` — synctex "view" box, PDF points, y measured from page top, `(h, v)` = (left, baseline/bottom).
  - `SynctexLoc = { file: string; line: number; column: number }`
  - `parseSynctexView(out: string): SynctexBox | null`
  - `parseSynctexEdit(out: string): SynctexLoc | null`
  - `synctexAvailable(): boolean` (cached `which synctex`)
  - `synctexForward(texAbs: string, line: number, col: number, pdfAbs: string): Promise<SynctexBox | null>`
  - `synctexInverse(pdfAbs: string, page: number, x: number, y: number): Promise<SynctexLoc | null>`

- [ ] **Step 1: Write the failing tests**

Create `server/test/latex-synctex.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileLatex } from "../src/latex/compile.ts";
import {
  parseSynctexEdit,
  parseSynctexView,
  synctexAvailable,
  synctexForward,
  synctexInverse,
} from "../src/latex/synctex.ts";

const VIEW_OUTPUT = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/tmp/x/main.pdf
Page:2
x:148.712997
y:194.045990
h:133.768356
v:196.535963
W:343.711975
H:8.966400
before:
offset:0
middle:
after:
SyncTeX result end
`;

const EDIT_OUTPUT = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/tmp/x/main.pdf
Input:/tmp/x/main.tex
Line:42
Column:-1
Offset:0
Context:
SyncTeX result end
`;

describe("parseSynctexView", () => {
  it("extracts the first result box", () => {
    expect(parseSynctexView(VIEW_OUTPUT)).toEqual({
      page: 2, h: 133.768356, v: 196.535963, W: 343.711975, H: 8.9664,
    });
  });
  it("returns null when there is no result", () => {
    expect(parseSynctexView("SyncTeX result begin\nSyncTeX result end\n")).toBeNull();
    expect(parseSynctexView("")).toBeNull();
  });
});

describe("parseSynctexEdit", () => {
  it("extracts input file and line", () => {
    expect(parseSynctexEdit(EDIT_OUTPUT)).toEqual({
      file: "/tmp/x/main.tex", line: 42, column: -1,
    });
  });
  it("returns null without a result", () => {
    expect(parseSynctexEdit("nope")).toBeNull();
  });
});

const canRun =
  synctexAvailable() && spawnSync("which", ["pdflatex"]).status === 0;

describe.skipIf(!canRun)("synctex CLI (integration)", () => {
  it("round-trips forward then inverse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-synctex-"));
    const tex = path.join(dir, "main.tex");
    fs.writeFileSync(
      tex,
      "\\documentclass{article}\n\\begin{document}\nHello synctex world.\n\\end{document}\n",
    );
    const compiled = await compileLatex(tex, "pdflatex", dir);
    expect(compiled.synctex).toBe(true);
    const pdf = path.join(dir, "main.pdf");

    const box = await synctexForward(tex, 3, 0, pdf);
    expect(box).not.toBeNull();
    expect(box!.page).toBe(1);
    expect(box!.W).toBeGreaterThan(0);

    const loc = await synctexInverse(pdf, box!.page, box!.h + 1, box!.v - 1);
    expect(loc).not.toBeNull();
    expect(loc!.file.endsWith("main.tex")).toBe(true);
    expect(loc!.line).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/latex-synctex.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `server/src/latex/synctex.ts`**

```ts
/**
 * SyncTeX source<->PDF mapping via the `synctex` CLI (ships with TeX Live).
 *
 * Coordinates: synctex reports PDF points (72/in) with the origin at the
 * TOP-LEFT of the page and y growing downward; `v` is the bottom of the box
 * and `h` its left edge (so the box's top is `v - H`). The frontend maps
 * these straight to CSS pixels by multiplying by its render scale.
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SynctexBox {
  page: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface SynctexLoc {
  file: string;
  line: number;
  column: number;
}

let available: boolean | null = null;
export function synctexAvailable(): boolean {
  if (available === null) {
    available = spawnSync("which", ["synctex"]).status === 0;
  }
  return available;
}

function num(re: RegExp, out: string): number | null {
  const m = re.exec(out);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseSynctexView(out: string): SynctexBox | null {
  const page = num(/^Page:(\d+)/m, out);
  const h = num(/^h:([-\d.]+)/m, out);
  const v = num(/^v:([-\d.]+)/m, out);
  const W = num(/^W:([-\d.]+)/m, out);
  const H = num(/^H:([-\d.]+)/m, out);
  if (page === null || h === null || v === null || W === null || H === null) {
    return null;
  }
  return { page, h, v, W, H };
}

export function parseSynctexEdit(out: string): SynctexLoc | null {
  const file = /^Input:(.+)$/m.exec(out)?.[1]?.trim();
  const line = num(/^Line:(-?\d+)/m, out);
  const column = num(/^Column:(-?\d+)/m, out);
  if (!file || line === null || line < 1) return null;
  return { file, line, column: column ?? -1 };
}

async function run(args: string[]): Promise<string | null> {
  if (!synctexAvailable()) return null;
  try {
    const { stdout } = await execFileAsync("synctex", args, {
      timeout: 10_000,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function synctexForward(
  texAbs: string,
  line: number,
  col: number,
  pdfAbs: string,
): Promise<SynctexBox | null> {
  const out = await run(["view", "-i", `${line}:${col}:${texAbs}`, "-o", pdfAbs]);
  return out ? parseSynctexView(out) : null;
}

export async function synctexInverse(
  pdfAbs: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexLoc | null> {
  const out = await run(["edit", "-o", `${page}:${x}:${y}:${pdfAbs}`]);
  return out ? parseSynctexEdit(out) : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/latex-synctex.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd server && npm run typecheck`

```bash
git add server/src/latex/synctex.ts server/test/latex-synctex.test.ts
git commit -m "feat(latex): synctex CLI wrapper with output parsers"
```

---

### Task 3: Rewire compile endpoint + add `/sandbox/synctex`

**Files:**
- Modify: `server/src/api/sandbox.ts` (the `--- LaTeX compile ---` block near the end, currently lines ~558-603, plus the `VALID_ENGINES` const at line ~25 and imports at the top)

**Interfaces:**
- Consumes: Task 1 `compileLatex`/`LATEX_ENGINES`, Task 2 `synctexForward`/`synctexInverse`/`synctexAvailable`.
- Produces (HTTP, consumed by web Tasks 10/14):
  - `POST /sandbox/compile-latex` body `{ path, engine? }` → `{ success, pdf_path, log, errors, synctex }` (adds `synctex: boolean` to the old shape).
  - `GET /sandbox/synctex?dir=forward&path=<tex rel>&line=<n>&col=<n>&pdf=<pdf rel>` → 200 `SynctexBox` | 404 `{ detail: "no-result" }` | 424 `{ detail: "synctex-unavailable" }`.
  - `GET /sandbox/synctex?dir=inverse&pdf=<pdf rel>&page=<n>&x=<pt>&y=<pt>` → 200 `{ file: string | null, line: number, column: number }` (file is sandbox-relative, null if outside sandbox) | same 404/424.

- [ ] **Step 1: Replace the compile endpoint and add the synctex route**

In `server/src/api/sandbox.ts`:

1. Delete the line `const VALID_ENGINES = new Set(["pdflatex", "xelatex", "lualatex"]);` (line ~25) and the `import { spawnSync } from "node:child_process";` if it becomes unused (check other uses first with grep).
2. Add imports at the top:

```ts
import { LATEX_ENGINES, compileLatex } from "../latex/compile.ts";
import { synctexAvailable, synctexForward, synctexInverse } from "../latex/synctex.ts";
```

3. Replace the whole `// --- LaTeX compile ---` block with:

```ts
  // --- LaTeX compile ---
  app.post<{ Body: { path?: string; engine?: string } }>("/sandbox/compile-latex", async (req, reply) => {
    try {
      const engine = req.body.engine || "pdflatex";
      if (!LATEX_ENGINES.has(engine)) {
        reply.code(400);
        return { detail: `Unsupported engine: ${engine}` };
      }
      const target = safePath(req.body.path || "");
      if (!fs.existsSync(target) || !/\.(tex|latex)$/.test(target)) {
        reply.code(400);
        return { detail: "Not a .tex file" };
      }
      return await compileLatex(target, engine, activePaths().sandbox);
    } catch (err) {
      return handle(reply, err);
    }
  });

  // --- SyncTeX source<->PDF mapping ---
  app.get<{
    Querystring: {
      dir?: string; path?: string; pdf?: string;
      line?: string; col?: string; page?: string; x?: string; y?: string;
    };
  }>("/sandbox/synctex", async (req, reply) => {
    try {
      if (!synctexAvailable()) {
        reply.code(424);
        return { detail: "synctex-unavailable" };
      }
      const q = req.query;
      const pdfAbs = safePath(q.pdf || "");
      if (!fs.existsSync(pdfAbs)) {
        reply.code(404);
        return { detail: "no-result" };
      }
      if (q.dir === "forward") {
        const texAbs = safePath(q.path || "");
        const line = parseInt(q.line || "", 10);
        const col = parseInt(q.col || "0", 10) || 0;
        if (!fs.existsSync(texAbs) || !Number.isFinite(line)) {
          reply.code(400);
          return { detail: "Bad forward-sync request" };
        }
        const box = await synctexForward(texAbs, line, col, pdfAbs);
        if (!box) {
          reply.code(404);
          return { detail: "no-result" };
        }
        return box;
      }
      if (q.dir === "inverse") {
        const page = parseInt(q.page || "", 10);
        const x = parseFloat(q.x || "");
        const y = parseFloat(q.y || "");
        if (![page, x, y].every(Number.isFinite)) {
          reply.code(400);
          return { detail: "Bad inverse-sync request" };
        }
        const loc = await synctexInverse(pdfAbs, page, x, y);
        if (!loc) {
          reply.code(404);
          return { detail: "no-result" };
        }
        const root = activePaths().sandbox;
        const rel = path.relative(root, path.resolve(loc.file));
        return {
          file: rel.startsWith("..") ? null : rel,
          line: loc.line,
          column: loc.column,
        };
      }
      reply.code(400);
      return { detail: "dir must be forward or inverse" };
    } catch (err) {
      return handle(reply, err);
    }
  });
```

- [ ] **Step 2: Verify no stale references and typecheck**

Run: `cd server && grep -n "VALID_ENGINES\|spawnSync" src/api/sandbox.ts`
Expected: no `VALID_ENGINES` hits; `spawnSync` only if still used elsewhere in the file (if unused, the import was removed).

Run: `cd server && npm run typecheck && npm test`
Expected: clean, all tests pass

- [ ] **Step 3: Manual smoke test**

Start the backend (`cd server && npm run dev`) and, in a project sandbox containing a `main.tex`, run:

```bash
curl -s -X POST http://localhost:8000/sandbox/compile-latex -H 'Content-Type: application/json' -H 'X-Project-Id: default' -d '{"path":"main.tex"}' | head -c 400
curl -s "http://localhost:8000/sandbox/synctex?dir=forward&path=main.tex&line=3&col=0&pdf=main.pdf" -H 'X-Project-Id: default'
```

Expected: first returns `"success":true,...,"synctex":true`; second returns a `{page,h,v,W,H}` box. (Create a trivial main.tex in `projects/default/sandbox/` first if none exists.)

- [ ] **Step 4: Commit**

```bash
git add server/src/api/sandbox.ts
git commit -m "feat(latex): async compile endpoint + /sandbox/synctex route"
```

---

### Task 4: `latex-assist` module + endpoint

**Files:**
- Create: `server/src/latex/assist.ts`
- Modify: `server/src/api/sandbox.ts` (add route)
- Test: `server/test/latex-assist.test.ts`

**Interfaces:**
- Consumes: `resolveModel`/`getModelRegistry` (`../agent/models.ts`, `../agent/session-registry.ts`), `complete` from `@earendil-works/pi-ai`, ledger (`recordRun`, `emptySnapshot`, `isBudgetExceeded`).
- Produces:
  - `AssistRequest = { mode: "fix" | "edit"; fileName: string; preamble?: string; error?: { line: number; message: string }; context?: { startLine: number; endLine: number; text: string }; instruction?: string; selection?: string; model?: string }`
  - `buildAssistContext(req: AssistRequest): Context`
  - `extractReplacement(text: string): string | null` — first fenced code block, else trimmed text, null if empty.
  - `runLatexAssist(req, projectId, completeFn?): Promise<AssistResult>` where `AssistResult = { replacement: string; model: string; costUsd: number; inputTokens: number; outputTokens: number }`; throws `AssistError` with `.status` (402 budget, 422 bad request, 502 model failure).
  - HTTP: `POST /sandbox/latex-assist` → 200 `AssistResult` | 402/422/502 `{ detail, message? }`.
  - Ledger: one `recordRun` row, `sessionId: "latex-assist"`, `role: "agent"`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/latex-assist.test.ts`:

```ts
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, updateProject } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { sessionCostSummary } from "../src/cost/ledger.ts";
import {
  AssistError,
  buildAssistContext,
  extractReplacement,
  runLatexAssist,
} from "../src/latex/assist.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function fakeMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: {
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

describe("extractReplacement", () => {
  it("prefers the first fenced block", () => {
    expect(
      extractReplacement("Here you go:\n```latex\n\\textbf{fixed}\n```\ntrailing"),
    ).toBe("\\textbf{fixed}");
  });
  it("falls back to trimmed plain text", () => {
    expect(extractReplacement("  \\alpha + \\beta  ")).toBe("\\alpha + \\beta");
  });
  it("returns null for empty output", () => {
    expect(extractReplacement("   ")).toBeNull();
  });
});

describe("buildAssistContext", () => {
  it("builds a fix prompt containing error, snippet, and preamble", () => {
    const ctx = buildAssistContext({
      mode: "fix",
      fileName: "main.tex",
      preamble: "\\usepackage{amsmath}",
      error: { line: 12, message: "Undefined control sequence." },
      context: { startLine: 10, endLine: 14, text: "a\n\\badmac\nb\nc\nd" },
    });
    expect(ctx.systemPrompt).toMatch(/single fenced/i);
    const user = ctx.messages[0];
    expect(user.role).toBe("user");
    const text = user.content as string;
    expect(text).toContain("Undefined control sequence.");
    expect(text).toContain("\\badmac");
    expect(text).toContain("amsmath");
    expect(text).toContain("line 12");
  });
  it("builds an edit prompt containing instruction and selection", () => {
    const ctx = buildAssistContext({
      mode: "edit",
      fileName: "main.tex",
      instruction: "make this a table",
      selection: "a, b, c",
    });
    const text = ctx.messages[0].content as string;
    expect(text).toContain("make this a table");
    expect(text).toContain("a, b, c");
  });
});

describe("runLatexAssist", () => {
  it("returns the replacement and ledgers cost under latex-assist", async () => {
    const p = createProject({ name: "Assist" });
    const res = await withActiveProject(p.id, () =>
      runLatexAssist(
        {
          mode: "edit", fileName: "main.tex",
          instruction: "bold it", selection: "hello",
        },
        p.id,
        async () => fakeMessage("```latex\n\\textbf{hello}\n```"),
      ),
    );
    expect(res.replacement).toBe("\\textbf{hello}");
    expect(res.costUsd).toBeCloseTo(0.003);
    const summary = withActiveProject(p.id, () =>
      sessionCostSummary("latex-assist", p.id),
    );
    expect(summary.totalUsd).toBeCloseTo(0.003);
    expect(summary.entries[0].role).toBe("agent");
  });

  it("throws 402 when the project budget is exhausted", async () => {
    const p = createProject({ name: "Broke", spendLimitUsd: 0.000001 });
    updateProject(p.id, {});
    // Seed spend past the limit
    await withActiveProject(p.id, () =>
      runLatexAssist(
        { mode: "edit", fileName: "m.tex", instruction: "x", selection: "y" },
        p.id,
        async () => fakeMessage("ok"),
      ),
    );
    await expect(
      withActiveProject(p.id, () =>
        runLatexAssist(
          { mode: "edit", fileName: "m.tex", instruction: "x", selection: "y" },
          p.id,
          async () => fakeMessage("ok"),
        ),
      ),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("throws 422 for invalid requests", async () => {
    const p = createProject({ name: "Bad" });
    await expect(
      withActiveProject(p.id, () =>
        runLatexAssist({ mode: "edit", fileName: "m.tex" }, p.id, async () =>
          fakeMessage("ok"),
        ),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("throws 502 when the model returns nothing usable", async () => {
    const p = createProject({ name: "Empty" });
    await expect(
      withActiveProject(p.id, () =>
        runLatexAssist(
          { mode: "edit", fileName: "m.tex", instruction: "x", selection: "y" },
          p.id,
          async () => fakeMessage("   "),
        ),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/latex-assist.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `server/src/latex/assist.ts`**

```ts
/**
 * One-shot AI assistance for the LaTeX editor: fix a compile error or apply
 * an instruction to a selection. Deliberately NOT a chat session — a single
 * pi-ai complete() call, budget-gated and ledgered under the synthetic
 * session id "latex-assist" so project cost summaries include it.
 */
import { complete, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModelRegistry } from "../agent/session-registry.ts";
import { resolveModel } from "../agent/models.ts";
import { emptySnapshot, isBudgetExceeded, recordRun } from "../cost/ledger.ts";

export const ASSIST_SESSION_ID = "latex-assist";
const MAX_OUTPUT_TOKENS = 4_000;

export interface AssistRequest {
  mode: "fix" | "edit";
  fileName: string;
  preamble?: string;
  error?: { line: number; message: string };
  context?: { startLine: number; endLine: number; text: string };
  instruction?: string;
  selection?: string;
  model?: string;
}

export interface AssistResult {
  replacement: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class AssistError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SYSTEM_PROMPT = [
  "You are a LaTeX editing assistant embedded in an editor.",
  "You are given a snippet from a .tex file and must return a corrected or",
  "rewritten version of EXACTLY that snippet — nothing more.",
  "Respond with the replacement inside a single fenced code block",
  "(```latex ... ```). No explanations, no line numbers, no surrounding",
  "document scaffolding unless the snippet itself contained it.",
].join(" ");

export function buildAssistContext(req: AssistRequest): Context {
  const parts: string[] = [`File: ${req.fileName}`];
  if (req.preamble?.trim()) {
    parts.push(`Document preamble (for package context):\n${req.preamble.trim()}`);
  }
  if (req.mode === "fix") {
    const { error, context } = req;
    parts.push(
      `The snippet below spans lines ${context!.startLine}-${context!.endLine}.`,
      `Compilation failed at line ${error!.line} with:\n${error!.message}`,
      `Snippet:\n${context!.text}`,
      "Return the full corrected snippet (same span).",
    );
  } else {
    parts.push(
      `Instruction: ${req.instruction}`,
      `Selected text:\n${req.selection}`,
      "Return the rewritten selection only.",
    );
  }
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n\n"), timestamp: Date.now() }],
  };
}

export function extractReplacement(text: string): string | null {
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  if (fenced) {
    // Keep the block's internal indentation; drop only trailing newlines.
    const body = fenced[1].replace(/\n+$/, "");
    return body.trim() ? body : null;
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

function validate(req: AssistRequest): void {
  if (req.mode === "fix") {
    if (!req.error || !req.context?.text) {
      throw new AssistError(422, "fix mode requires error and context");
    }
  } else if (req.mode === "edit") {
    if (!req.instruction?.trim() || req.selection === undefined) {
      throw new AssistError(422, "edit mode requires instruction and selection");
    }
  } else {
    throw new AssistError(422, "mode must be fix or edit");
  }
}

type CompleteFn = typeof complete;

export async function runLatexAssist(
  req: AssistRequest,
  projectId: string,
  completeFn: CompleteFn = complete,
): Promise<AssistResult> {
  validate(req);
  const budget = isBudgetExceeded(projectId);
  if (budget.exceeded) {
    throw new AssistError(
      402,
      `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
        `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
    );
  }
  if (req.model?.startsWith("fusion/")) {
    throw new AssistError(422, "Fusion models are not supported for editor AI assist");
  }
  const model = resolveModel(req.model, getModelRegistry());
  let msg: AssistantMessage;
  try {
    msg = await completeFn(model, buildAssistContext(req), {
      apiKey: process.env.OPENROUTER_API_KEY || process.env.OR_API_KEY,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    throw new AssistError(502, err instanceof Error ? err.message : "model call failed");
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new AssistError(502, msg.errorMessage ?? "model call failed");
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const replacement = extractReplacement(text);
  if (replacement === null) {
    throw new AssistError(502, "Model did not produce a usable replacement");
  }
  const u = msg.usage;
  recordRun({
    sessionId: ASSIST_SESSION_ID,
    projectId,
    model: msg.model,
    role: "agent",
    before: emptySnapshot(),
    after: {
      costUsd: u.cost.total,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      total: u.totalTokens,
    },
  });
  return {
    replacement,
    model: msg.model,
    costUsd: u.cost.total,
    inputTokens: u.input,
    outputTokens: u.output,
  };
}
```

Note for the budget test: `runLatexAssist` records $0.003 on the first call; the project's `spendLimitUsd` of `0.000001` is then exceeded, so the second call must throw 402. If `isBudgetExceeded` returns exceeded on the *first* call already (limit below any spend but nothing recorded yet — `totalUsd` starts at 0, so it should NOT be exceeded), the first call succeeds as intended.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/latex-assist.test.ts`
Expected: PASS. If the `timestamp: Date.now()` field on the user message trips the `Context` type, check the `UserMessage` interface in `@earendil-works/pi-ai/dist/types.d.ts` (it requires `timestamp: number`) — keep it.

- [ ] **Step 5: Add the route in `server/src/api/sandbox.ts`**

Add import:

```ts
import { AssistError, runLatexAssist, type AssistRequest } from "../latex/assist.ts";
```

Add after the synctex route (still inside `registerSandboxRoutes`):

```ts
  // --- AI assist (fix error / rewrite selection) ---
  app.post<{ Body: AssistRequest }>("/sandbox/latex-assist", async (req, reply) => {
    try {
      const projectId = currentProjectId();
      return await runLatexAssist(req.body, projectId);
    } catch (err) {
      if (err instanceof AssistError) {
        reply.code(err.status);
        return { detail: err.status === 402 ? "budget-exceeded" : "assist-failed", message: err.message };
      }
      return handle(reply, err);
    }
  });
```

Add `currentProjectId` to the existing import from `../scope.ts` — if sandbox.ts doesn't import from scope yet, add:

```ts
import { currentProjectId } from "../scope.ts";
```

- [ ] **Step 6: Typecheck, full server suite, commit**

Run: `cd server && npm run typecheck && npm test`
Expected: clean

```bash
git add server/src/latex/assist.ts server/src/api/sandbox.ts server/test/latex-assist.test.ts
git commit -m "feat(latex): budget-gated latex-assist endpoint with cost ledgering"
```

---

### Task 5: Web lib — compile diagnostics (move + warnings)

**Files:**
- Create: `web/src/lib/latex/diagnostics.ts`
- Test: `web/src/lib/latex/diagnostics.test.ts`

**Interfaces:**
- Produces (used by the editor shell in Task 10):
  - `TexDiagnostic = { line: number; message: string; severity: "error" | "warning" }`
  - `parseCompileDiagnostics(log: string, fileName: string): TexDiagnostic[]` — errors use the existing two-stage parse (file-line-error preferred, `!`/`l.N` fallback, filtered to `fileName`'s basename); warnings add undefined reference/citation and over/underfull box patterns. Capped at 100, errors first.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/latex/diagnostics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCompileDiagnostics } from "./diagnostics";

const FILE_LINE_LOG = `This is pdfTeX
./main.tex:12: Undefined control sequence.
l.12 \\badmacro
./other.tex:3: Missing $ inserted.
./main.tex:12: Undefined control sequence.
`;

const CLASSIC_LOG = `! Missing } inserted.
<inserted text>
l.42 \\end{document}
`;

const WARNING_LOG = `LaTeX Warning: Reference \`fig:one' on page 1 undefined on input line 7.

Overfull \\hbox (15.0pt too wide) in paragraph at lines 12--14

LaTeX Warning: Citation 'smith2020' on page 2 undefined on input line 33.

Underfull \\vbox (badness 10000) has occurred while \\output is active
LaTeX Warning: There were undefined references.
`;

describe("parseCompileDiagnostics", () => {
  it("parses file-line-error format, filtered to the open file, deduped", () => {
    const d = parseCompileDiagnostics(FILE_LINE_LOG, "main.tex");
    expect(d).toEqual([
      { line: 12, message: "Undefined control sequence.", severity: "error" },
    ]);
  });

  it("falls back to classic !/l.N pairing", () => {
    const d = parseCompileDiagnostics(CLASSIC_LOG, "main.tex");
    expect(d).toEqual([
      { line: 42, message: "Missing } inserted.", severity: "error" },
    ]);
  });

  it("extracts line-anchored warnings", () => {
    const d = parseCompileDiagnostics(WARNING_LOG, "main.tex");
    expect(d).toContainEqual({
      line: 7,
      message: "Reference `fig:one' undefined",
      severity: "warning",
    });
    expect(d).toContainEqual({
      line: 33,
      message: "Citation 'smith2020' undefined",
      severity: "warning",
    });
    expect(d).toContainEqual({
      line: 12,
      message: "Overfull \\hbox (15.0pt too wide)",
      severity: "warning",
    });
    // The "There were undefined references" summary has no line — not included.
    expect(d.every((x) => Number.isFinite(x.line))).toBe(true);
  });

  it("puts errors before warnings and respects the cap", () => {
    const d = parseCompileDiagnostics(FILE_LINE_LOG + WARNING_LOG, "main.tex");
    expect(d[0].severity).toBe("error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/latex/diagnostics.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `web/src/lib/latex/diagnostics.ts`**

Port `parseTexDiagnostics` from `web/src/components/latex-editor.tsx` (lines 40-84) and extend:

```ts
/**
 * Parse a LaTeX compile log into line-anchored diagnostics for the editor
 * gutter. Errors come from `-file-line-error` output (preferred; filtered to
 * the file being edited) with a classic `! message` / `l.N` fallback.
 * Warnings cover undefined references/citations and over/underfull boxes —
 * these carry no file attribution in the log, so they are attached to the
 * open file (correct for single-file docs; harmless noise otherwise).
 */
export interface TexDiagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

const MAX_DIAGNOSTICS = 100;

function parseErrors(log: string, fileName: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const seen = new Set<string>();
  const base = fileName.split("/").pop()?.toLowerCase() ?? "";

  const fileLineRe = /^(?:\.\/)?(\S+?):(\d+):\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = fileLineRe.exec(log)) !== null) {
    const file = m[1].split("/").pop()?.toLowerCase() ?? "";
    if (base && file !== base) continue;
    const line = parseInt(m[2], 10);
    const message = m[3].trim();
    if (!Number.isFinite(line) || !message) continue;
    const key = `${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, message, severity: "error" });
  }
  if (out.length > 0) return out;

  let lastErr: string | null = null;
  for (const raw of log.split("\n")) {
    const em = /^! (.+)/.exec(raw);
    if (em) {
      lastErr = em[1].trim();
      continue;
    }
    const lm = /^l\.(\d+)/.exec(raw);
    if (lm && lastErr) {
      const line = parseInt(lm[1], 10);
      const key = `${line}:${lastErr}`;
      if (Number.isFinite(line) && !seen.has(key)) {
        seen.add(key);
        out.push({ line, message: lastErr, severity: "error" });
      }
      lastErr = null;
    }
  }
  return out;
}

function parseWarnings(log: string): TexDiagnostic[] {
  const out: TexDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (line: number, message: string) => {
    const key = `${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, message, severity: "warning" });
  };

  let m: RegExpExecArray | null;
  const refRe =
    /LaTeX Warning: (Reference|Citation) ([`'][^']*') on page \d+ undefined on input line (\d+)/g;
  while ((m = refRe.exec(log)) !== null) {
    push(parseInt(m[3], 10), `${m[1]} ${m[2]} undefined`);
  }
  const boxRe = /^(Overfull|Underfull) (\\[hv]box \([^)]+\)) in paragraph at lines (\d+)--\d+/gm;
  while ((m = boxRe.exec(log)) !== null) {
    push(parseInt(m[3], 10), `${m[1]} ${m[2]}`);
  }
  const genericRe = /LaTeX Warning: (?!Reference|Citation)([^\n]+?) on input line (\d+)\./g;
  while ((m = genericRe.exec(log)) !== null) {
    push(parseInt(m[2], 10), m[1].trim());
  }
  return out;
}

export function parseCompileDiagnostics(
  log: string,
  fileName: string,
): TexDiagnostic[] {
  return [...parseErrors(log, fileName), ...parseWarnings(log)].slice(
    0,
    MAX_DIAGNOSTICS,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/latex/diagnostics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/latex/diagnostics.ts web/src/lib/latex/diagnostics.test.ts
git commit -m "feat(latex-web): compile diagnostics parser with warnings"
```

---

### Task 6: Web lib — outline, breadcrumb, prose tokenizer, word count

**Files:**
- Create: `web/src/lib/latex/outline.ts`
- Create: `web/src/lib/latex/prose.ts`
- Test: `web/src/lib/latex/outline.test.ts`, `web/src/lib/latex/prose.test.ts`

**Interfaces:**
- `outline.ts` produces:
  - `OutlineKind = "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "figure" | "table"`
  - `OutlineItem = { kind: OutlineKind; title: string; line: number; depth: number }` (line is 1-based)
  - `parseOutline(text: string): OutlineItem[]`
  - `breadcrumbFor(items: OutlineItem[], line: number): OutlineItem[]` — chain of enclosing sectioning items (not floats) at or before `line`.
- `prose.ts` produces:
  - `ProseToken = { word: string; from: number; to: number }` (offsets into the input text)
  - `extractProseTokens(text: string): ProseToken[]` — words in prose only: skips everything before `\begin{document}` (when present), comments, inline/display math, command names, and the arguments of non-prose commands (`\label`, `\ref`, `\cite*`, `\includegraphics`, `\input`, `\include`, `\bibliography`, `\bibliographystyle`, `\usepackage`, `\documentclass`, `\begin`, `\end`, `\url`, `\href` (first arg), `\pageref`, `\eqref`, `\autoref`, `\addbibresource`).
  - `proseWordCount(text: string): number`

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/latex/outline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { breadcrumbFor, parseOutline } from "./outline";

const DOC = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Some text.
\\subsection{Background}
% \\section{Commented out}
\\begin{figure}
  \\includegraphics{x.png}
  \\caption{A nice plot}
\\end{figure}
\\section*{Methods}
\\begin{table}
  \\caption{Results table}
\\end{table}
\\end{document}
`;

describe("parseOutline", () => {
  it("finds sections with correct lines and depths", () => {
    const items = parseOutline(DOC);
    expect(items).toContainEqual({ kind: "section", title: "Intro", line: 3, depth: 2 });
    expect(items).toContainEqual({ kind: "subsection", title: "Background", line: 5, depth: 3 });
    expect(items).toContainEqual({ kind: "section", title: "Methods", line: 11, depth: 2 });
  });
  it("skips commented lines", () => {
    expect(parseOutline(DOC).find((i) => i.title === "Commented out")).toBeUndefined();
  });
  it("captions name figures and tables", () => {
    const items = parseOutline(DOC);
    expect(items).toContainEqual({ kind: "figure", title: "A nice plot", line: 7, depth: 4 });
    expect(items).toContainEqual({ kind: "table", title: "Results table", line: 12, depth: 3 });
  });
});

describe("breadcrumbFor", () => {
  it("returns the enclosing section chain", () => {
    const items = parseOutline(DOC);
    const crumb = breadcrumbFor(items, 6);
    expect(crumb.map((c) => c.title)).toEqual(["Intro", "Background"]);
  });
  it("resets at a new same-level section", () => {
    const items = parseOutline(DOC);
    expect(breadcrumbFor(items, 12).map((c) => c.title)).toEqual(["Methods"]);
  });
});
```

Note on expected depths: sectioning depths are `part:0, chapter:1, section:2, subsection:3, subsubsection:4, paragraph:5`; a float's depth is the current sectioning depth + 1 (figure appears under "Background" → depth 4; the table after "Methods" → depth 3).

Create `web/src/lib/latex/prose.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractProseTokens, proseWordCount } from "./prose";

describe("extractProseTokens", () => {
  it("extracts plain words with offsets", () => {
    const t = extractProseTokens("Hello brave world");
    expect(t.map((x) => x.word)).toEqual(["Hello", "brave", "world"]);
    expect(t[1]).toEqual({ word: "brave", from: 6, to: 11 });
  });
  it("skips command names but keeps prose arguments", () => {
    const words = extractProseTokens("\\textbf{bold words} here").map((x) => x.word);
    expect(words).toEqual(["bold", "words", "here"]);
  });
  it("skips args of non-prose commands", () => {
    const words = extractProseTokens(
      "See \\ref{fig:xyz} and \\cite{smith2020} for detalis",
    ).map((x) => x.word);
    expect(words).toEqual(["See", "and", "for", "detalis"]);
  });
  it("skips math and comments", () => {
    const words = extractProseTokens(
      "Let $x + y$ be real % a comment word\nokay \\[ e = mc^2 \\] end",
    ).map((x) => x.word);
    expect(words).toEqual(["Let", "be", "real", "okay", "end"]);
  });
  it("skips the preamble when \\begin{document} exists", () => {
    const words = extractProseTokens(
      "\\documentclass{article}\npreamble noise\n\\begin{document}\nreal text\n\\end{document}",
    ).map((x) => x.word);
    expect(words).toEqual(["real", "text"]);
  });
  it("ignores single letters and words with digits", () => {
    const words = extractProseTokens("a x2 hello").map((x) => x.word);
    expect(words).toEqual(["hello"]);
  });
});

describe("proseWordCount", () => {
  it("counts prose words", () => {
    expect(proseWordCount("Hello $x$ world % nope\n\\textit{fine}")).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/latex/outline.test.ts src/lib/latex/prose.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `web/src/lib/latex/outline.ts`**

```ts
/**
 * Line-based LaTeX outline parser. Regex-per-line with a tiny float state
 * machine (figure/table pick up their \caption); good enough for real papers
 * and cheap enough to re-run on a 300ms debounce.
 */
export type OutlineKind =
  | "part" | "chapter" | "section" | "subsection" | "subsubsection"
  | "paragraph" | "figure" | "table";

export interface OutlineItem {
  kind: OutlineKind;
  title: string;
  line: number; // 1-based
  depth: number;
}

const SECTION_DEPTH: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5,
};

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/;
const FLOAT_BEGIN_RE = /\\begin\{(figure|table)\*?\}/;
const FLOAT_END_RE = /\\end\{(figure|table)\*?\}/;
const CAPTION_RE = /\\caption\s*(?:\[[^\]]*\])?\{([^}]*)\}/;

/** Strip a trailing unescaped %-comment from a line. */
function stripComment(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "%" && line[i - 1] !== "\\") break;
    out += ch;
  }
  return out;
}

export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split("\n");
  let depth = 1; // before any section
  let float: { kind: "figure" | "table"; line: number; item: OutlineItem } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;

    const sec = SECTION_RE.exec(line);
    if (sec) {
      depth = SECTION_DEPTH[sec[1]];
      items.push({ kind: sec[1] as OutlineKind, title: sec[2].trim(), line: i + 1, depth });
      continue;
    }
    const fb = FLOAT_BEGIN_RE.exec(line);
    if (fb) {
      const item: OutlineItem = {
        kind: fb[1] as "figure" | "table",
        title: fb[1] === "figure" ? "Figure" : "Table",
        line: i + 1,
        depth: depth + 1,
      };
      items.push(item);
      float = { kind: item.kind as "figure" | "table", line: i + 1, item };
      continue;
    }
    if (float) {
      const cap = CAPTION_RE.exec(line);
      if (cap) float.item.title = cap[1].trim();
      if (FLOAT_END_RE.test(line)) float = null;
    }
  }
  return items;
}

/** Enclosing sectioning chain (floats excluded) at or before `line`. */
export function breadcrumbFor(items: OutlineItem[], line: number): OutlineItem[] {
  const chain: OutlineItem[] = [];
  for (const item of items) {
    if (item.line > line) break;
    if (!(item.kind in SECTION_DEPTH)) continue;
    while (chain.length && chain[chain.length - 1].depth >= item.depth) chain.pop();
    chain.push(item);
  }
  return chain;
}
```

- [ ] **Step 4: Implement `web/src/lib/latex/prose.ts`**

```ts
/**
 * Prose tokenizer for spell checking and word count. A single-pass scanner
 * that skips: the preamble (when \begin{document} exists), %-comments,
 * inline ($...$, \( \)) and display ($$..$$, \[ \]) math, math environments,
 * command names, and arguments of commands whose args aren't prose.
 */
export interface ProseToken {
  word: string;
  from: number;
  to: number;
}

const NONPROSE_ARG_COMMANDS = new Set([
  "label", "ref", "pageref", "eqref", "autoref", "cref", "Cref", "vref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "textcite", "parencite", "autocite",
  "includegraphics", "input", "include", "bibliography", "bibliographystyle",
  "addbibresource", "usepackage", "documentclass", "begin", "end", "url",
]);

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "math", "displaymath",
]);

const WORD_RE = /^[A-Za-z][A-Za-z']+$/;

export function extractProseTokens(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  const docStart = text.indexOf("\\begin{document}");
  let i = docStart >= 0 ? docStart + "\\begin{document}".length : 0;
  let mathEnvDepth = 0;

  const flushWord = (from: number, to: number) => {
    const word = text.slice(from, to);
    if (word.length >= 2 && WORD_RE.test(word) && !/\d/.test(word)) {
      tokens.push({ word, from, to });
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "%" && text[i - 1] !== "\\") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "$") {
      const display = text[i + 1] === "$";
      i += display ? 2 : 1;
      while (i < text.length) {
        if (text[i] === "$" && text[i - 1] !== "\\") {
          i += display && text[i + 1] === "$" ? 2 : 1;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(close, i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "\\") {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      i = j;
      // \begin{env}/\end{env}: track math environments
      if (name === "begin" || name === "end") {
        const m = /^\{([a-zA-Z*]+)\}/.exec(text.slice(i));
        if (m) {
          if (MATH_ENVS.has(m[1])) {
            mathEnvDepth = Math.max(0, mathEnvDepth + (name === "begin" ? 1 : -1));
          }
          i += m[0].length;
        }
        continue;
      }
      if (NONPROSE_ARG_COMMANDS.has(name) || name === "href") {
        // Skip optional [..] then required {..} arg(s). \href skips only its
        // first {url} arg; the second (display text) is prose.
        const opt = /^\[[^\]]*\]/.exec(text.slice(i));
        if (opt) i += opt[0].length;
        const braced = /^\{[^}]*\}/.exec(text.slice(i));
        if (braced) i += braced[0].length;
      }
      continue;
    }
    if (mathEnvDepth > 0) {
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z']/.test(text[i])) i++;
      flushWord(start, i);
      continue;
    }
    i++;
  }
  return tokens;
}

export function proseWordCount(text: string): number {
  return extractProseTokens(text).length;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/latex/outline.test.ts src/lib/latex/prose.test.ts`
Expected: PASS — if the float-depth expectations mismatch, fix the test values to the implementation's documented rule (float depth = current sectioning depth + 1), not the other way around.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/latex/outline.ts web/src/lib/latex/prose.ts web/src/lib/latex/outline.test.ts web/src/lib/latex/prose.test.ts
git commit -m "feat(latex-web): outline parser, breadcrumb, prose tokenizer + word count"
```

---

### Task 7: Web lib — magic comments + autocomplete sources

**Files:**
- Create: `web/src/lib/latex/magic-comments.ts`
- Create: `web/src/lib/latex/completions.ts`
- Test: `web/src/lib/latex/magic-comments.test.ts`, `web/src/lib/latex/completions.test.ts`

**Interfaces:**
- `magic-comments.ts` produces:
  - `parseMagicComments(text: string): { root?: string; program?: string }` — scans the first 15 lines for `% !TEX root = <path>` and `% !TEX program = <engine>` (case-insensitive, `TS-program` also accepted).
  - `resolveRelative(fromPath: string, rel: string): string` — resolve `rel` against `fromPath`'s directory, POSIX-normalized, never escaping above "" (sandbox root).
- `completions.ts` produces:
  - `scanLabels(text: string): string[]` (unique, in order)
  - `scanBibFiles(text: string): string[]` — from `\bibliography{a,b}` (adds `.bib` if missing) and `\addbibresource{x.bib}`
  - `scanBibKeys(bibText: string): string[]`
  - `latexCompletionSource(opts: { getBibKeys: () => string[] }): CompletionSource` (type from `@codemirror/autocomplete`)
  - `LATEX_SNIPPETS` — snippet completions (figure, table, equation, align, itemize, enumerate, frame skeletons)

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/latex/magic-comments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMagicComments, resolveRelative } from "./magic-comments";

describe("parseMagicComments", () => {
  it("parses root and program", () => {
    const r = parseMagicComments("% !TEX root = ../main.tex\n% !TEX program = xelatex\n\\section{x}");
    expect(r).toEqual({ root: "../main.tex", program: "xelatex" });
  });
  it("is case-insensitive and accepts TS-program", () => {
    const r = parseMagicComments("%!tex ROOT = main.tex\n% !TeX TS-program = lualatex");
    expect(r).toEqual({ root: "main.tex", program: "lualatex" });
  });
  it("only scans the first 15 lines", () => {
    const pad = Array(20).fill("x").join("\n");
    expect(parseMagicComments(`${pad}\n% !TEX root = a.tex`)).toEqual({});
  });
});

describe("resolveRelative", () => {
  it("resolves against the file's directory", () => {
    expect(resolveRelative("chapters/ch1.tex", "../main.tex")).toBe("main.tex");
    expect(resolveRelative("main.tex", "refs.bib")).toBe("refs.bib");
    expect(resolveRelative("a/b/c.tex", "d.bib")).toBe("a/b/d.bib");
  });
  it("clamps escapes above the sandbox root", () => {
    expect(resolveRelative("main.tex", "../../etc/passwd")).toBe("etc/passwd");
  });
});
```

Create `web/src/lib/latex/completions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanBibFiles, scanBibKeys, scanLabels } from "./completions";

describe("scanLabels", () => {
  it("collects unique labels in order", () => {
    const text = "\\label{fig:a}\n\\label{eq:b}\n\\label{fig:a}";
    expect(scanLabels(text)).toEqual(["fig:a", "eq:b"]);
  });
});

describe("scanBibFiles", () => {
  it("handles classic \\bibliography with commas and missing extensions", () => {
    expect(scanBibFiles("\\bibliography{refs,other.bib}")).toEqual(["refs.bib", "other.bib"]);
  });
  it("handles \\addbibresource", () => {
    expect(scanBibFiles("\\addbibresource{lib.bib}")).toEqual(["lib.bib"]);
  });
});

describe("scanBibKeys", () => {
  it("extracts entry keys", () => {
    const bib = `@article{smith2020,\n title={X}\n}\n@book (jones1999,\n)\n@comment{ignored}`;
    expect(scanBibKeys(bib)).toEqual(["smith2020", "jones1999"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/latex/magic-comments.test.ts src/lib/latex/completions.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement `web/src/lib/latex/magic-comments.ts`**

```ts
/** TeXShop/latexmk-style magic comments, honored by every serious editor. */
export interface MagicComments {
  root?: string;
  program?: string;
}

const ROOT_RE = /^%\s*!\s*tex\s+root\s*=\s*(.+)$/i;
const PROGRAM_RE = /^%\s*!\s*tex\s+(?:ts-)?program\s*=\s*(\S+)/i;

export function parseMagicComments(text: string): MagicComments {
  const out: MagicComments = {};
  const lines = text.split("\n", 15);
  for (const line of lines) {
    const root = ROOT_RE.exec(line.trim());
    if (root && !out.root) out.root = root[1].trim();
    const prog = PROGRAM_RE.exec(line.trim());
    if (prog && !out.program) out.program = prog[1].trim().toLowerCase();
  }
  return out;
}

/** Resolve `rel` against fromPath's directory; sandbox-relative, clamped. */
export function resolveRelative(fromPath: string, rel: string): string {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" + rel : rel).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      stack.pop(); // pops nothing at root — clamps escapes
      continue;
    }
    stack.push(p);
  }
  return stack.join("/");
}
```

- [ ] **Step 4: Implement `web/src/lib/latex/completions.ts`**

```ts
/**
 * Autocomplete sources for LaTeX: common commands + math symbols,
 * environments (with auto-inserted \end), snippets, and context-aware
 * \ref / \cite completion backed by document + .bib scans.
 */
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";

// ---- scanners --------------------------------------------------------------

export function scanLabels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

export function scanBibFiles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\\bibliography\{([^}]+)\}/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name) out.push(name.endsWith(".bib") ? name : `${name}.bib`);
    }
  }
  for (const m of text.matchAll(/\\addbibresource\{([^}]+)\}/g)) {
    out.push(m[1].trim());
  }
  return out;
}

export function scanBibKeys(bibText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of bibText.matchAll(/^\s*@(\w+)\s*[({]\s*([^,\s()]+)\s*,/gm)) {
    if (m[1].toLowerCase() === "comment" || m[1].toLowerCase() === "string") continue;
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push(m[2]);
    }
  }
  return out;
}

// ---- static data -----------------------------------------------------------

const cmd = (label: string, detail?: string): Completion => ({
  label, type: "keyword", detail,
});
const sym = (label: string, detail: string): Completion => ({
  label, type: "variable", detail,
});

export const LATEX_COMMANDS: Completion[] = [
  // Structure
  cmd("\\documentclass{}"), cmd("\\usepackage{}"), cmd("\\begin{}"), cmd("\\end{}"),
  cmd("\\section{}"), cmd("\\subsection{}"), cmd("\\subsubsection{}"),
  cmd("\\paragraph{}"), cmd("\\chapter{}"), cmd("\\part{}"), cmd("\\appendix"),
  cmd("\\title{}"), cmd("\\author{}"), cmd("\\date{}"), cmd("\\maketitle"),
  cmd("\\tableofcontents"), cmd("\\input{}"), cmd("\\include{}"),
  cmd("\\label{}"), cmd("\\ref{}"), cmd("\\eqref{}"), cmd("\\pageref{}"),
  cmd("\\cite{}"), cmd("\\citep{}"), cmd("\\citet{}"), cmd("\\footnote{}"),
  cmd("\\bibliography{}"), cmd("\\bibliographystyle{}"), cmd("\\addbibresource{}"),
  cmd("\\printbibliography"),
  // Text formatting
  cmd("\\textbf{}", "bold"), cmd("\\textit{}", "italic"), cmd("\\texttt{}", "monospace"),
  cmd("\\textsc{}", "small caps"), cmd("\\emph{}"), cmd("\\underline{}"),
  cmd("\\textsuperscript{}"), cmd("\\textsubscript{}"),
  cmd("\\tiny"), cmd("\\small"), cmd("\\normalsize"), cmd("\\large"), cmd("\\Large"), cmd("\\huge"),
  cmd("\\centering"), cmd("\\raggedright"), cmd("\\noindent"),
  cmd("\\newline"), cmd("\\newpage"), cmd("\\clearpage"), cmd("\\linebreak"),
  cmd("\\vspace{}"), cmd("\\hspace{}"), cmd("\\quad"), cmd("\\qquad"),
  cmd("\\item"), cmd("\\caption{}"), cmd("\\includegraphics[]{}"),
  cmd("\\url{}"), cmd("\\href{}{}"), cmd("\\verb||"),
  cmd("\\newcommand{}{}"), cmd("\\renewcommand{}{}"), cmd("\\def"),
  cmd("\\hline"), cmd("\\toprule"), cmd("\\midrule"), cmd("\\bottomrule"),
  cmd("\\multicolumn{}{}{}"), cmd("\\multirow{}{}{}"),
  // Math
  cmd("\\frac{}{}"), cmd("\\dfrac{}{}"), cmd("\\sqrt{}"), cmd("\\sum"), cmd("\\prod"),
  cmd("\\int"), cmd("\\oint"), cmd("\\lim"), cmd("\\infty"), cmd("\\partial"),
  cmd("\\nabla"), cmd("\\cdot"), cmd("\\times"), cmd("\\pm"), cmd("\\mp"),
  cmd("\\leq"), cmd("\\geq"), cmd("\\neq"), cmd("\\approx"), cmd("\\sim"), cmd("\\equiv"),
  cmd("\\in"), cmd("\\notin"), cmd("\\subset"), cmd("\\subseteq"), cmd("\\cup"), cmd("\\cap"),
  cmd("\\rightarrow"), cmd("\\leftarrow"), cmd("\\Rightarrow"), cmd("\\Leftrightarrow"),
  cmd("\\mapsto"), cmd("\\forall"), cmd("\\exists"),
  cmd("\\mathbb{}"), cmd("\\mathcal{}"), cmd("\\mathrm{}"), cmd("\\mathbf{}"), cmd("\\mathit{}"),
  cmd("\\hat{}"), cmd("\\bar{}"), cmd("\\vec{}"), cmd("\\tilde{}"), cmd("\\dot{}"), cmd("\\ddot{}"),
  cmd("\\overline{}"), cmd("\\underbrace{}"), cmd("\\overbrace{}"),
  cmd("\\left("), cmd("\\right)"), cmd("\\left["), cmd("\\right]"), cmd("\\langle"), cmd("\\rangle"),
  cmd("\\text{}"), cmd("\\operatorname{}"), cmd("\\binom{}{}"),
  cmd("\\sin"), cmd("\\cos"), cmd("\\tan"), cmd("\\log"), cmd("\\ln"), cmd("\\exp"),
  cmd("\\min"), cmd("\\max"), cmd("\\arg"), cmd("\\det"),
  // Greek
  sym("\\alpha", "α"), sym("\\beta", "β"), sym("\\gamma", "γ"), sym("\\delta", "δ"),
  sym("\\epsilon", "ε"), sym("\\varepsilon", "ε"), sym("\\zeta", "ζ"), sym("\\eta", "η"),
  sym("\\theta", "θ"), sym("\\iota", "ι"), sym("\\kappa", "κ"), sym("\\lambda", "λ"),
  sym("\\mu", "μ"), sym("\\nu", "ν"), sym("\\xi", "ξ"), sym("\\pi", "π"),
  sym("\\rho", "ρ"), sym("\\sigma", "σ"), sym("\\tau", "τ"), sym("\\upsilon", "υ"),
  sym("\\phi", "φ"), sym("\\varphi", "φ"), sym("\\chi", "χ"), sym("\\psi", "ψ"),
  sym("\\omega", "ω"), sym("\\Gamma", "Γ"), sym("\\Delta", "Δ"), sym("\\Theta", "Θ"),
  sym("\\Lambda", "Λ"), sym("\\Xi", "Ξ"), sym("\\Pi", "Π"), sym("\\Sigma", "Σ"),
  sym("\\Phi", "Φ"), sym("\\Psi", "Ψ"), sym("\\Omega", "Ω"),
];

export const LATEX_ENVIRONMENTS: string[] = [
  "document", "abstract", "figure", "table", "tabular", "tabularx", "array",
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline",
  "itemize", "enumerate", "description", "quote", "quotation", "verbatim",
  "center", "flushleft", "flushright", "minipage", "matrix", "pmatrix",
  "bmatrix", "vmatrix", "cases", "split", "theorem", "lemma", "proof",
  "definition", "example", "remark", "algorithm", "lstlisting", "frame",
  "titlepage", "thebibliography", "appendix", "subfigure", "wrapfigure",
];

export const LATEX_SNIPPETS: Completion[] = [
  snippetCompletion(
    "\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=${0.8}\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}",
    { label: "figure", detail: "figure skeleton", type: "class" },
  ),
  snippetCompletion(
    "\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{${lcr}}\n\t\t\\toprule\n\t\t${header} \\\\\n\t\t\\midrule\n\t\t${row} \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}",
    { label: "table", detail: "booktabs table skeleton", type: "class" },
  ),
  snippetCompletion(
    "\\begin{equation}\n\t${x = y}\n\t\\label{eq:${label}}\n\\end{equation}",
    { label: "equation", detail: "numbered equation", type: "class" },
  ),
  snippetCompletion(
    "\\begin{align}\n\t${a} &= ${b} \\\\\n\t&= ${c}\n\\end{align}",
    { label: "align", detail: "aligned equations", type: "class" },
  ),
  snippetCompletion(
    "\\begin{itemize}\n\t\\item ${first}\n\t\\item ${second}\n\\end{itemize}",
    { label: "itemize", detail: "bullet list", type: "class" },
  ),
  snippetCompletion(
    "\\begin{enumerate}\n\t\\item ${first}\n\t\\item ${second}\n\\end{enumerate}",
    { label: "enumerate", detail: "numbered list", type: "class" },
  ),
];

// ---- completion source -----------------------------------------------------

const REF_CMD_RE = /\\(?:ref|eqref|autoref|cref|Cref|pageref|vref)\{([^}]*)$/;
const CITE_CMD_RE =
  /\\(?:cite|citep|citet|citeauthor|citeyear|textcite|parencite|autocite)(?:\[[^\]]*\])*\{([^},]*)$/;
const BEGIN_RE = /\\begin\{([a-zA-Z*]*)$/;
const COMMAND_RE = /\\[a-zA-Z]*$/;

export function latexCompletionSource(opts: {
  getBibKeys: () => string[];
}): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);

    const ref = REF_CMD_RE.exec(before);
    if (ref) {
      const labels = scanLabels(context.state.doc.toString());
      return {
        from: context.pos - ref[1].length,
        options: labels.map((l) => ({ label: l, type: "constant" })),
        validFor: /^[^}]*$/,
      };
    }
    const cite = CITE_CMD_RE.exec(before);
    if (cite) {
      return {
        from: context.pos - cite[1].length,
        options: opts.getBibKeys().map((k) => ({ label: k, type: "constant" })),
        validFor: /^[^},]*$/,
      };
    }
    const env = BEGIN_RE.exec(before);
    if (env) {
      return {
        from: context.pos - env[1].length,
        options: LATEX_ENVIRONMENTS.map((name) =>
          snippetCompletion(`${name}}\n\t\${}\n\\end{${name}}`, {
            label: name, type: "class",
          }),
        ),
        validFor: /^[a-zA-Z*]*$/,
      };
    }
    const cmdMatch = COMMAND_RE.exec(before);
    if (cmdMatch && (context.explicit || cmdMatch[0].length > 1)) {
      return {
        from: context.pos - cmdMatch[0].length,
        options: [...LATEX_COMMANDS, ...LATEX_SNIPPETS],
        validFor: /^\\[a-zA-Z]*$/,
      };
    }
    return null;
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/latex/magic-comments.test.ts src/lib/latex/completions.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

Run: `cd web && npx tsc --noEmit`
Expected: clean (`@codemirror/autocomplete` resolves as a transitive dep)

```bash
git add web/src/lib/latex/magic-comments.ts web/src/lib/latex/completions.ts web/src/lib/latex/magic-comments.test.ts web/src/lib/latex/completions.test.ts
git commit -m "feat(latex-web): magic comments + autocomplete sources (commands, envs, ref/cite)"
```

---

### Task 8: Spell check — worker, extension, dictionary assets

**Files:**
- Create: `web/public/dict/en_US.aff`, `web/public/dict/en_US.dic` (copied from typo-js)
- Create: `web/src/types/typo-js.d.ts`
- Create: `web/src/lib/latex/spellcheck.worker.ts`
- Create: `web/src/lib/latex/spellcheck.ts`
- Modify: `web/package.json` (add `typo-js`)
- Test: `web/src/lib/latex/spellcheck.test.ts`

**Interfaces:**
- `spellcheck.ts` produces (used by Task 13):
  - `SpellWorkerClient` class: `check(words: string[]): Promise<string[]>` (returns the misspelled subset), `suggest(word: string): Promise<string[]>`, `dispose(): void`. Constructor takes a `Worker`.
  - `buildSpellDiagnostics(tokens: ProseToken[], misspelled: ReadonlySet<string>, ignored: ReadonlySet<string>, mkActions: (token: ProseToken) => Diagnostic["actions"]): Diagnostic[]` — pure, tested.
  - `latexSpellLinter(opts: { client: () => SpellWorkerClient | null; ignored: () => ReadonlySet<string>; onAddWord: (word: string) => void }): Extension` — a `linter()` async source with 500ms delay; diagnostics severity `"hint"`; each carries actions: up to 5 suggestions (replace) + "Add to dictionary".
- Worker protocol: `{ id, type: "check", words: string[] }` → `{ id, misspelled: string[] }`; `{ id, type: "suggest", word }` → `{ id, suggestions: string[] }`. Worker fetches `/dict/en_US.aff` + `/dict/en_US.dic` on boot; check results cached worker-side in a Map; suggest capped and cached.

- [ ] **Step 1: Install dep and copy dictionaries**

```bash
cd web && npm install typo-js
mkdir -p public/dict
cp node_modules/typo-js/dictionaries/en_US/en_US.aff public/dict/
cp node_modules/typo-js/dictionaries/en_US/en_US.dic public/dict/
```

Create `web/src/types/typo-js.d.ts`:

```ts
declare module "typo-js" {
  export default class Typo {
    constructor(
      dictionary: string,
      affData?: string | null,
      wordsData?: string | null,
      settings?: { platform?: string },
    );
    check(word: string): boolean;
    suggest(word: string, limit?: number): string[];
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/lib/latex/spellcheck.test.ts` (tests the pure diagnostic builder and the client protocol against a fake worker — no real dictionary in jsdom):

```ts
import { describe, expect, it, vi } from "vitest";
import type { ProseToken } from "./prose";
import { SpellWorkerClient, buildSpellDiagnostics } from "./spellcheck";

function tok(word: string, from: number): ProseToken {
  return { word, from, to: from + word.length };
}

describe("buildSpellDiagnostics", () => {
  it("marks only misspelled, non-ignored tokens", () => {
    const tokens = [tok("helo", 0), tok("world", 5), tok("kady", 11)];
    const diags = buildSpellDiagnostics(
      tokens,
      new Set(["helo", "kady"]),
      new Set(["kady"]),
      () => [],
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ from: 0, to: 4, severity: "hint" });
    expect(diags[0].message).toContain("helo");
  });
  it("is case-insensitive on the ignore list", () => {
    const diags = buildSpellDiagnostics(
      [tok("Kady", 0)], new Set(["Kady"]), new Set(["kady"]), () => [],
    );
    expect(diags).toHaveLength(0);
  });
});

describe("SpellWorkerClient", () => {
  it("round-trips check requests by id", async () => {
    const listeners: ((e: MessageEvent) => void)[] = [];
    const fakeWorker = {
      postMessage: vi.fn((msg: { id: number; words: string[] }) => {
        queueMicrotask(() => {
          for (const l of listeners) {
            l({ data: { id: msg.id, misspelled: ["helo"] } } as MessageEvent);
          }
        });
      }),
      addEventListener: (_: string, cb: (e: MessageEvent) => void) => listeners.push(cb),
      terminate: vi.fn(),
    } as unknown as Worker;

    const client = new SpellWorkerClient(fakeWorker);
    const misspelled = await client.check(["helo", "world"]);
    expect(misspelled).toEqual(["helo"]);
    client.dispose();
    expect((fakeWorker as unknown as { terminate: ReturnType<typeof vi.fn> }).terminate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/latex/spellcheck.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `web/src/lib/latex/spellcheck.worker.ts`**

```ts
/**
 * Spell check worker: owns the typo-js dictionary (parsing the .dic blocks
 * the main thread for ~1s, so it lives here). Protocol: {id, type, ...} in,
 * {id, ...} out. Unknown-word results and suggestions are memoized.
 */
import Typo from "typo-js";

// Worker global — the default TS lib types `self` as Window, whose
// postMessage signature differs; alias the two members we use.
const ctx = self as unknown as {
  postMessage: (msg: unknown) => void;
  addEventListener: (type: "message", cb: (e: MessageEvent) => void) => void;
};

let dict: Typo | null = null;
const checkCache = new Map<string, boolean>();
const suggestCache = new Map<string, string[]>();

const ready = (async () => {
  const [aff, dic] = await Promise.all([
    fetch("/dict/en_US.aff").then((r) => r.text()),
    fetch("/dict/en_US.dic").then((r) => r.text()),
  ]);
  dict = new Typo("en_US", aff, dic, { platform: "any" });
})();

function checkWord(word: string): boolean {
  if (!dict) return true; // not ready — treat everything as correct
  let ok = checkCache.get(word);
  if (ok === undefined) {
    ok = dict.check(word) || dict.check(word.toLowerCase());
    checkCache.set(word, ok);
  }
  return ok;
}

ctx.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as
    | { id: number; type: "check"; words: string[] }
    | { id: number; type: "suggest"; word: string };
  await ready;
  if (msg.type === "check") {
    const misspelled = [...new Set(msg.words)].filter((w) => !checkWord(w));
    ctx.postMessage({ id: msg.id, misspelled });
  } else {
    let suggestions = suggestCache.get(msg.word);
    if (!suggestions) {
      suggestions = dict ? dict.suggest(msg.word, 5) : [];
      suggestCache.set(msg.word, suggestions);
    }
    ctx.postMessage({ id: msg.id, suggestions });
  }
});
```

- [ ] **Step 5: Implement `web/src/lib/latex/spellcheck.ts`**

```ts
/**
 * CodeMirror spell check extension for LaTeX prose. Reuses the lint
 * infrastructure: misspellings are "hint" diagnostics whose actions carry
 * suggestions and "Add to dictionary". The heavy lifting (dictionary,
 * suggestion search) happens in a Web Worker via SpellWorkerClient.
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { extractProseTokens, type ProseToken } from "./prose";

interface Pending {
  resolve: (value: never) => void;
}

export class SpellWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (data: never) => void>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (e: MessageEvent) => {
      const { id } = e.data as { id: number };
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(e.data as never);
      }
    });
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as Pending["resolve"]);
      this.worker.postMessage({ id, ...payload });
    });
  }

  async check(words: string[]): Promise<string[]> {
    const { misspelled } = await this.request<{ misspelled: string[] }>({
      type: "check",
      words,
    });
    return misspelled;
  }

  async suggest(word: string): Promise<string[]> {
    const { suggestions } = await this.request<{ suggestions: string[] }>({
      type: "suggest",
      word,
    });
    return suggestions;
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

export function createSpellWorker(): SpellWorkerClient | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new SpellWorkerClient(
      new Worker(new URL("./spellcheck.worker.ts", import.meta.url), {
        type: "module",
      }),
    );
  } catch {
    return null; // spellcheck is an enhancement — never break the editor
  }
}

export function buildSpellDiagnostics(
  tokens: ProseToken[],
  misspelled: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
  mkActions: (token: ProseToken) => Diagnostic["actions"],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const t of tokens) {
    if (!misspelled.has(t.word)) continue;
    if (ignored.has(t.word.toLowerCase())) continue;
    out.push({
      from: t.from,
      to: t.to,
      severity: "hint",
      source: "spellcheck",
      message: `Unknown word: ${t.word}`,
      actions: mkActions(t),
    });
  }
  return out;
}

const MAX_SUGGEST_PER_PASS = 10;

export function latexSpellLinter(opts: {
  client: () => SpellWorkerClient | null;
  ignored: () => ReadonlySet<string>;
  onAddWord: (word: string) => void;
}): Extension {
  return linter(
    async (view) => {
      const client = opts.client();
      if (!client) return [];
      const tokens = extractProseTokens(view.state.doc.toString());
      if (!tokens.length) return [];
      const unique = [...new Set(tokens.map((t) => t.word))];
      const misspelledList = await client.check(unique);
      const misspelled = new Set(misspelledList);

      // Fetch suggestions for a bounded number of distinct words per pass;
      // the worker memoizes, so repeated passes fill the rest in.
      const suggestions = new Map<string, string[]>();
      for (const word of misspelledList.slice(0, MAX_SUGGEST_PER_PASS)) {
        suggestions.set(word, await client.suggest(word));
      }

      return buildSpellDiagnostics(tokens, misspelled, opts.ignored(), (t) => {
        const fixes = (suggestions.get(t.word) ?? []).map((s) => ({
          name: s,
          apply: (v: typeof view, from: number, to: number) => {
            v.dispatch({ changes: { from, to, insert: s } });
          },
        }));
        return [
          ...fixes,
          {
            name: "Add to dictionary",
            apply: () => opts.onAddWord(t.word),
          },
        ];
      });
    },
    { delay: 500 },
  );
}
```

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `cd web && npx vitest run src/lib/latex/spellcheck.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck

```bash
git add web/package.json web/package-lock.json web/public/dict web/src/types/typo-js.d.ts web/src/lib/latex/spellcheck.worker.ts web/src/lib/latex/spellcheck.ts web/src/lib/latex/spellcheck.test.ts
git commit -m "feat(latex-web): worker-based spell check with lint-action suggestions"
```

---

### Task 9: Shared PdfViewer — reload-in-place, SyncTeX hooks, lazy pages

**Files:**
- Modify: `web/src/components/pdf-viewer/pdf-viewer.tsx`
- Modify: `web/src/app/globals.css` (flash animation)

**Interfaces:**
- Produces (consumed by Task 14's `latex-pdf-pane.tsx`):

```ts
export interface PdfSyncHighlight { page: number; h: number; v: number; W: number; H: number; token: number }
export interface PdfSyncClick { page: number; x: number; y: number } // top-left PDF points
export interface PdfViewerProps {
  path: string;
  className?: string;
  reloadToken?: number;        // bump to re-fetch the same path in place (scroll/zoom preserved)
  syncHighlight?: PdfSyncHighlight | null; // scroll to + flash this box (synctex view coords)
  onSyncClick?: (pos: PdfSyncClick) => void; // Cmd/Ctrl+click on a page
  hideAnnotationUi?: boolean;  // hide annotation sidebar + highlight/note buttons
}
```

- Coordinate contract: synctex boxes use PDF points, y from page TOP, `v` = box bottom. CSS mapping inside `PageView` is `left = h*s`, `top = (v-H)*s`, `s = BASE_SCALE * zoom`. Click positions map back as `x = cssX/s`, `y = cssY/s`.

This file is excluded from unit-test coverage (canvas-heavy); verification is behavioral in Step 6.

- [ ] **Step 1: New props + document reload-in-place**

In `web/src/components/pdf-viewer/pdf-viewer.tsx`:

1. Replace the `PdfViewerProps` interface (lines ~142-145) with the one in the Interfaces block above (add the two exported types), and update the function signature:

```ts
export function PdfViewer({
  path,
  className,
  reloadToken = 0,
  syncHighlight = null,
  onSyncClick,
  hideAnnotationUi = false,
}: PdfViewerProps) {
```

2. Add refs next to `containerRef`:

```ts
  const docRef = useRef<PdfDoc | null>(null);
  const loadedPathRef = useRef<string | null>(null);
```

3. Replace the document-loading effect (the one with deps `[pdfjs, path]`, lines ~197-227) with:

```ts
  useEffect(() => {
    if (!pdfjs) return;
    let cancelled = false;
    // Reload-in-place: same path with a doc already shown keeps the old
    // canvases up until the new document is ready, then restores scroll.
    const isReload = docRef.current !== null && loadedPathRef.current === path;
    const savedScroll = isReload ? (containerRef.current?.scrollTop ?? null) : null;
    const url = rawFileUrl(path) + (reloadToken ? `&_r=${reloadToken}` : "");
    const task = pdfjs.getDocument({ url, withCredentials: true });
    if (!isReload) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setError(null);
        setDoc(null);
        setNumPages(0);
      });
    }
    task.promise.then(
      (loaded) => {
        if (cancelled) {
          loaded.destroy();
          return;
        }
        const prev = docRef.current;
        docRef.current = loaded;
        loadedPathRef.current = path;
        setError(null);
        setDoc(loaded);
        setNumPages(loaded.numPages);
        if (prev && prev !== loaded) {
          try { prev.destroy(); } catch { /* already gone */ }
        }
        if (savedScroll !== null) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (containerRef.current) containerRef.current.scrollTop = savedScroll;
            });
          });
        }
      },
      (e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load PDF");
      },
    );
    return () => {
      cancelled = true;
      // Only tear down a load that never became the displayed document —
      // destroying the live doc mid-reload would break mounted PageViews.
      task.promise.then(
        (loaded) => {
          if (loaded !== docRef.current) {
            try { loaded.destroy(); } catch { /* ignore */ }
          }
        },
        () => {},
      );
    };
  }, [pdfjs, path, reloadToken]);

  useEffect(
    () => () => {
      try { docRef.current?.destroy(); } catch { /* ignore */ }
      docRef.current = null;
    },
    [],
  );
```

- [ ] **Step 2: Cmd/Ctrl+click → onSyncClick, and syncHighlight scrolling**

1. Replace `handlePageClick` (lines ~427-445) with:

```ts
  const handlePageClick = useCallback(
    (ev: React.MouseEvent<HTMLDivElement>, page: number) => {
      if ((ev.metaKey || ev.ctrlKey) && onSyncClick) {
        const box = ev.currentTarget.getBoundingClientRect();
        const s = BASE_SCALE * zoom;
        onSyncClick({
          page,
          x: (ev.clientX - box.left) / s,
          y: (ev.clientY - box.top) / s,
        });
        return;
      }
      if (mode !== "note") return;
      const el = ev.currentTarget;
      const box = el.getBoundingClientRect();
      const cssX = ev.clientX - box.left;
      const cssY = ev.clientY - box.top;
      const viewport = readViewport(el);
      if (!viewport) return;
      const [x, y] = viewport.convertToPdfPoint(cssX, cssY);
      setPendingNote({
        page,
        anchor: { x, y },
        screen: { x: ev.clientX, y: ev.clientY },
      });
      setMode("none");
    },
    [mode, onSyncClick, zoom],
  );
```

(The duplicate `box` name inside the branch is fine — the early-return branch declares its own const in its own block scope; if TS complains, rename the first to `pageBox`.)

2. Add a scroll-to-highlight effect after the `jumpToAnnotation` callback:

```ts
  useEffect(() => {
    if (!syncHighlight) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-pdf-page="${syncHighlight.page}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncHighlight?.token]);
```

- [ ] **Step 3: Lazy page rendering with a measured placeholder**

1. In the `PdfViewer` body add default-size measurement (after the doc-loading effect):

```ts
  const [defaultSize, setDefaultSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc
      .getPage(1)
      .then((p: PdfPage) => {
        if (cancelled) return;
        const vp = p.getViewport({ scale: BASE_SCALE * zoom });
        setDefaultSize({ w: vp.width, h: vp.height });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [doc, zoom]);
```

2. Gate page rendering on `defaultSize` — change `{doc && Array.from(...)` to `{doc && defaultSize && Array.from(...)` and pass the two new props to `PageView`:

```tsx
                  <PageView
                    key={pageNumber}
                    doc={doc}
                    pageNumber={pageNumber}
                    zoom={zoom}
                    defaultSize={defaultSize}
                    sync={syncHighlight?.page === pageNumber ? syncHighlight : null}
                    annotations={annotationsByPage.get(pageNumber) ?? []}
                    activeAnnotationId={activeAnnotationId}
                    onRemove={removeAnnotation}
                    onUpdate={updateAnnotation}
                    onClickPage={(e) => handlePageClick(e, pageNumber)}
                  />
```

3. Update the current-page IntersectionObserver effect deps from `[numPages]` to `[numPages, defaultSize]` (pages only exist once defaultSize lands).

4. In `PageView`: add the two props to its signature/types:

```ts
  defaultSize: { w: number; h: number } | null;
  sync: { h: number; v: number; W: number; H: number; token: number } | null;
```

add visibility state at the top of the component:

```ts
  const [visible, setVisible] = useState(pageNumber <= 2);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || visible) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "150% 0%" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);
```

make the render effect bail until visible — first line inside the effect: `if (!visible) return;` and change its deps to `[doc, pageNumber, zoom, visible]`.

Use the placeholder size in the wrapper (replace the `style={size ? ... }` line):

```tsx
      style={(size ?? defaultSize) ? { width: (size ?? defaultSize)!.w, height: (size ?? defaultSize)!.h } : undefined}
```

and add the sync flash overlay just before `<AnnotationLayer …>`:

```tsx
      {sync && (
        <div
          key={sync.token}
          className="pointer-events-none absolute z-10 animate-sync-flash rounded-sm bg-blue-400/40 ring-2 ring-blue-500"
          style={{
            left: sync.h * BASE_SCALE * zoom,
            top: (sync.v - sync.H) * BASE_SCALE * zoom,
            width: Math.max(sync.W * BASE_SCALE * zoom, 8),
            height: Math.max(sync.H * BASE_SCALE * zoom, 8),
          }}
        />
      )}
```

- [ ] **Step 4: hideAnnotationUi**

1. Wrap the sidebar: `{!hideAnnotationUi && <AnnotationSidebar … />}`.
2. Pass `hideAnnotationUi` to `Toolbar` (add a `hideAnnotationUi: boolean` prop there) and wrap the Highlight-mode button, "Add note" button, and the "Expert annotations" checkbox each in `{!hideAnnotationUi && (…)}`.

- [ ] **Step 5: Flash animation CSS**

In `web/src/app/globals.css` append:

```css
@keyframes sync-flash {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
.animate-sync-flash {
  animation: sync-flash 2s ease-out forwards;
}
```

- [ ] **Step 6: Verify behaviorally + typecheck**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean; existing tests pass.

Manual check (app running via `./start.sh` or both dev servers): open an existing PDF in the preview panel — pages render as you scroll (network tab shows no regression), zoom works, annotations still add/remove, sidebar present. No LaTeX flows yet — this must not regress plain PDF viewing.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/pdf-viewer/pdf-viewer.tsx web/src/app/globals.css
git commit -m "feat(pdf-viewer): reload-in-place, synctex hooks, lazy page rendering"
```

---

### Task 10: LaTeX module — shell move, toolbar, log panel, perf + theme fixes

**Files:**
- Create: `web/src/components/latex/index.ts`
- Create: `web/src/components/latex/latex-editor.tsx`
- Create: `web/src/components/latex/latex-toolbar.tsx`
- Create: `web/src/components/latex/log-panel.tsx`
- Delete: `web/src/components/latex-editor.tsx`
- Modify: `web/src/components/file-preview-panel.tsx` (dynamic import; dark theme for TextEditor and the read-only viewer)
- Modify: `web/src/lib/use-sandbox.ts` (add `synctex: boolean` to `LatexCompileResult`)

**Interfaces:**
- Consumes: Task 5 `parseCompileDiagnostics`, Task 7 `parseMagicComments`/`resolveRelative`.
- Produces:
  - `web/src/components/latex/index.ts` exports `LatexEditor` (same props as before **plus** `onOpenFile?: (path: string) => void`).
  - `latex-toolbar.tsx` exports `LatexToolbar` and `SnippetAction = { kind: "wrap"; before: string; after: string } | { kind: "block"; text: string }`.
  - `log-panel.tsx` exports `LogPanel({ log, open, onClose, filter, onFilterChange })`.
  - Extension points used by Tasks 11-15: the `extensions` `useMemo` in the shell, the `LatexToolbar` props object, the split-pane layout (`outline | editor | divider | pdf`), and `diagRef`/`texLinter`.

This task keeps the iframe PDF pane (swapped in Task 14) and does NOT yet wire outline/autocomplete/spellcheck/AI.

- [ ] **Step 1: Add `synctex` to the client compile type**

In `web/src/lib/use-sandbox.ts`, extend the interface (line ~139):

```ts
export interface LatexCompileResult {
  success: boolean;
  pdf_path: string | null;
  log: string;
  errors: string[];
  synctex: boolean;
}
```

- [ ] **Step 2: Create `web/src/components/latex/log-panel.tsx`**

```tsx
"use client";

import { XIcon } from "lucide-react";

export type LogFilter = "all" | "problems";

const PROBLEM_RE = /^(!|.*:\d+:|LaTeX Warning|Overfull|Underfull|Package \w+ Warning)/;

export function LogPanel({
  log,
  open,
  onClose,
  filter,
  onFilterChange,
}: {
  log: string;
  open: boolean;
  onClose: () => void;
  filter: LogFilter;
  onFilterChange: (f: LogFilter) => void;
}) {
  if (!open || !log) return null;
  const lines = log.split("\n");
  const shown = filter === "problems" ? lines.filter((l) => PROBLEM_RE.test(l)) : lines;
  return (
    <div className="shrink-0 max-h-48 overflow-auto border-t bg-muted/10">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/40 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Compilation Log
        </span>
        <div className="flex overflow-hidden rounded border text-[10px]">
          {(["all", "problems"] as const).map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              className={
                filter === f
                  ? "bg-muted px-2 py-0.5 font-medium text-foreground"
                  : "px-2 py-0.5 text-muted-foreground hover:text-foreground"
              }
            >
              {f === "all" ? "All" : "Problems"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words p-3 text-[11px] font-mono leading-relaxed text-muted-foreground">
        {shown.map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith("!") || /:\d+:/.test(line)
                ? "text-red-600 dark:text-red-400 font-medium"
                : /Warning|Overfull|Underfull/.test(line)
                  ? "text-amber-600 dark:text-amber-400"
                  : ""
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
        {filter === "problems" && shown.length === 0 && "No problems found in log.\n"}
      </pre>
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/latex/latex-toolbar.tsx`**

```tsx
"use client";

import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ItalicIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type Engine = "pdflatex" | "xelatex" | "lualatex";

export const ENGINES: { id: Engine; label: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX" },
  { id: "xelatex", label: "XeLaTeX" },
  { id: "lualatex", label: "LuaLaTeX" },
];

export type SnippetAction =
  | { kind: "wrap"; before: string; after: string }
  | { kind: "block"; text: string };

const BLOCK_SNIPPETS: { label: string; text: string }[] = [
  {
    label: "Figure",
    text: "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n",
  },
  {
    label: "Table",
    text: "\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{lcc}\n    \\toprule\n     &  &  \\\\\n    \\midrule\n     &  &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n",
  },
  { label: "Equation", text: "\\begin{equation}\n  \n  \\label{eq:}\n\\end{equation}\n" },
  { label: "Itemize", text: "\\begin{itemize}\n  \\item \n\\end{itemize}\n" },
  { label: "Enumerate", text: "\\begin{enumerate}\n  \\item \n\\end{enumerate}\n" },
];

export interface LatexToolbarProps {
  compiling: boolean;
  saving: boolean;
  saved: boolean;
  isDirty: boolean;
  engine: Engine;
  onEngineChange: (e: Engine) => void;
  onCompile: () => void;
  onSave: () => void;
  onDiscard: () => void;
  errorCount: number;
  warningCount: number;
  hasPdf: boolean;
  hasLog: boolean;
  logOpen: boolean;
  onToggleLog: () => void;
  autoCompile: boolean;
  onToggleAutoCompile: () => void;
  wordCount: number;
  modKey: string;
  onSnippet: (action: SnippetAction) => void;
}

export function LatexToolbar(p: LatexToolbarProps) {
  const [insertOpen, setInsertOpen] = useState(false);
  const insertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!insertOpen) return;
    const close = (e: MouseEvent) => {
      if (!insertRef.current?.contains(e.target as Node)) setInsertOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [insertOpen]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
      <button
        onClick={p.onCompile}
        disabled={p.compiling}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
          p.compiling
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-600 text-white hover:bg-emerald-700",
        )}
      >
        {p.compiling ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
        {p.compiling ? "Compiling…" : "Compile"}
      </button>

      <select
        value={p.engine}
        onChange={(e) => p.onEngineChange(e.target.value as Engine)}
        className="rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none"
      >
        {ENGINES.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>

      <label
        className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground"
        title="Compile automatically after each save"
      >
        <input
          type="checkbox"
          checked={p.autoCompile}
          onChange={p.onToggleAutoCompile}
          className="size-3"
        />
        auto
      </label>

      <div className="h-4 w-px bg-border" />

      {/* Quick inserts */}
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "\\textbf{", after: "}" })}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Bold"
      >
        <BoldIcon className="size-3.5" />
      </button>
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "\\emph{", after: "}" })}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Emphasis"
      >
        <ItalicIcon className="size-3.5" />
      </button>
      <button
        onClick={() => p.onSnippet({ kind: "wrap", before: "$", after: "$" })}
        className="rounded p-1 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Inline math"
      >
        $
      </button>
      <div ref={insertRef} className="relative">
        <button
          onClick={() => setInsertOpen((v) => !v)}
          className="flex items-center gap-0.5 rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Insert block"
        >
          <PlusIcon className="size-3.5" />
          <ChevronDownIcon className="size-3" />
        </button>
        {insertOpen && (
          <div className="absolute left-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border bg-background shadow-lg">
            {BLOCK_SNIPPETS.map((s) => (
              <button
                key={s.label}
                onClick={() => {
                  p.onSnippet({ kind: "block", text: s.text });
                  setInsertOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Status */}
      {(p.errorCount > 0 || p.warningCount > 0) && !p.compiling && (
        <button
          onClick={p.onToggleLog}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            p.errorCount > 0
              ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              : "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40",
          )}
        >
          <AlertTriangleIcon className="size-3.5" />
          {p.errorCount > 0
            ? `${p.errorCount} error${p.errorCount !== 1 ? "s" : ""}`
            : `${p.warningCount} warning${p.warningCount !== 1 ? "s" : ""}`}
        </button>
      )}
      {p.hasPdf && p.errorCount === 0 && !p.compiling && (
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-3.5" /> PDF ready
        </span>
      )}

      <div className="flex-1" />

      <span className="text-[10px] tabular-nums text-muted-foreground/70">
        {p.wordCount.toLocaleString()} words
      </span>

      {p.hasLog && (
        <button
          onClick={p.onToggleLog}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          {p.logOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronUpIcon className="size-3.5" />}
          Log
        </button>
      )}

      <div className="h-4 w-px bg-border" />

      <div
        className={cn(
          "size-2 rounded-full transition-colors",
          p.isDirty ? "bg-amber-500" : "bg-muted-foreground/30",
        )}
      />
      <span className="font-mono text-[10px] text-muted-foreground/60">
        {p.modKey}S save · {p.modKey}↵ compile
      </span>

      <button
        onClick={p.onSave}
        disabled={!p.isDirty || p.saving}
        className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {p.saved ? <CheckIcon className="size-3" /> : null}
        {p.saving ? "Saving…" : p.saved ? "Saved!" : "Save"}
      </button>

      <button
        onClick={p.onDiscard}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Close
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `web/src/components/latex/latex-editor.tsx` (the shell)**

```tsx
"use client";

import { rawFileUrl, type LatexCompileResult } from "@/lib/use-sandbox";
import { parseCompileDiagnostics } from "@/lib/latex/diagnostics";
import { parseMagicComments, resolveRelative } from "@/lib/latex/magic-comments";
import { proseWordCount } from "@/lib/latex/prose";
import { cn } from "@/lib/utils";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { keymap } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { FileTextIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LatexToolbar, type Engine, type SnippetAction } from "./latex-toolbar";
import { LogPanel, type LogFilter } from "./log-panel";

const AUTOCOMPILE_KEY = "kady:latex:autocompile";

export interface LatexEditorProps {
  path: string;
  name: string;
  initialContent: string;
  onSave: (content: string) => Promise<boolean>;
  onCompile: (path: string, engine?: string) => Promise<LatexCompileResult>;
  onDiscard: () => void;
  onOpenFile?: (path: string) => void;
}

function isValidEngine(p: string | undefined): p is Engine {
  return p === "pdflatex" || p === "xelatex" || p === "lualatex";
}

export function LatexEditor({
  path,
  name,
  initialContent,
  onSave,
  onCompile,
  onDiscard,
}: LatexEditorProps) {
  // --- document state: content lives in CodeMirror, not React state -------
  const contentRef = useRef(initialContent);
  const lastSavedRef = useRef(initialContent);
  const viewRef = useRef<EditorView | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const compilingRef = useRef(false);
  const [engine, setEngine] = useState<Engine>(() => {
    const p = parseMagicComments(initialContent).program;
    return isValidEngine(p) ? p : "pdflatex";
  });
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfKey, setPdfKey] = useState(0);
  const [logText, setLogText] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [errorCount, setErrorCount] = useState(0);
  const [warningCount, setWarningCount] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [splitPct, setSplitPct] = useState(50);
  const [wordCount, setWordCount] = useState(() => proseWordCount(initialContent));
  const [autoCompile, setAutoCompile] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(AUTOCOMPILE_KEY) === "1",
  );

  const { resolvedTheme } = useTheme();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const modKey = isMac ? "⌘" : "Ctrl+";

  // Compile diagnostics pinned to the exact doc Text they were computed for;
  // Text.eq() is cheap (structural), unlike toString() comparisons.
  const diagRef = useRef<{
    doc: Text;
    items: { line: number; message: string; severity: "error" | "warning" }[];
  } | null>(null);

  const wordCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleChange = useCallback((value: string) => {
    contentRef.current = value;
    setIsDirty(value !== lastSavedRef.current);
    if (wordCountTimer.current) clearTimeout(wordCountTimer.current);
    wordCountTimer.current = setTimeout(() => setWordCount(proseWordCount(value)), 1000);
  }, []);
  useEffect(
    () => () => {
      if (wordCountTimer.current) clearTimeout(wordCountTimer.current);
    },
    [],
  );

  // --- save / compile ------------------------------------------------------
  const autoCompileRef = useRef(autoCompile);
  autoCompileRef.current = autoCompile;

  const doSave = useCallback(async (): Promise<boolean> => {
    const content = viewRef.current?.state.doc.toString() ?? contentRef.current;
    setSaving(true);
    const ok = await onSave(content);
    setSaving(false);
    if (ok) {
      lastSavedRef.current = content;
      contentRef.current = content;
      setIsDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
    return ok;
  }, [onSave]);

  const handleCompile = useCallback(async () => {
    if (compilingRef.current) return;
    compilingRef.current = true;
    setCompiling(true);
    try {
      const docText = viewRef.current?.state.doc.toString() ?? contentRef.current;
      if (docText !== lastSavedRef.current) {
        const ok = await doSave();
        if (!ok) return;
      }
      const magic = parseMagicComments(docText);
      const target = magic.root ? resolveRelative(path, magic.root) : path;
      const result = await onCompile(target, engine);
      setLogText(result.log);
      const snapshot = viewRef.current?.state.doc ?? null;
      const items = parseCompileDiagnostics(result.log ?? "", name);
      if (snapshot) diagRef.current = { doc: snapshot, items };
      setErrorCount(items.filter((i) => i.severity === "error").length || result.errors.length);
      setWarningCount(items.filter((i) => i.severity === "warning").length);
      if (viewRef.current) forceLinting(viewRef.current);
      if (result.success && result.pdf_path) {
        setPdfPath(result.pdf_path);
        setPdfKey((k) => k + 1);
        setLogOpen(false);
      } else {
        setLogOpen(true);
      }
    } finally {
      compilingRef.current = false;
      setCompiling(false);
    }
  }, [doSave, onCompile, path, engine, name]);

  const handleSave = useCallback(async () => {
    const ok = await doSave();
    if (ok && autoCompileRef.current) void handleCompile();
  }, [doSave, handleCompile]);

  const handleSaveRef = useRef(handleSave);
  const handleCompileRef = useRef(handleCompile);
  handleSaveRef.current = handleSave;
  handleCompileRef.current = handleCompile;

  const toggleAutoCompile = useCallback(() => {
    setAutoCompile((v) => {
      localStorage.setItem(AUTOCOMPILE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // --- snippet inserts ------------------------------------------------------
  const handleSnippet = useCallback((action: SnippetAction) => {
    const view = viewRef.current;
    if (!view) return;
    if (action.kind === "wrap") {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: [
          { from, insert: action.before },
          { from: to, insert: action.after },
        ],
        selection: {
          anchor: from + action.before.length,
          head: to + action.before.length,
        },
      });
    } else {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const insert = (line.length > 0 ? "\n" : "") + action.text;
      view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
      });
    }
    view.focus();
  }, []);

  // --- editor extensions ----------------------------------------------------
  const texLang = useMemo(() => loadLanguage("tex"), []);

  const texLinter = useMemo(
    () =>
      linter(
        (view) => {
          const snap = diagRef.current;
          if (!snap || !snap.doc.eq(view.state.doc)) return [];
          const doc = view.state.doc;
          return snap.items.map((it): Diagnostic => {
            const lineNo = Math.max(1, Math.min(it.line, doc.lines));
            const ln = doc.line(lineNo);
            return {
              from: ln.from,
              to: ln.to,
              severity: it.severity,
              message: it.message,
            };
          });
        },
        { delay: 300 },
      ),
    [],
  );

  const extensions = useMemo(() => {
    return [
      ...(texLang ? [texLang] : []),
      EditorView.lineWrapping,
      lintGutter(),
      texLinter,
      keymap.of([
        { key: "Mod-s", run: () => { handleSaveRef.current(); return true; }, preventDefault: true },
        { key: "Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
        { key: "Shift-Mod-Enter", run: () => { handleCompileRef.current(); return true; } },
      ]),
    ];
  }, [texLang, texLinter]);

  // --- resizable split pane ---------------------------------------------------
  const dividerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const parent = dividerRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(25, Math.min(75, pct)));
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <div className="flex h-full flex-col">
      <LatexToolbar
        compiling={compiling}
        saving={saving}
        saved={saved}
        isDirty={isDirty}
        engine={engine}
        onEngineChange={setEngine}
        onCompile={handleCompile}
        onSave={handleSave}
        onDiscard={onDiscard}
        errorCount={errorCount}
        warningCount={warningCount}
        hasPdf={pdfPath !== null}
        hasLog={logText !== null}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
        autoCompile={autoCompile}
        onToggleAutoCompile={toggleAutoCompile}
        wordCount={wordCount}
        modKey={modKey}
        onSnippet={handleSnippet}
      />

      <div className={cn("flex flex-1 min-h-0", dragging && "select-none")}>
        {/* Editor pane */}
        <div className="flex min-w-0 flex-col overflow-hidden" style={{ width: `${splitPct}%` }}>
          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-0">
              <CodeMirror
                value={initialContent}
                onChange={handleChange}
                onCreateEditor={(view) => { viewRef.current = view; }}
                extensions={extensions}
                theme={resolvedTheme === "dark" ? githubDark : githubLight}
                height="100%"
                className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  foldGutter: true,
                  autocompletion: false,
                  bracketMatching: true,
                  indentOnInput: true,
                  tabSize: 2,
                }}
              />
            </div>
          </div>

          <LogPanel
            log={logText ?? ""}
            open={logOpen}
            onClose={() => setLogOpen(false)}
            filter={logFilter}
            onFilterChange={setLogFilter}
          />
        </div>

        {/* Resize divider */}
        <div
          ref={dividerRef}
          className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border transition-colors hover:bg-blue-400 active:bg-blue-500"
          onMouseDown={() => setDragging(true)}
        >
          <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-blue-400" />
        </div>

        {/* PDF pane (iframe — replaced by LatexPdfPane in a later task) */}
        <div className="flex min-w-0 flex-1 flex-col bg-muted/5">
          {pdfPath ? (
            <iframe
              key={pdfKey}
              src={`${rawFileUrl(pdfPath)}&_t=${pdfKey}`}
              title="PDF Preview"
              className="h-full w-full"
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
                <FileTextIcon className="size-6 text-muted-foreground/30" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">No PDF yet</p>
                <p className="text-xs text-muted-foreground/60">
                  Press{" "}
                  <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                    {modKey}↵
                  </kbd>{" "}
                  to compile
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

Create `web/src/components/latex/index.ts`:

```ts
export { LatexEditor, type LatexEditorProps } from "./latex-editor";
```

- [ ] **Step 5: Delete the old component and rewire `file-preview-panel.tsx`**

```bash
rm web/src/components/latex-editor.tsx
```

In `web/src/components/file-preview-panel.tsx`:

1. Replace `import { LatexEditor } from "@/components/latex-editor";` with:

```ts
import dynamic from "next/dynamic";

const LatexEditor = dynamic(
  () => import("@/components/latex").then((m) => m.LatexEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading LaTeX editor…
      </div>
    ),
  },
);
```

(Place the `const LatexEditor = dynamic(...)` at module scope, after the imports.)

2. Dark theme for the other editors: add `githubDark` to the theme import (`import { githubDark, githubLight } from "@uiw/codemirror-theme-github";`) and `import { useTheme } from "next-themes";`. In **both** the read-only CodeMirror (line ~341, inside its component — add `const { resolvedTheme } = useTheme();` at that component's top) and `TextEditor` (line ~1123), change `theme={githubLight}` to:

```tsx
theme={resolvedTheme === "dark" ? githubDark : githubLight}
```

Also fix TextEditor's hardcoded shortcut label (line ~1099): replace `⌘S to save` with a computed label — add at the top of `TextEditor`:

```ts
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
```

and use `{isMac ? "⌘S" : "Ctrl+S"} to save`.

- [ ] **Step 6: Verify + commit**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean.

Manual check: open a `.tex` file → Edit. Editor loads (lazy chunk), dark mode follows the app theme toggle, typing feels instant, ⌘S saves, ⌘↵ compiles (iframe preview still), errors show in gutter, warnings appear amber, log panel filters, word count ticks, snippet buttons insert, auto-compile checkbox persists across reloads.

```bash
git add -A web/src/components/latex web/src/components/file-preview-panel.tsx web/src/lib/use-sandbox.ts
git rm --cached web/src/components/latex-editor.tsx 2>/dev/null || true
git commit -m "refactor(latex-web): modular latex editor shell with perf, theme, warnings, QoL"
```

---

### Task 11: Outline panel + breadcrumb

**Files:**
- Create: `web/src/components/latex/outline-panel.tsx`
- Modify: `web/src/components/latex/latex-editor.tsx`
- Modify: `web/src/components/latex/latex-toolbar.tsx`
- Test: `web/src/components/latex/outline-panel.test.tsx`

**Interfaces:**
- Consumes: Task 6 `parseOutline`/`breadcrumbFor`/`OutlineItem`.
- Produces: `OutlinePanel({ items, currentLine, onJump }: { items: OutlineItem[]; currentLine: number; onJump: (line: number) => void })` — memoized.

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/latex/outline-panel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OutlineItem } from "@/lib/latex/outline";
import { OutlinePanel } from "./outline-panel";

const ITEMS: OutlineItem[] = [
  { kind: "section", title: "Intro", line: 3, depth: 2 },
  { kind: "subsection", title: "Background", line: 5, depth: 3 },
  { kind: "figure", title: "A plot", line: 7, depth: 4 },
];

describe("OutlinePanel", () => {
  it("renders items and jumps on click", () => {
    const onJump = vi.fn();
    render(<OutlinePanel items={ITEMS} currentLine={5} onJump={onJump} />);
    fireEvent.click(screen.getByText("Intro"));
    expect(onJump).toHaveBeenCalledWith(3);
  });
  it("shows an empty state without items", () => {
    render(<OutlinePanel items={[]} currentLine={1} onJump={() => {}} />);
    expect(screen.getByText(/no sections yet/i)).toBeTruthy();
  });
});
```

Run: `cd web && npx vitest run src/components/latex/outline-panel.test.tsx` — expect FAIL (module not found).

- [ ] **Step 2: Implement `web/src/components/latex/outline-panel.tsx`**

```tsx
"use client";

import type { OutlineItem } from "@/lib/latex/outline";
import { cn } from "@/lib/utils";
import { HashIcon, ImageIcon, TableIcon } from "lucide-react";
import { memo, useMemo } from "react";

function iconFor(kind: OutlineItem["kind"]) {
  if (kind === "figure") return <ImageIcon className="size-3 shrink-0" />;
  if (kind === "table") return <TableIcon className="size-3 shrink-0" />;
  return <HashIcon className="size-3 shrink-0" />;
}

export const OutlinePanel = memo(function OutlinePanel({
  items,
  currentLine,
  onJump,
}: {
  items: OutlineItem[];
  currentLine: number;
  onJump: (line: number) => void;
}) {
  // The "current" item is the last one at or before the cursor line.
  const currentIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].line <= currentLine) idx = i;
      else break;
    }
    return idx;
  }, [items, currentLine]);

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-hidden border-r bg-muted/10">
      <div className="shrink-0 border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Outline
      </div>
      <div className="flex-1 overflow-auto py-1">
        {items.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/60">
            No sections yet — add a \section to see the outline.
          </p>
        )}
        {items.map((item, i) => (
          <button
            key={`${item.line}:${item.title}`}
            onClick={() => onJump(item.line)}
            className={cn(
              "flex w-full items-center gap-1.5 truncate px-2 py-1 text-left text-[11px] transition-colors hover:bg-muted",
              i === currentIdx ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
            style={{ paddingLeft: `${8 + item.depth * 10}px` }}
            title={item.title}
          >
            {iconFor(item.kind)}
            <span className="truncate">{item.title || "(untitled)"}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
```

- [ ] **Step 3: Wire into the shell**

In `web/src/components/latex/latex-editor.tsx`:

1. Add imports:

```ts
import { breadcrumbFor, parseOutline, type OutlineItem } from "@/lib/latex/outline";
import { OutlinePanel } from "./outline-panel";
```

2. Add state near the other state (`const OUTLINE_KEY = "kady:latex:outline";` next to `AUTOCOMPILE_KEY`):

```ts
  const [outline, setOutline] = useState<OutlineItem[]>(() => parseOutline(initialContent));
  const [outlineOpen, setOutlineOpen] = useState(
    () => typeof localStorage === "undefined" || localStorage.getItem(OUTLINE_KEY) !== "0",
  );
  const [cursorLine, setCursorLine] = useState(1);
  const breadcrumb = useMemo(() => breadcrumbFor(outline, cursorLine), [outline, cursorLine]);
```

3. Extend `handleChange`'s debounce to also re-parse the outline — replace the `setTimeout` body:

```ts
    wordCountTimer.current = setTimeout(() => {
      setWordCount(proseWordCount(value));
      setOutline(parseOutline(value));
    }, 1000);
```

4. Cursor tracking + jump. Add after `handleSnippet`:

```ts
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackCursor = useCallback((line: number) => {
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    cursorTimer.current = setTimeout(() => setCursorLine(line), 150);
  }, []);
  const trackCursorRef = useRef(trackCursor);
  trackCursorRef.current = trackCursor;

  const jumpToLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const ln = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: ln.from },
      effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
    });
    view.focus();
  }, []);

  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => {
      localStorage.setItem(OUTLINE_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);
```

5. Add the cursor listener to `extensions` (inside the `useMemo` array, after `texLinter`):

```ts
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) {
          trackCursorRef.current(u.state.doc.lineAt(u.state.selection.main.head).number);
        }
      }),
```

6. Layout: inside the split-pane flex div, render the panel before the editor pane:

```tsx
        {outlineOpen && (
          <OutlinePanel items={outline} currentLine={cursorLine} onJump={jumpToLine} />
        )}
```

7. Breadcrumb strip: inside the editor pane column, above the CodeMirror wrapper:

```tsx
          {breadcrumb.length > 0 && (
            <div className="flex shrink-0 items-center gap-1 truncate border-b bg-muted/20 px-3 py-1 text-[10px] text-muted-foreground">
              {breadcrumb.map((b, i) => (
                <span key={`${b.line}`} className="flex items-center gap-1 truncate">
                  {i > 0 && <span className="text-muted-foreground/40">›</span>}
                  <button className="truncate hover:text-foreground" onClick={() => jumpToLine(b.line)}>
                    {b.title}
                  </button>
                </span>
              ))}
            </div>
          )}
```

8. Toolbar toggle: in `latex-toolbar.tsx` add to `LatexToolbarProps`:

```ts
  outlineOpen: boolean;
  onToggleOutline: () => void;
```

add `ListTreeIcon` to the lucide import, and render right before the status section:

```tsx
      <button
        onClick={p.onToggleOutline}
        className={cn(
          "rounded p-1 transition-colors hover:bg-muted",
          p.outlineOpen ? "text-foreground" : "text-muted-foreground",
        )}
        title="Toggle outline"
      >
        <ListTreeIcon className="size-3.5" />
      </button>
```

and in the shell pass `outlineOpen={outlineOpen} onToggleOutline={toggleOutline}` to `<LatexToolbar …>`.

- [ ] **Step 4: Verify + commit**

Run: `cd web && npx vitest run src/components/latex/outline-panel.test.tsx && npx tsc --noEmit`
Expected: PASS, clean.

Manual: outline lists sections/floats, click jumps + centers, breadcrumb follows the cursor, toggle persists.

```bash
git add web/src/components/latex web/src/lib/latex
git commit -m "feat(latex-web): outline panel with breadcrumb navigation"
```

---

### Task 12: Autocomplete integration (+ .bib key cache)

**Files:**
- Create: `web/src/lib/latex/api.ts`
- Modify: `web/src/components/latex/latex-editor.tsx`

**Interfaces:**
- `api.ts` produces (extended by Tasks 14/15):
  - `readSandboxFile(path: string): Promise<string | null>`

- [ ] **Step 1: Create `web/src/lib/latex/api.ts`**

```ts
/** Thin client helpers for the LaTeX editor's backend endpoints. */
import { apiFetch } from "@/lib/projects";

export async function readSandboxFile(path: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/sandbox/file?path=${encodeURIComponent(path)}`);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Wire autocomplete into the shell**

In `web/src/components/latex/latex-editor.tsx`:

1. Imports:

```ts
import { autocompletion } from "@codemirror/autocomplete";
import { latexCompletionSource, scanBibFiles, scanBibKeys } from "@/lib/latex/completions";
import { resolveRelative } from "@/lib/latex/magic-comments"; // already imported — merge
import { readSandboxFile } from "@/lib/latex/api";
```

2. Bib key cache — add near `diagRef`:

```ts
  const bibKeysRef = useRef<string[]>([]);
  const refreshBibKeys = useCallback(async () => {
    const doc = viewRef.current?.state.doc.toString() ?? contentRef.current;
    const files = scanBibFiles(doc);
    if (!files.length) {
      bibKeysRef.current = [];
      return;
    }
    const keys: string[] = [];
    for (const f of files) {
      const text = await readSandboxFile(resolveRelative(path, f));
      if (text) keys.push(...scanBibKeys(text));
    }
    bibKeysRef.current = [...new Set(keys)];
  }, [path]);

  useEffect(() => {
    void refreshBibKeys();
  }, [refreshBibKeys]);
```

3. Refresh after every compile — in `handleCompile`, right after `setLogText(result.log);` add:

```ts
      void refreshBibKeys();
```

and add `refreshBibKeys` to `handleCompile`'s dependency array.

4. Completion extension — in the `extensions` `useMemo`, add after `lintGutter()`:

```ts
      autocompletion({
        override: [latexCompletionSource({ getBibKeys: () => bibKeysRef.current })],
        activateOnTyping: true,
        maxRenderedOptions: 60,
      }),
```

(the `basicSetup.autocompletion: false` stays — we supply our own instance).

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean.

Manual: typing `\se` offers `\section{}`; `\begin{fig` completes the environment and inserts `\end{figure}`; with a `\label{fig:x}` in the doc, `\ref{` lists `fig:x`; with `\bibliography{refs}` and a `refs.bib` beside the file, `\cite{` lists its keys; the `figure`/`table` snippets expand with tab-stops.

```bash
git add web/src/lib/latex/api.ts web/src/components/latex/latex-editor.tsx
git commit -m "feat(latex-web): latex autocomplete with ref/cite scanning"
```

---

### Task 13: Spell check integration

**Files:**
- Modify: `web/src/components/latex/latex-editor.tsx`
- Modify: `web/src/components/latex/latex-toolbar.tsx`

- [ ] **Step 1: Wire the spell checker into the shell**

In `web/src/components/latex/latex-editor.tsx`:

1. Imports:

```ts
import {
  createSpellWorker,
  latexSpellLinter,
  type SpellWorkerClient,
} from "@/lib/latex/spellcheck";
```

2. Constants + state. Next to the other keys add `const SPELLCHECK_KEY = "kady:latex:spellcheck";` and (per-project custom dictionary, per the spec) add the import `import { getActiveProjectId } from "@/lib/projects";`:

```ts
  const [spellcheck, setSpellcheck] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(SPELLCHECK_KEY) === "1",
  );
  const spellWorkerRef = useRef<SpellWorkerClient | null>(null);
  const ignoredRef = useRef<Set<string>>(new Set());
  const dictKey = `kady:latex:dict:${getActiveProjectId()}`;
  const dictKeyRef = useRef(dictKey);
  dictKeyRef.current = dictKey;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(dictKeyRef.current);
      if (raw) ignoredRef.current = new Set(JSON.parse(raw) as string[]);
    } catch { /* corrupted store — start fresh */ }
  }, []);

  useEffect(() => {
    if (!spellcheck) return;
    spellWorkerRef.current = createSpellWorker();
    return () => {
      spellWorkerRef.current?.dispose();
      spellWorkerRef.current = null;
    };
  }, [spellcheck]);

  const addToDictionary = useCallback((word: string) => {
    ignoredRef.current.add(word.toLowerCase());
    localStorage.setItem(dictKeyRef.current, JSON.stringify([...ignoredRef.current]));
    if (viewRef.current) forceLinting(viewRef.current);
  }, []);

  const toggleSpellcheck = useCallback(() => {
    setSpellcheck((v) => {
      localStorage.setItem(SPELLCHECK_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  const spellExt = useMemo(
    () =>
      latexSpellLinter({
        client: () => spellWorkerRef.current,
        ignored: () => ignoredRef.current,
        onAddWord: addToDictionary,
      }),
    [addToDictionary],
  );
```

3. In the `extensions` `useMemo`: add `...(spellcheck ? [spellExt] : []),` after the `autocompletion(...)` entry and add `spellcheck, spellExt` to the dependency array.

4. Pass to the toolbar: `spellcheck={spellcheck} onToggleSpellcheck={toggleSpellcheck}`.

- [ ] **Step 2: Toolbar toggle**

In `latex-toolbar.tsx` add props:

```ts
  spellcheck: boolean;
  onToggleSpellcheck: () => void;
```

add `SpellCheckIcon` to the lucide import and render next to the outline toggle:

```tsx
      <button
        onClick={p.onToggleSpellcheck}
        className={cn(
          "rounded p-1 transition-colors hover:bg-muted",
          p.spellcheck ? "text-foreground" : "text-muted-foreground",
        )}
        title="Toggle spell check"
      >
        <SpellCheckIcon className="size-3.5" />
      </button>
```

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean.

Manual: enable spellcheck (toggle) → type "helo wrold" in prose → dotted underlines appear after ~1s; hovering shows suggestions; clicking a suggestion replaces the word; "Add to dictionary" persists across reloads; `\commandnames` and `$math$` are never flagged; typing stays smooth (dictionary lives in the worker).

```bash
git add web/src/components/latex
git commit -m "feat(latex-web): toggleable in-editor spell check"
```

---

### Task 14: PDF pane replacement + two-way SyncTeX

**Files:**
- Create: `web/src/components/latex/latex-pdf-pane.tsx`
- Modify: `web/src/lib/latex/api.ts` (synctex helpers)
- Modify: `web/src/components/latex/latex-editor.tsx`
- Modify: `web/src/components/latex/latex-toolbar.tsx` (Jump-to-PDF button)
- Modify: `web/src/components/file-preview-panel.tsx` (pass `onOpenFile`)

**Interfaces:**
- `api.ts` additions:

```ts
export type SynctexBoxDto = { page: number; h: number; v: number; W: number; H: number };
export type SynctexLocDto = { file: string | null; line: number; column: number };
export async function fetchSynctexForward(tex: string, line: number, pdf: string): Promise<SynctexBoxDto | "unavailable" | null>;
export async function fetchSynctexInverse(pdf: string, page: number, x: number, y: number): Promise<SynctexLocDto | "unavailable" | null>;
```

`"unavailable"` on HTTP 424, `null` on 404/other failures.

- [ ] **Step 1: Add synctex helpers to `web/src/lib/latex/api.ts`**

```ts
export type SynctexBoxDto = { page: number; h: number; v: number; W: number; H: number };
export type SynctexLocDto = { file: string | null; line: number; column: number };

async function synctexRequest<T>(params: URLSearchParams): Promise<T | "unavailable" | null> {
  try {
    const res = await apiFetch(`/sandbox/synctex?${params.toString()}`);
    if (res.status === 424) return "unavailable";
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchSynctexForward(
  tex: string,
  line: number,
  pdf: string,
): Promise<SynctexBoxDto | "unavailable" | null> {
  return synctexRequest<SynctexBoxDto>(
    new URLSearchParams({ dir: "forward", path: tex, line: String(line), col: "0", pdf }),
  );
}

export function fetchSynctexInverse(
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexLocDto | "unavailable" | null> {
  return synctexRequest<SynctexLocDto>(
    new URLSearchParams({
      dir: "inverse", pdf, page: String(page), x: x.toFixed(2), y: y.toFixed(2),
    }),
  );
}
```

- [ ] **Step 2: Create `web/src/components/latex/latex-pdf-pane.tsx`**

```tsx
"use client";

import {
  PdfViewer,
  type PdfSyncClick,
  type PdfSyncHighlight,
} from "@/components/pdf-viewer/pdf-viewer";
import { FileTextIcon } from "lucide-react";
import { memo } from "react";

export const LatexPdfPane = memo(function LatexPdfPane({
  pdfPath,
  reloadToken,
  syncHighlight,
  onSyncClick,
  modKey,
}: {
  pdfPath: string | null;
  reloadToken: number;
  syncHighlight: PdfSyncHighlight | null;
  onSyncClick: (pos: PdfSyncClick) => void;
  modKey: string;
}) {
  if (!pdfPath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
          <FileTextIcon className="size-6 text-muted-foreground/30" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">No PDF yet</p>
          <p className="text-xs text-muted-foreground/60">
            Press{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              {modKey}↵
            </kbd>{" "}
            to compile
          </p>
        </div>
      </div>
    );
  }
  return (
    <PdfViewer
      path={pdfPath}
      reloadToken={reloadToken}
      syncHighlight={syncHighlight}
      onSyncClick={onSyncClick}
      hideAnnotationUi
      className="flex-1 min-h-0"
    />
  );
});
```

- [ ] **Step 3: Replace the iframe in the shell + add sync handlers**

In `web/src/components/latex/latex-editor.tsx`:

1. Imports — remove `rawFileUrl` (no longer used) and add:

```ts
import { fetchSynctexForward, fetchSynctexInverse } from "@/lib/latex/api";
import type { PdfSyncClick, PdfSyncHighlight } from "@/components/pdf-viewer/pdf-viewer";
import { LatexPdfPane } from "./latex-pdf-pane";
```

Add `onOpenFile` to the destructured props of `LatexEditor` (it's already in `LatexEditorProps`).

2. State: rename `pdfKey`/`setPdfKey` to `reloadToken`/`setReloadToken` everywhere in the file, and add:

```ts
  const [syncHighlight, setSyncHighlight] = useState<PdfSyncHighlight | null>(null);
  const [synctexOk, setSynctexOk] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const syncTokenRef = useRef(0);
```

3. In `handleCompile`, right before the `if (result.success …)` block, add `setSynctexOk(result.synctex);`. (Forward sync always queries with the *current file's* path — synctex maps per input file, so this works for `% !TEX root` children too.)

4. Sync handlers (after `jumpToLine`):

```ts
  const showSyncNotice = useCallback((msg: string) => {
    setSyncNotice(msg);
    setTimeout(() => setSyncNotice(null), 4000);
  }, []);

  const jumpToPdf = useCallback(async () => {
    const view = viewRef.current;
    const pdf = pdfPathRef.current;
    if (!view || !pdf) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const box = await fetchSynctexForward(path, line, pdf);
    if (box === "unavailable" || box === null) {
      showSyncNotice(box === "unavailable" ? "SyncTeX not available (recompile first)" : "No PDF location found for this line");
      return;
    }
    setSyncHighlight({ ...box, token: ++syncTokenRef.current });
  }, [path, showSyncNotice]);
  const jumpToPdfRef = useRef(jumpToPdf);
  jumpToPdfRef.current = jumpToPdf;

  const handleSyncClick = useCallback(
    async (pos: PdfSyncClick) => {
      const pdf = pdfPathRef.current;
      if (!pdf) return;
      const loc = await fetchSynctexInverse(pdf, pos.page, pos.x, pos.y);
      if (loc === "unavailable" || loc === null || !loc.file) {
        showSyncNotice("No source location found");
        return;
      }
      if (loc.file === path) {
        jumpToLine(loc.line);
      } else if (onOpenFile) {
        onOpenFile(loc.file);
        showSyncNotice(`Source is in ${loc.file}:${loc.line}`);
      } else {
        showSyncNotice(`Source is in ${loc.file}:${loc.line}`);
      }
    },
    [path, jumpToLine, onOpenFile, showSyncNotice],
  );
```

`pdfPathRef` keeps callbacks stable — add next to the pdf state:

```ts
  const pdfPathRef = useRef<string | null>(null);
  useEffect(() => { pdfPathRef.current = pdfPath; }, [pdfPath]);
```

5. Keybinding — add to the keymap array in `extensions`:

```ts
        { key: "Mod-Alt-j", run: () => { jumpToPdfRef.current(); return true; } },
```

6. Replace the whole iframe/empty-state PDF pane block with:

```tsx
        <div className="flex min-w-0 flex-1 flex-col bg-muted/5">
          {syncNotice && (
            <div className="shrink-0 border-b bg-blue-500/10 px-3 py-1 text-[11px] text-blue-700 dark:text-blue-300">
              {syncNotice}
            </div>
          )}
          <LatexPdfPane
            pdfPath={pdfPath}
            reloadToken={reloadToken}
            syncHighlight={syncHighlight}
            onSyncClick={handleSyncClick}
            modKey={modKey}
          />
        </div>
```

7. Toolbar button: in `latex-toolbar.tsx` add props

```ts
  syncAvailable: boolean;
  onJumpToPdf: () => void;
```

add `CrosshairIcon` to the lucide import and render next to the spellcheck toggle:

```tsx
      <button
        onClick={p.onJumpToPdf}
        disabled={!p.syncAvailable}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
        title={p.syncAvailable ? "Jump to PDF (SyncTeX)" : "SyncTeX unavailable — compile first"}
      >
        <CrosshairIcon className="size-3.5" />
      </button>
```

and in the shell pass `syncAvailable={synctexOk && pdfPath !== null} onJumpToPdf={jumpToPdf}`.

- [ ] **Step 4: Pass `onOpenFile` from the preview panel**

In `web/src/components/file-preview-panel.tsx`, at the `<LatexEditor …>` callsite add:

```tsx
              onOpenFile={onTabSelect}
```

(`onTabSelect` reaches page.tsx's `handleFileSelect`, which opens arbitrary sandbox paths.)

- [ ] **Step 5: Verify + commit**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean.

Manual (needs a compiled doc): compile → pdf.js pane renders with zoom/page controls; recompile after an edit → **scroll position survives, no white flash**; put the cursor on a paragraph → ⌘⌥J (or the crosshair button) scrolls the PDF and flashes a blue box on the right area; ⌘-click a PDF paragraph → the editor jumps to and centers that line; with a multi-file doc (`% !TEX root`), ⌘-click on content from another file opens that file and shows the notice.

```bash
git add web/src/components/latex web/src/lib/latex/api.ts web/src/components/file-preview-panel.tsx
git commit -m "feat(latex-web): pdf.js preview pane with two-way synctex"
```

---

### Task 15: AI assist — Cmd+K edits and Fix-with-AI

**Files:**
- Modify: `web/package.json` (add `@codemirror/merge`)
- Modify: `web/src/lib/latex/api.ts` (assist helper)
- Create: `web/src/components/latex/ai-edit-popover.tsx`
- Modify: `web/src/components/latex/latex-editor.tsx`
- Modify: `web/src/components/latex/log-panel.tsx` (Fix buttons on error lines)
- Test: `web/src/lib/latex/assist-helpers.test.ts` + create `web/src/lib/latex/assist-helpers.ts`

**Interfaces:**
- `assist-helpers.ts` (pure, tested):
  - `buildFixPayload(doc: string, fileName: string, line: number, message: string): { mode: "fix"; fileName: string; preamble: string; error: { line: number; message: string }; context: { startLine: number; endLine: number; text: string } }` — context = ±40 lines clamped; preamble = lines up to `\begin{document}` capped at 120.
  - `lineRangeToOffsets(doc: string, startLine: number, endLine: number): { from: number; to: number }`
- `api.ts` addition:
  - `postLatexAssist(body: object, signal?: AbortSignal): Promise<{ replacement: string; model: string; costUsd: number }>` — throws `LatexAssistError` (exported class with `status`, `message`) on non-2xx, mapping the server's `{ detail, message }`.
- `ai-edit-popover.tsx`: `AiEditPopover({ anchor: { x: number; y: number }, busy, error, onSubmit: (instruction: string) => void, onCancel })`.
- Shell review flow: applying a proposal dispatches the text change and turns on `unifiedMergeView({ original, mergeControls: true })`; a banner offers **Keep all** / **Revert all**; per-chunk accept/reject renders via merge controls.

- [ ] **Step 1: Install dep, write failing helper tests**

```bash
cd web && npm install @codemirror/merge
```

Create `web/src/lib/latex/assist-helpers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFixPayload, lineRangeToOffsets } from "./assist-helpers";

const DOC = ["\\documentclass{article}", "\\usepackage{amsmath}", "\\begin{document}",
  ...Array.from({ length: 100 }, (_, i) => `line ${i + 4}`), "\\end{document}"].join("\n");

describe("buildFixPayload", () => {
  it("clamps context to ±40 lines and includes the preamble", () => {
    const p = buildFixPayload(DOC, "main.tex", 50, "Undefined control sequence.");
    expect(p.context.startLine).toBe(10);
    expect(p.context.endLine).toBe(90);
    expect(p.context.text.split("\n")).toHaveLength(81);
    expect(p.preamble).toContain("amsmath");
    expect(p.preamble).not.toContain("line 4");
    expect(p.error).toEqual({ line: 50, message: "Undefined control sequence." });
  });
  it("clamps at document edges", () => {
    const p = buildFixPayload("a\nb\nc", "x.tex", 1, "err");
    expect(p.context.startLine).toBe(1);
    expect(p.context.endLine).toBe(3);
  });
});

describe("lineRangeToOffsets", () => {
  it("maps 1-based line ranges to character offsets", () => {
    expect(lineRangeToOffsets("ab\ncd\nef", 2, 3)).toEqual({ from: 3, to: 8 });
    expect(lineRangeToOffsets("ab\ncd\nef", 1, 1)).toEqual({ from: 0, to: 2 });
  });
});
```

Run: `cd web && npx vitest run src/lib/latex/assist-helpers.test.ts` — expect FAIL.

- [ ] **Step 2: Implement `web/src/lib/latex/assist-helpers.ts`**

```ts
/** Pure request-shaping helpers for the latex-assist endpoint. */

const CONTEXT_RADIUS = 40;
const PREAMBLE_MAX_LINES = 120;

export function lineRangeToOffsets(
  doc: string,
  startLine: number,
  endLine: number,
): { from: number; to: number } {
  const lines = doc.split("\n");
  let from = 0;
  for (let i = 0; i < startLine - 1; i++) from += lines[i].length + 1;
  let to = from;
  for (let i = startLine - 1; i < endLine; i++) to += lines[i].length + 1;
  return { from, to: Math.min(to - 1, doc.length) };
}

export function extractPreamble(doc: string): string {
  const idx = doc.indexOf("\\begin{document}");
  const head = idx >= 0 ? doc.slice(0, idx) : "";
  return head.split("\n").slice(0, PREAMBLE_MAX_LINES).join("\n").trim();
}

export function buildFixPayload(
  doc: string,
  fileName: string,
  line: number,
  message: string,
) {
  const total = doc.split("\n").length;
  const startLine = Math.max(1, line - CONTEXT_RADIUS);
  const endLine = Math.min(total, line + CONTEXT_RADIUS);
  const { from, to } = lineRangeToOffsets(doc, startLine, endLine);
  return {
    mode: "fix" as const,
    fileName,
    preamble: extractPreamble(doc),
    error: { line, message },
    context: { startLine, endLine, text: doc.slice(from, to) },
  };
}
```

Run: `cd web && npx vitest run src/lib/latex/assist-helpers.test.ts` — expect PASS.

- [ ] **Step 3: Add the assist API helper**

In `web/src/lib/latex/api.ts` add:

```ts
export class LatexAssistError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LatexAssistResult {
  replacement: string;
  model: string;
  costUsd: number;
}

export async function postLatexAssist(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LatexAssistResult> {
  const res = await apiFetch(`/sandbox/latex-assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let message = `AI assist failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string; detail?: string };
      message = data.message ?? data.detail ?? message;
    } catch { /* non-JSON error body */ }
    throw new LatexAssistError(res.status, message);
  }
  return (await res.json()) as LatexAssistResult;
}
```

- [ ] **Step 4: Create `web/src/components/latex/ai-edit-popover.tsx`**

```tsx
"use client";

import { LoaderCircleIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function AiEditPopover({
  anchor,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  anchor: { x: number; y: number };
  busy: boolean;
  error: string | null;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div
      className="fixed z-50 w-80 rounded-lg border bg-background p-2 shadow-xl"
      style={{
        left: Math.min(anchor.x, window.innerWidth - 340),
        top: Math.min(anchor.y + 8, window.innerHeight - 120),
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim() && !busy) onSubmit(instruction.trim());
        }}
        className="flex items-center gap-1.5"
      >
        <SparklesIcon className="size-3.5 shrink-0 text-violet-500" />
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          placeholder="Edit selection… e.g. “convert to a booktabs table”"
          disabled={busy}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <button type="submit" className="rounded bg-violet-600 px-2 py-0.5 text-[11px] text-white hover:bg-violet-700">
            Go
          </button>
        )}
        <button type="button" onClick={onCancel} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <XIcon className="size-3" />
        </button>
      </form>
      {error && <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Wire the review flow into the shell**

In `web/src/components/latex/latex-editor.tsx`:

1. Imports:

```ts
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { LatexAssistError, postLatexAssist } from "@/lib/latex/api"; // merge into existing api import
import { buildFixPayload, extractPreamble, lineRangeToOffsets } from "@/lib/latex/assist-helpers";
import { AiEditPopover } from "./ai-edit-popover";
```

2. State:

```ts
  const [aiPopover, setAiPopover] = useState<{ x: number; y: number } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiReview, setAiReview] = useState<{ original: string; costUsd: number } | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
```

3. Core apply-as-review helper + flows (after the sync handlers):

```ts
  const startReview = useCallback((from: number, to: number, replacement: string, costUsd: number) => {
    const view = viewRef.current;
    if (!view) return;
    const original = view.state.doc.toString();
    view.dispatch({ changes: { from, to, insert: replacement } });
    setAiReview({ original, costUsd });
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  }, []);

  const finishReview = useCallback((revert: boolean) => {
    const view = viewRef.current;
    if (view && revert) {
      const original = getOriginalDoc(view.state).toString();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
    }
    setAiReview(null);
    viewRef.current?.focus();
  }, []);

  const runAiEdit = useCallback(
    async (instruction: string) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const selection = view.state.sliceDoc(from, to);
      setAiBusy(true);
      setAiError(null);
      aiAbortRef.current = new AbortController();
      try {
        const res = await postLatexAssist(
          {
            mode: "edit", fileName: name, instruction, selection,
            preamble: extractPreamble(view.state.doc.toString()),
          },
          aiAbortRef.current.signal,
        );
        setAiPopover(null);
        startReview(from, to, res.replacement, res.costUsd);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setAiError(err instanceof LatexAssistError ? err.message : "AI edit failed");
      } finally {
        setAiBusy(false);
      }
    },
    [name, startReview],
  );

  const fixWithAi = useCallback(
    async (line: number, message: string) => {
      const view = viewRef.current;
      if (!view || aiBusy) return;
      const doc = view.state.doc.toString();
      const payload = buildFixPayload(doc, name, line, message);
      setAiBusy(true);
      aiAbortRef.current = new AbortController();
      try {
        const res = await postLatexAssist(payload, aiAbortRef.current.signal);
        const { from, to } = lineRangeToOffsets(
          doc, payload.context.startLine, payload.context.endLine,
        );
        startReview(from, to, res.replacement, res.costUsd);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        showSyncNotice(err instanceof LatexAssistError ? err.message : "AI fix failed");
      } finally {
        setAiBusy(false);
      }
    },
    [name, aiBusy, startReview, showSyncNotice],
  );
  const fixWithAiRef = useRef(fixWithAi);
  fixWithAiRef.current = fixWithAi;

  const openAiPopover = useCallback(() => {
    const view = viewRef.current;
    if (!view) return false;
    const { from, to, head } = view.state.selection.main;
    if (from === to) return false;
    const coords = view.coordsAtPos(head);
    if (coords) {
      setAiError(null);
      setAiPopover({ x: coords.left, y: coords.bottom });
    }
    return true;
  }, []);
  const openAiPopoverRef = useRef(openAiPopover);
  openAiPopoverRef.current = openAiPopover;
```

4. Add "Fix with AI" as a diagnostic action — in `texLinter`, change the returned `Diagnostic` map to include actions for errors:

```ts
          return snap.items.map((it): Diagnostic => {
            const lineNo = Math.max(1, Math.min(it.line, doc.lines));
            const ln = doc.line(lineNo);
            return {
              from: ln.from,
              to: ln.to,
              severity: it.severity,
              message: it.message,
              actions:
                it.severity === "error"
                  ? [{
                      name: "✦ Fix with AI",
                      apply: () => fixWithAiRef.current(it.line, it.message),
                    }]
                  : undefined,
            };
          });
```

5. Keybinding + merge extension — in `extensions` add to the keymap array:

```ts
        { key: "Mod-k", run: () => openAiPopoverRef.current(), preventDefault: true },
```

and append to the extension array (with `aiReview` added to the memo deps):

```ts
      ...(aiReview
        ? [unifiedMergeView({ original: aiReview.original, mergeControls: true })]
        : []),
```

6. Review banner — render inside the editor pane column, above the CodeMirror wrapper (next to the breadcrumb strip):

```tsx
          {aiReview && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-violet-500/10 px-3 py-1 text-[11px] text-violet-700 dark:text-violet-300">
              <SparklesIcon className="size-3" />
              AI edit applied — review the highlighted chunks
              {aiReview.costUsd > 0 && <span className="text-muted-foreground">· ${aiReview.costUsd.toFixed(4)}</span>}
              <span className="flex-1" />
              <button onClick={() => finishReview(false)} className="rounded bg-violet-600 px-2 py-0.5 text-white hover:bg-violet-700">
                Keep all
              </button>
              <button onClick={() => finishReview(true)} className="rounded border px-2 py-0.5 hover:bg-muted">
                Revert all
              </button>
            </div>
          )}
```

(add `SparklesIcon` to the lucide import in the shell.)

7. Popover — render at the end of the root div:

```tsx
      {aiPopover && (
        <AiEditPopover
          anchor={aiPopover}
          busy={aiBusy}
          error={aiError}
          onSubmit={runAiEdit}
          onCancel={() => {
            aiAbortRef.current?.abort();
            setAiPopover(null);
          }}
        />
      )}
```

8. Log-panel fix buttons — in `log-panel.tsx` add an optional prop `onFixError?: (line: number, message: string) => void;` and, when rendering a line matching `/^(?:\.\/)?\S+?:(\d+):\s*(.+)$/`, append:

```tsx
            {onFixError && errMatch && (
              <button
                onClick={() => onFixError(parseInt(errMatch[1], 10), errMatch[2])}
                className="ml-2 rounded bg-violet-600/90 px-1.5 text-[10px] text-white hover:bg-violet-600"
              >
                Fix with AI
              </button>
            )}
```

(compute `const errMatch = /^(?:\.\/)?\S+?:(\d+):\s*(.+)$/.exec(line);` inside the map). Pass `onFixError={fixWithAi}` from the shell's `<LogPanel …>`.

- [ ] **Step 6: Verify + commit**

Run: `cd web && npx vitest run src/lib/latex/assist-helpers.test.ts && npx tsc --noEmit && npm test`
Expected: PASS, clean.

Manual (OPENROUTER_API_KEY set): select a sentence → ⌘K → "make this two sentences" → inline diff appears with per-chunk ✓/✗ controls + banner cost; Keep all / Revert all behave; break the doc → compile → hover the gutter diagnostic → "✦ Fix with AI" → proposed fix appears as a diff; a project at its spend limit gets the budget message instead.

```bash
git add web/package.json web/package-lock.json web/src/lib/latex web/src/components/latex
git commit -m "feat(latex-web): AI assist — Cmd+K edits and fix-with-AI with diff review"
```

---

### Task 16: Ask Kady — chat prefill handoff

**Files:**
- Modify: `web/src/components/latex/latex-toolbar.tsx` (Ask Kady button)
- Modify: `web/src/components/latex/latex-editor.tsx` (dispatch)
- Modify: `web/src/components/chat-tab.tsx` (listener in `ChatInput`)

**Interfaces:**
- `window` CustomEvent `"kady:prefill-chat"` with `detail: { text: string }`. Only the **active** chat tab's composer consumes it (appends + does not submit).

- [ ] **Step 1: Toolbar button + dispatch**

In `latex-toolbar.tsx` add prop `onAskKady: () => void;`, add `MessageCircleIcon` to the lucide import, and render after the Jump-to-PDF button:

```tsx
      <button
        onClick={p.onAskKady}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-500/10 dark:text-violet-400"
        title="Ask Kady about this document in chat"
      >
        <MessageCircleIcon className="size-3.5" /> Ask Kady
      </button>
```

In the shell add and pass:

```ts
  const askKady = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("kady:prefill-chat", {
        detail: { text: `Regarding @${path}: ` },
      }),
    );
  }, [path]);
```

`onAskKady={askKady}` on `<LatexToolbar …>`.

- [ ] **Step 2: Listener in the active chat composer**

In `web/src/components/chat-tab.tsx`:

1. Add `isActive: boolean;` to `ChatInput`'s props type and destructuring (the component starting `function ChatInput({` at line ~321).
2. Inside `ChatInput` (after `const controller = usePromptInputController();`):

```ts
  useEffect(() => {
    if (!isActive) return;
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      const current = controller.textInput.value;
      const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? "\n" : "";
      controller.textInput.setInput(current + sep + text);
    };
    window.addEventListener("kady:prefill-chat", onPrefill);
    return () => window.removeEventListener("kady:prefill-chat", onPrefill);
  }, [isActive, controller]);
```

(ensure `useEffect` is imported in that file — it already is.)
3. At the `<ChatInput` callsite (line ~1078), pass `isActive={isActive}` — the enclosing `ChatTab` component already receives `isActive` (prop declared at line ~767).

- [ ] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean.

Manual: open a .tex editor, click "Ask Kady" → the active chat tab's composer gains `Regarding @path/to/file.tex: ` (existing draft preserved on a new line); the `@path` renders like a file mention when sent; inactive tabs unaffected.

```bash
git add web/src/components/latex web/src/components/chat-tab.tsx
git commit -m "feat(latex-web): Ask Kady chat handoff from the editor"
```

---

### Task 17: Docs, full verification, cleanup

**Files:**
- Modify: `AGENTS.md` (architecture line 52 — sandbox API description)
- Modify: `docs/file-previews.md` (LaTeX section, if present — check with `grep -n -i latex docs/file-previews.md`)

- [ ] **Step 1: Update docs**

In `AGENTS.md` item 7 ("Sandbox API + scientific previews"), replace the phrase `and LaTeX compile` with:

```
LaTeX compile (async latexmk/multi-pass with SyncTeX), `/sandbox/synctex` (source<->PDF mapping), and the budget-gated `/sandbox/latex-assist` one-shot AI endpoint (ledgered under session id `latex-assist`)
```

In `docs/file-previews.md`, update the LaTeX entry (if one exists) to mention: split-pane editor with autocomplete, outline, spell check, two-way SyncTeX pdf.js preview, AI fix/edit, Ask Kady.

- [ ] **Step 2: Full verification suite**

```bash
cd server && npm run typecheck && npm test
cd ../web && npx tsc --noEmit && npm test && npm run build
```

Expected: all clean. `next build` matters here — it validates the dynamic import + worker bundling under Turbopack.

- [ ] **Step 3: End-to-end manual pass (multi-file paper)**

Create `projects/default/sandbox/paper/` with:

`main.tex`:
```latex
\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}
\begin{document}
\title{Kady Demo}\author{K-Dense}\maketitle
\section{Introduction}
Hello \ref{sec:methods} and \cite{smith2020}. A tyop here.
\input{methods}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
```

`methods.tex`:
```latex
% !TEX root = main.tex
\section{Methods}\label{sec:methods}
We used $E = mc^2$ extensively.
```

`refs.bib`:
```bibtex
@article{smith2020, author={Smith, J}, title={Things}, journal={J. Stuff}, year={2020}}
```

Checklist (app running):
1. Open `main.tex` → Edit: compile succeeds, PDF renders in pdf.js pane, bibliography resolves (multi-pass/latexmk).
2. Edit → recompile: PDF keeps scroll position.
3. `\ref{` completes `sec:methods`; `\cite{` completes `smith2020`.
4. Outline shows both sections (Introduction, Methods via input? — Methods appears only when editing methods.tex; verify outline in each file); breadcrumb follows cursor.
5. Spellcheck flags "tyop"; suggestion fixes it; "Add to dictionary" persists.
6. ⌘⌥J from a line → PDF flashes the right spot; ⌘-click the Methods paragraph in the PDF → opens `methods.tex` (cross-file notice).
7. Open `methods.tex` → Edit: compiles via `% !TEX root` (PDF is main.pdf).
8. Break a command → compile → red gutter diagnostic → "✦ Fix with AI" produces a reviewable diff; ⌘K on a selection rewrites it; costs appear; `latex-assist` rows land in `projects/default/sandbox/.kady/runs/latex-assist/costs.jsonl`.
9. "Ask Kady" prefills the chat composer.
10. Toggle app dark mode → editor + toolbar follow.
11. While a compile runs, chat streaming stays responsive (async spawn — no event-loop stall).

- [ ] **Step 4: Commit docs + any fixups**

```bash
git add AGENTS.md docs/file-previews.md
git commit -m "docs: latex power editor — synctex, AI assist, capability notes"
```

---

## Plan self-review notes (kept for the executor)

- **Spec coverage:** bugs 1-9 → Tasks 1/3/10; autocomplete → 7/12; outline → 6/11; spellcheck → 8/13; snippets/auto-compile/word-count/`!TEX root` → 7/10; pdf.js + SyncTeX → 2/3/9/14; AI fix/edit/Ask-Kady + ledger/budget → 4/15/16; perf (event loop, keystroke re-render, `.eq()`, lazy pages, dynamic import, worker) → 1/9/10/8; docs/testing → every task + 17.
- **Deliberate deviations from spec wording:** none of substance; the spec's "reloadToken/syncHighlight/onSyncClick" trio gained a fourth presentational prop (`hideAnnotationUi`) because the annotation sidebar takes 16rem of a split pane.
- Commit messages: append the standard co-author trailer from the global constraints to every commit block above.



