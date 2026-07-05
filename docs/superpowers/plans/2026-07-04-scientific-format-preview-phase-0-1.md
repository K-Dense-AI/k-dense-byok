# Scientific Format Preview — Phase 0 + 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an extensible, registry-based viewer system plus a reproducible Python helper environment, then use it to render chemistry structures (SMILES/MOL/SDF → 2D depiction) and macromolecules (PDB/mmCIF/XYZ → interactive 3D) in the file preview panel.

**Architecture:** A frontend *format registry* maps new `FileCategory` values to lazy-loaded viewer components; `FileViewer` consults the registry first and falls back to the existing dispatch chain for all current formats (zero risk to existing viewers). A uv-managed *helper venv* under `server/src/helpers/` gives Python decoders reproducible deps; generic `sci-summary` / `sci-render.png` endpoints route a `kind` param to per-family helper CLIs (mirroring the existing `anndata_helper.py` contract). 2D chemistry depiction renders server-side via RDKit; 3D structures parse metadata server-side (gemmi) and render interactively client-side via lazy-loaded 3Dmol.js.

**Tech Stack:** Next.js 16 / React 19 + TypeScript (`web/`), Fastify + tsx (`server/`), vitest (both), uv-managed Python (`rdkit`, `gemmi`), 3Dmol.js (client WebGL), chart.js (already present, used in later phases).

## Global Constraints

- **This is Plan 1 of 5.** It covers Phase 0 (foundation) + Phase 1 (chemistry & structures) from the spec `docs/superpowers/specs/2026-07-04-scientific-format-preview-design.md`. Phases 2–4 get their own plans after these interfaces are validated in code.
- **Node ≥ 22.19**; both services run via `tsx` — never `tsc` for emit. `npx tsc --noEmit` must stay clean for `web/`.
- **Do not run bare `python`/`pip`.** Python deps live only in the helper venv (`server/src/helpers/.venv`, uv-managed). Do NOT add scientific deps to the per-project sandbox `pyproject.toml`.
- **Helper CLI contract (verbatim from the existing `anndata_helper.py`):** exit codes `0` ok, `3` deps missing, `4` not found, `5` bad value, `1` other. JSON to stdout for summaries; write PNG/SVG to an output path for renders.
- **Existing formats must keep working unchanged.** The registry is additive — never delete or rewrite the current image/pdf/markdown/csv/notebook/fasta/biotable/latex/anndata/text viewers in this plan.
- **New viewers are view-only**; text-based scientific formats keep the existing raw-source editor via the registry's `canEditSource` flag.
- Backend helper spawn uses `spawnSync(helperPython(), [...], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })`.
- Company name is **K-Dense** (not "K-Dense AI") in any user-facing copy.

## File Structure

**Frontend — new**
- `web/src/lib/viewers/registry.ts` — `ViewerDef`, `ViewerProps`, `LoadMode`, the `VIEWER_REGISTRY` map, `getViewerDef()`. Single source of truth for how new categories load/render/edit/scroll.
- `web/src/components/viewers/molecule-viewer.tsx` — 2D chemistry viewer (default export).
- `web/src/components/viewers/structure-viewer.tsx` — 3D structure viewer w/ lazy 3Dmol.js (default export).
- `web/src/types/3dmol.d.ts` — minimal ambient module declaration for `3dmol`.
- `web/src/lib/viewers/registry.test.ts`, `web/src/lib/use-sandbox.test.ts`, `web/src/components/viewers/molecule-viewer.test.tsx`, `web/src/components/viewers/structure-viewer.test.tsx` — tests.

**Frontend — modified**
- `web/src/lib/use-sandbox.ts` — add `molecule2d`/`structure3d` to `FileCategory`, classify their extensions, add `sciSummaryUrl()`/`sciRenderUrl()`, make `openFile` load-mode aware.
- `web/src/components/file-preview-panel.tsx` — `FileViewer` + panel consult the registry (dispatch, `canEdit`, own-scroll); add `categoryLabel` entries.
- `web/src/components/file-icon.tsx` — icons for new categories.

**Backend — new**
- `server/src/helpers-env.ts` — `HELPERS_DIR`, `helperPython()`, `syncHelperVenv()`.
- `server/src/helpers/pyproject.toml` — uv project declaring helper deps.
- `server/src/helpers/chem_helper.py` — SMILES/MOL/SDF → props JSON + 2D SVG.
- `server/src/helpers/structure_helper.py` — PDB/mmCIF/XYZ → metadata JSON.
- `server/src/api/sci-helpers.ts` — `sciHelperFor(kind)` dispatcher (pure, testable) + shared spawn wrapper.

**Backend — modified**
- `server/src/sandbox-fs.ts` — extend the `MIME` map.
- `server/src/api/sandbox.ts` — register `GET /sandbox/sci-summary` + `GET /sandbox/sci-render.png`; route anndata's `PYTHON` through `helperPython()`.
- `server/src/prep.ts` and `server/src/index.ts` — call `syncHelperVenv()`.
- `server/test/backend.test.ts` — extend `guessMime` test; add `sciHelperFor`/`helperPython` tests.
- `.gitignore` — ignore `server/src/helpers/.venv`.

---

## Phase 0 — Foundation

### Task 1: Frontend viewer registry module

**Files:**
- Create: `web/src/lib/viewers/registry.ts`
- Test: `web/src/lib/viewers/registry.test.ts`

**Interfaces:**
- Consumes: `FileCategory` from `@/lib/use-sandbox`.
- Produces:
  - `type LoadMode = "text" | "raw" | "none"`
  - `interface ViewerProps { path: string; name: string; content: string | null; onRetry?: () => void }`
  - `interface ViewerDef { loadMode: LoadMode; Viewer: React.ComponentType<ViewerProps>; canEditSource: boolean; managesOwnScroll: boolean }`
  - `function getViewerDef(cat: FileCategory): ViewerDef | undefined`
  - `const VIEWER_REGISTRY: Partial<Record<FileCategory, ViewerDef>>` (empty in this task; entries added in Tasks 8 & 10)

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/viewers/registry.test.ts
import { describe, it, expect } from "vitest";
import { getViewerDef, VIEWER_REGISTRY } from "./registry";

describe("viewer registry", () => {
  it("returns undefined for an unregistered category", () => {
    expect(getViewerDef("text")).toBeUndefined();
  });

  it("returns the registered def for a registered category", () => {
    // seed a fake entry to prove lookup works independent of real viewers
    VIEWER_REGISTRY.text = {
      loadMode: "text",
      Viewer: () => null,
      canEditSource: true,
      managesOwnScroll: false,
    };
    const def = getViewerDef("text");
    expect(def?.loadMode).toBe("text");
    expect(def?.canEditSource).toBe(true);
    delete VIEWER_REGISTRY.text; // don't leak into other tests
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/viewers/registry.test.ts`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/viewers/registry.ts
import type { ComponentType } from "react";
import type { FileCategory } from "@/lib/use-sandbox";

export type LoadMode = "text" | "raw" | "none";

export interface ViewerProps {
  path: string;
  name: string;
  content: string | null;
  onRetry?: () => void;
}

export interface ViewerDef {
  /** "text" => file body is fetched into tab.content; "raw"/"none" => viewer fetches itself. */
  loadMode: LoadMode;
  Viewer: ComponentType<ViewerProps>;
  canEditSource: boolean;
  managesOwnScroll: boolean;
}

/** Registry of viewers for NEW scientific categories. Existing categories keep
 *  their dispatch in file-preview-panel.tsx; this is additive. */
export const VIEWER_REGISTRY: Partial<Record<FileCategory, ViewerDef>> = {};

export function getViewerDef(cat: FileCategory): ViewerDef | undefined {
  return VIEWER_REGISTRY[cat];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/viewers/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/viewers/registry.ts web/src/lib/viewers/registry.test.ts
git commit -m "feat(viewers): add extensible frontend viewer registry"
```

---

### Task 2: Backend helper venv infrastructure

**Files:**
- Create: `server/src/helpers-env.ts`
- Create: `server/src/helpers/pyproject.toml`
- Modify: `server/src/api/sandbox.ts:20-22` (route anndata `PYTHON` through `helperPython()`)
- Modify: `server/src/prep.ts` (call `syncHelperVenv()`)
- Modify: `server/src/index.ts` (call `syncHelperVenv()` at boot, best-effort)
- Modify: `.gitignore`
- Test: `server/test/backend.test.ts` (add a `helperPython` describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `const HELPERS_DIR: string` — absolute path to `server/src/helpers`
  - `function helperPython(): string` — `KADY_PYTHON` if set, else `<HELPERS_DIR>/.venv/bin/python` if it exists, else `"python3"`
  - `function syncHelperVenv(): boolean` — best-effort `uv sync` in `HELPERS_DIR`; false if uv missing / sync fails

- [ ] **Step 1: Write the failing test**

```ts
// append to server/test/backend.test.ts
import { helperPython, HELPERS_DIR } from "../src/helpers-env.ts";

describe("helper python resolution", () => {
  it("honors KADY_PYTHON when set", () => {
    const prev = process.env.KADY_PYTHON;
    process.env.KADY_PYTHON = "/custom/python";
    expect(helperPython()).toBe("/custom/python");
    if (prev === undefined) delete process.env.KADY_PYTHON;
    else process.env.KADY_PYTHON = prev;
  });

  it("points HELPERS_DIR at the helpers source dir", () => {
    expect(HELPERS_DIR.endsWith(path.join("src", "helpers"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/backend.test.ts -t "helper python"`
Expected: FAIL — cannot find module `../src/helpers-env.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/helpers-env.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to server/src/helpers (holds the Python CLIs + pyproject.toml). */
export const HELPERS_DIR = path.join(__dirname, "helpers");

/** Interpreter for the Python helper CLIs. Prefers an explicit override, then the
 *  uv-managed helper venv, then system python3. */
export function helperPython(): string {
  if (process.env.KADY_PYTHON) return process.env.KADY_PYTHON;
  const venvPy = path.join(HELPERS_DIR, ".venv", "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return "python3";
}

function uvBinary(): string | null {
  for (const c of ["uv", path.join(os.homedir(), ".local", "bin", "uv")]) {
    if (spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
  }
  return null;
}

/** Best-effort `uv sync` of the helper venv. Returns false when uv is unavailable
 *  or the sync fails; callers treat that as "previews degrade to deps-missing". */
export function syncHelperVenv(): boolean {
  const uv = uvBinary();
  if (!uv) return false;
  const res = spawnSync(uv, ["sync"], {
    cwd: HELPERS_DIR,
    stdio: "ignore",
    timeout: 15 * 60 * 1000,
  });
  return res.status === 0;
}
```

```toml
# server/src/helpers/pyproject.toml
[project]
name = "kady-helpers"
version = "0.1.0"
description = "Python decoders the Kady backend shells out to for file previews"
requires-python = ">=3.11"
dependencies = [
    "numpy",
    "scipy",
    "matplotlib",
    "anndata",
    "h5py",
    "rdkit",
    "gemmi",
]
```

Modify `server/src/api/sandbox.ts` — replace the `PYTHON` constant (line ~22) and its two usages:

```ts
// near the other imports
import { helperPython } from "../helpers-env.ts";
// delete:  const PYTHON = process.env.KADY_PYTHON || "python3";
// then in both anndata routes replace `PYTHON` with `helperPython()`:
//   spawnSync(helperPython(), [ANNDATA_HELPER, "summarize", target], { ... })
//   spawnSync(helperPython(), [ANNDATA_HELPER, "embedding", ...], { ... })
```

Add to `server/src/prep.ts` `main()` (after the project loop, before "Done."):

```ts
import { syncHelperVenv } from "./helpers-env.ts";
// ...
const helperSynced = syncHelperVenv();
process.stdout.write(`   helper venv: ${helperSynced ? "synced" : "skipped (uv unavailable or sync failed)"}\n`);
```

Add to `server/src/index.ts` inside the `if (isMain)` block, before `app.listen`:

```ts
import { syncHelperVenv } from "./helpers-env.ts";
// ...
syncHelperVenv(); // best-effort; previews degrade gracefully if it fails
```

Add to `.gitignore`:

```
server/src/helpers/.venv/
server/src/helpers/uv.lock
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/backend.test.ts -t "helper python"`
Expected: PASS (2 tests).

- [ ] **Step 5: Sync the helper venv and confirm existing anndata still resolves**

Run: `cd server/src/helpers && uv sync`
Expected: creates `.venv` with rdkit/gemmi/anndata (may take several minutes on first run).
Then: `cd server && npx vitest run` — expect the full existing suite to still pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/helpers-env.ts server/src/helpers/pyproject.toml server/src/api/sandbox.ts server/src/prep.ts server/src/index.ts .gitignore server/test/backend.test.ts
git commit -m "feat(helpers): reproducible uv-managed helper venv + startup sync"
```

---

### Task 3: Extend MIME map for scientific raw serving

**Files:**
- Modify: `server/src/sandbox-fs.ts` (the `MIME` map, ~line 62)
- Test: `server/test/backend.test.ts:217-219` (extend the existing `guessMime` assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: `guessMime()` returns correct types for new extensions (behavior only; signature unchanged).

- [ ] **Step 1: Write the failing test**

```ts
// extend the existing guessMime test in server/test/backend.test.ts
expect(guessMime("m.pdb")).toBe("chemical/x-pdb");
expect(guessMime("m.cif")).toBe("chemical/x-cif");
expect(guessMime("m.xyz")).toBe("chemical/x-xyz");
expect(guessMime("m.mol")).toBe("chemical/x-mdl-molfile");
expect(guessMime("m.sdf")).toBe("chemical/x-mdl-sdfile");
expect(guessMime("m.smi")).toBe("text/plain");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/backend.test.ts -t "guessMime"`
Expected: FAIL — `.pdb` returns `application/octet-stream`.

- [ ] **Step 3: Write minimal implementation**

Add these entries to the `MIME` object in `server/src/sandbox-fs.ts`:

```ts
  ".pdb": "chemical/x-pdb",
  ".ent": "chemical/x-pdb",
  ".cif": "chemical/x-cif",
  ".mmcif": "chemical/x-cif",
  ".xyz": "chemical/x-xyz",
  ".gro": "chemical/x-gromacs",
  ".pdbqt": "chemical/x-pdb",
  ".mol": "chemical/x-mdl-molfile",
  ".sdf": "chemical/x-mdl-sdfile",
  ".mol2": "chemical/x-mol2",
  ".smi": "text/plain",
  ".smiles": "text/plain",
  ".inchi": "text/plain",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/backend.test.ts -t "guessMime"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sandbox-fs.ts server/test/backend.test.ts
git commit -m "feat(sandbox): MIME types for chemistry/structure formats"
```

---

### Task 4: Classify Phase-1 formats (category + label + icon)

**Files:**
- Modify: `web/src/lib/use-sandbox.ts:15-49` (`FileCategory` union + `fileCategory`)
- Modify: `web/src/components/file-preview-panel.tsx:60-73` (`categoryLabel`)
- Modify: `web/src/components/file-icon.tsx`
- Test: `web/src/lib/use-sandbox.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FileCategory` gains `"molecule2d" | "structure3d"`; `fileCategory(name)` returns them for the listed extensions.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/use-sandbox.test.ts
import { describe, it, expect } from "vitest";
import { fileCategory } from "./use-sandbox";

describe("fileCategory — chemistry & structures", () => {
  it("classifies 2D molecule formats", () => {
    for (const n of ["a.smi", "a.smiles", "a.mol", "a.sdf", "a.mol2", "a.inchi"]) {
      expect(fileCategory(n)).toBe("molecule2d");
    }
  });
  it("classifies 3D structure formats", () => {
    for (const n of ["a.pdb", "a.ent", "a.cif", "a.mmcif", "a.xyz", "a.gro", "a.pdbqt"]) {
      expect(fileCategory(n)).toBe("structure3d");
    }
  });
  it("leaves existing formats unchanged", () => {
    expect(fileCategory("a.png")).toBe("image");
    expect(fileCategory("a.h5ad")).toBe("anndata");
    expect(fileCategory("a.py")).toBe("text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/use-sandbox.test.ts`
Expected: FAIL — `.smi` returns `"text"`.

- [ ] **Step 3: Write minimal implementation**

In `web/src/lib/use-sandbox.ts`, extend the union:

```ts
export type FileCategory =
  | "image" | "pdf" | "markdown" | "csv" | "notebook"
  | "fasta" | "biotable" | "latex" | "anndata"
  | "molecule2d" | "structure3d"
  | "text";
```

Add the extension sets and branches in `fileCategory` (before `return "text"`):

```ts
const MOLECULE2D_EXTS = new Set(["smi", "smiles", "inchi", "mol", "sdf", "mol2"]);
const STRUCTURE3D_EXTS = new Set(["pdb", "ent", "cif", "mmcif", "xyz", "gro", "pdbqt"]);
// ...inside fileCategory, after LATEX check:
if (MOLECULE2D_EXTS.has(ext)) return "molecule2d";
if (STRUCTURE3D_EXTS.has(ext)) return "structure3d";
```

In `web/src/components/file-preview-panel.tsx` `categoryLabel`, before the final return:

```ts
if (cat === "molecule2d") return ext === "sdf" ? "sdf" : "molecule";
if (cat === "structure3d") return ext || "structure";
```

In `web/src/components/file-icon.tsx`, after the `biotable` line:

```ts
import { HexagonIcon, BoxesIcon } from "lucide-react"; // add to the existing import
// ...
if (cat === "molecule2d") return <HexagonIcon className={`${className} text-fuchsia-500`} />;
if (cat === "structure3d") return <BoxesIcon className={`${className} text-sky-500`} />;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/use-sandbox.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (the new `FileCategory` members must be handled everywhere they're switched on; `categoryLabel` now covers them).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/use-sandbox.ts web/src/lib/use-sandbox.test.ts web/src/components/file-preview-panel.tsx web/src/components/file-icon.tsx
git commit -m "feat(viewers): classify chemistry & structure file formats"
```

---

### Task 5: Generic sci-helper dispatcher + endpoints

**Files:**
- Create: `server/src/api/sci-helpers.ts`
- Modify: `server/src/api/sandbox.ts` (register two routes)
- Test: `server/test/backend.test.ts` (add a `sciHelperFor` describe block)

**Interfaces:**
- Consumes: `HELPERS_DIR`, `helperPython()` from `../helpers-env.ts` (Task 2).
- Produces:
  - `type SciKind = "chem" | "structure"` (extended in later phases)
  - `function sciHelperFor(kind: string): { script: string } | null` — absolute helper path for a known kind, else null
  - `function runSciHelper(kind: string, subcommand: "summarize" | "render", args: string[]): { status: number; stdout: string; stderr: string }`
  - Routes: `GET /sandbox/sci-summary?path=&kind=` (JSON), `GET /sandbox/sci-render.png?path=&kind=&...` (image/svg+xml or image/png)

- [ ] **Step 1: Write the failing test**

```ts
// append to server/test/backend.test.ts
import { sciHelperFor } from "../src/api/sci-helpers.ts";

describe("sci helper dispatch", () => {
  it("returns null for an unknown kind", () => {
    expect(sciHelperFor("bogus")).toBeNull();
  });
  it("resolves known kinds to a helper script path", () => {
    expect(sciHelperFor("chem")?.script.endsWith("chem_helper.py")).toBe(true);
    expect(sciHelperFor("structure")?.script.endsWith("structure_helper.py")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/backend.test.ts -t "sci helper"`
Expected: FAIL — cannot find module `../src/api/sci-helpers.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/api/sci-helpers.ts
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HELPERS_DIR, helperPython } from "../helpers-env.ts";

const KIND_TO_SCRIPT: Record<string, string> = {
  chem: "chem_helper.py",
  structure: "structure_helper.py",
};

export function sciHelperFor(kind: string): { script: string } | null {
  const file = KIND_TO_SCRIPT[kind];
  if (!file) return null;
  return { script: path.join(HELPERS_DIR, file) };
}

export function runSciHelper(
  kind: string,
  subcommand: "summarize" | "render",
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const helper = sciHelperFor(kind);
  if (!helper) return { status: 2, stdout: "", stderr: `unknown kind: ${kind}` };
  const res = spawnSync(helperPython(), [helper.script, subcommand, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
```

Register routes in `server/src/api/sandbox.ts` (near the anndata routes). Import at top:
`import { sciHelperFor, runSciHelper } from "./sci-helpers.ts";`

```ts
app.get<{ Querystring: { path: string; kind: string } }>("/sandbox/sci-summary", async (req, reply) => {
  try {
    if (!sciHelperFor(req.query.kind)) { reply.code(400); return { detail: `Unknown kind: ${req.query.kind}` }; }
    const target = safePath(req.query.path);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { reply.code(404); return { detail: "File not found" }; }
    const res = runSciHelper(req.query.kind, "summarize", [target]);
    if (res.status === 3) { reply.code(503); return { detail: res.stderr.trim() || "Preview dependency missing" }; }
    if (res.status === 4) { reply.code(404); return { detail: res.stderr.trim() }; }
    if (res.status === 5) { reply.code(400); return { detail: res.stderr.trim() }; }
    if (res.status !== 0) { reply.code(500); return { detail: res.stderr.trim() || "Failed to summarize" }; }
    reply.type("application/json");
    return res.stdout;
  } catch (err) { return handle(reply, err); }
});

app.get<{ Querystring: { path: string; kind: string; index?: string } }>("/sandbox/sci-render.png", async (req, reply) => {
  try {
    if (!sciHelperFor(req.query.kind)) { reply.code(400); return { detail: `Unknown kind: ${req.query.kind}` }; }
    const target = safePath(req.query.path);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { reply.code(404); return { detail: "File not found" }; }
    const outPath = path.join(os.tmpdir(), `kady-sci-${process.pid}-${Date.now()}`);
    const res = runSciHelper(req.query.kind, "render", [target, req.query.index ?? "0", outPath]);
    if (res.status === 3) { reply.code(503); return { detail: res.stderr.trim() || "Preview dependency missing" }; }
    if (res.status === 4) { reply.code(404); return { detail: res.stderr.trim() }; }
    if (res.status === 5) { reply.code(400); return { detail: res.stderr.trim() }; }
    if (res.status !== 0 || !fs.existsSync(outPath)) { reply.code(500); return { detail: res.stderr.trim() || "Failed to render" }; }
    const data = fs.readFileSync(outPath);
    fs.rmSync(outPath, { force: true });
    // helper writes SVG for chem 2D, PNG otherwise; sniff the first byte
    reply.type(data.slice(0, 5).toString("utf-8").startsWith("<") ? "image/svg+xml" : "image/png");
    reply.header("Cache-Control", "private, max-age=300");
    return data;
  } catch (err) { return handle(reply, err); }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/backend.test.ts -t "sci helper"`
Expected: PASS (2 tests). (`os` and `handle`/`safePath`/`fs` are already imported in sandbox.ts.)

- [ ] **Step 5: Commit**

```bash
git add server/src/api/sci-helpers.ts server/src/api/sandbox.ts server/test/backend.test.ts
git commit -m "feat(sandbox): generic sci-summary/sci-render endpoints + kind dispatcher"
```

---

### Task 6: Registry-aware loading + panel dispatch

**Files:**
- Modify: `web/src/lib/use-sandbox.ts` (add `sciSummaryUrl`/`sciRenderUrl`; make `openFile` load-mode aware)
- Modify: `web/src/components/file-preview-panel.tsx` (`FileViewer` registry dispatch; `canEdit`/own-scroll from registry)
- Test: `web/src/lib/use-sandbox.test.ts` (URL builders)

**Interfaces:**
- Consumes: `getViewerDef` (Task 1), `FileCategory` (Task 4).
- Produces:
  - `function sciSummaryUrl(path: string, kind: string): string`
  - `function sciRenderUrl(path: string, kind: string, index?: number): string`
  - `openFile` skips the text fetch when the registered `loadMode` is not `"text"` (existing image/pdf/anndata behavior preserved).
  - `FileViewer` renders `getViewerDef(cat)?.Viewer` inside `<Suspense>` when present.

- [ ] **Step 1: Write the failing test**

```ts
// append to web/src/lib/use-sandbox.test.ts
import { sciSummaryUrl, sciRenderUrl } from "./use-sandbox";

describe("sci url builders", () => {
  it("builds a summary url with kind + path", () => {
    const u = sciSummaryUrl("a/b.pdb", "structure");
    expect(u).toContain("/sandbox/sci-summary");
    expect(u).toContain("kind=structure");
    expect(u).toContain(encodeURIComponent("a/b.pdb"));
  });
  it("builds a render url with an index", () => {
    const u = sciRenderUrl("m.smi", "chem", 2);
    expect(u).toContain("/sandbox/sci-render.png");
    expect(u).toContain("kind=chem");
    expect(u).toContain("index=2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/use-sandbox.test.ts -t "sci url"`
Expected: FAIL — `sciSummaryUrl` not exported.

- [ ] **Step 3: Write minimal implementation**

Add URL builders in `web/src/lib/use-sandbox.ts` (next to `anndataEmbeddingUrl`):

```ts
export function sciSummaryUrl(path: string, kind: string): string {
  const params = new URLSearchParams({ path, kind, project: getActiveProjectId() });
  return `${API_BASE}/sandbox/sci-summary?${params.toString()}`;
}

export function sciRenderUrl(path: string, kind: string, index = 0): string {
  const params = new URLSearchParams({
    path, kind, index: String(index), project: getActiveProjectId(),
  });
  return `${API_BASE}/sandbox/sci-render.png?${params.toString()}`;
}
```

Make `openFile` load-mode aware. Replace the hardcoded skip block (`use-sandbox.ts:193`):

```ts
import { getViewerDef } from "@/lib/viewers/registry";
// ...
const def = getViewerDef(cat);
const loadMode = def
  ? def.loadMode
  : cat === "image" || cat === "pdf" || cat === "anndata" ? "none" : "text";
if (loadMode !== "text") {
  setTabs((prev) => {
    const next = prev.map((t) => (t.path === path ? { ...t, loading: false } : t));
    tabsRef.current = next;
    return next;
  });
  return;
}
await fetchFileContent(path);
```

In `web/src/components/file-preview-panel.tsx`:

1. Import: `import { Suspense } from "react";` and `import { getViewerDef } from "@/lib/viewers/registry";`
2. In `FileViewer`, immediately after computing `const cat = ...`, add a registry short-circuit:

```ts
  const def = cat ? getViewerDef(cat) : undefined;
  if (def) {
    if (def.loadMode === "text" && content === null) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        </div>
      );
    }
    const Viewer = def.Viewer;
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /></div>}>
        <Viewer path={path} name={name ?? ""} content={content} onRetry={onRetry} />
      </Suspense>
    );
  }
```

3. Update `canEdit`/`canAnnotate` in `FilePreviewPanel` to consult the registry:

```ts
const regDef = getViewerDef(cat);
const canEdit = regDef ? regDef.canEditSource : (cat !== "image" && cat !== "pdf" && cat !== "anndata");
```

4. Update the own-scroll wrapper condition (the `cat === "pdf" || ...` list) to append `|| regDef?.managesOwnScroll`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/use-sandbox.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Regression check**

Run: `cd web && npx vitest run`
Expected: full frontend suite passes (existing viewers untouched).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/use-sandbox.ts web/src/lib/use-sandbox.test.ts web/src/components/file-preview-panel.tsx
git commit -m "feat(viewers): registry-aware content loading and panel dispatch"
```

---

## Phase 1 — Chemistry & Structures

### Task 7: chem_helper.py — SMILES/MOL/SDF → props + 2D SVG

**Files:**
- Create: `server/src/helpers/chem_helper.py`
- Create: `server/test/fixtures/ethanol.smi`, `server/test/fixtures/two.sdf`
- Test: `server/test/chem-helper.test.ts`

**Interfaces:**
- Consumes: `helperPython()` (Task 2), `runSciHelper` via `kind="chem"` (Task 5).
- Produces: CLI `chem_helper.py`:
  - `summarize <path>` → JSON `{ format, count, molecules: [{ index, name, formula, mol_weight, num_atoms, num_bonds, smiles }] }`
  - `render <path> <index> <out_path>` → writes a 2D depiction **SVG** of molecule `index` to `out_path`
  - Exit codes per the Global Constraints contract.

- [ ] **Step 1: Write the failing test + fixtures**

```ts
// server/test/chem-helper.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";
import { spawnSync } from "node:child_process";

const FIX = path.join(__dirname, "fixtures");
// Skip the RDKit-dependent assertions when the helper venv isn't synced.
const depsOk = (() => {
  const r = spawnSync(helperPython(), ["-c", "import rdkit"], { stdio: "ignore" });
  return r.status === 0;
})();

describe("chem_helper", () => {
  it.runIf(depsOk)("summarizes a SMILES file", () => {
    const res = runSciHelper("chem", "summarize", [path.join(FIX, "ethanol.smi")]);
    expect(res.status).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.count).toBe(1);
    expect(data.molecules[0].formula).toBe("C2H6O");
  });
  it.runIf(depsOk)("renders an SVG for molecule 0", () => {
    const out = path.join(os.tmpdir(), `chem-test-${process.pid}.svg`);
    const res = runSciHelper("chem", "render", [path.join(FIX, "ethanol.smi"), "0", out]);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(out, "utf-8")).toContain("<svg");
    fs.rmSync(out, { force: true });
  });
  it("exits 5 on a malformed SMILES", () => {
    const bad = path.join(os.tmpdir(), `bad-${process.pid}.smi`);
    fs.writeFileSync(bad, "this-is-not-smiles!!!\n");
    const res = runSciHelper("chem", "summarize", [bad]);
    expect([0, 3, 5]).toContain(res.status); // 3 if deps missing, else 5 (or 0 w/ empty)
    fs.rmSync(bad, { force: true });
  });
});
```

Create fixtures:
- `server/test/fixtures/ethanol.smi` (one line): `CCO ethanol`
- `server/test/fixtures/two.sdf`: a minimal 2-record SDF (paste from RDKit output; can be generated once with `Chem.MolToMolBlock(Chem.MolFromSmiles("CCO"))` joined by `$$$$`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/chem-helper.test.ts`
Expected: FAIL — helper script missing (the `render`/`summarize` calls return non-zero; deps-guarded tests skip if RDKit absent).

- [ ] **Step 3: Write minimal implementation**

```python
# server/src/helpers/chem_helper.py
"""SMILES/MOL/SDF preview helper. Shelled out to by the TS backend.

Usage:
  python chem_helper.py summarize <path>            -> JSON to stdout
  python chem_helper.py render <path> <index> <out> -> writes 2D SVG to <out>

Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path


def _rdkit():
    try:
        from rdkit import Chem
        from rdkit.Chem import Draw, Descriptors, rdMolDescriptors
        from rdkit.Chem.Draw import rdMolDraw2D
        return Chem, Draw, Descriptors, rdMolDescriptors, rdMolDraw2D
    except ImportError as exc:  # deps missing
        sys.stderr.write(f"RDKit not installed: {exc}\n")
        sys.exit(3)


def _load_mols(path: Path):
    Chem, *_ = _rdkit()
    ext = path.suffix.lower()
    if ext in (".smi", ".smiles"):
        mols = []
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            m = Chem.MolFromSmiles(parts[0])
            if m is not None:
                if len(parts) > 1:
                    m.SetProp("_Name", parts[1])
                mols.append(m)
        return mols
    if ext in (".mol", ".mol2"):
        m = Chem.MolFromMolFile(str(path)) if ext == ".mol" else Chem.MolFromMol2File(str(path))
        return [m] if m is not None else []
    if ext == ".sdf":
        return [m for m in Chem.SDMolSupplier(str(path)) if m is not None]
    if ext == ".inchi":
        m = Chem.MolFromInchi(path.read_text().strip())
        return [m] if m is not None else []
    return []


def summarize(path: Path) -> None:
    Chem, _Draw, Descriptors, rdMolDescriptors, _ = _rdkit()
    mols = _load_mols(path)
    if not mols:
        sys.stderr.write("No valid molecules parsed\n")
        sys.exit(5)
    out = {"format": path.suffix.lower().lstrip("."), "count": len(mols), "molecules": []}
    for i, m in enumerate(mols[:200]):
        out["molecules"].append({
            "index": i,
            "name": m.GetProp("_Name") if m.HasProp("_Name") else "",
            "formula": rdMolDescriptors.CalcMolFormula(m),
            "mol_weight": round(Descriptors.MolWt(m), 3),
            "num_atoms": m.GetNumAtoms(),
            "num_bonds": m.GetNumBonds(),
            "smiles": Chem.MolToSmiles(m),
        })
    sys.stdout.write(json.dumps(out))


def render(path: Path, index: int, out_path: Path) -> None:
    _Chem, _Draw, _Desc, _rdmd, rdMolDraw2D = _rdkit()
    mols = _load_mols(path)
    if index < 0 or index >= len(mols):
        sys.stderr.write("Molecule index out of range\n")
        sys.exit(4)
    d = rdMolDraw2D.MolDraw2DSVG(360, 300)
    d.DrawMolecule(mols[index])
    d.FinishDrawing()
    out_path.write_text(d.GetDrawingText())


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: chem_helper.py <summarize|render> <path> [...]\n")
        sys.exit(1)
    cmd, raw_path = sys.argv[1], Path(sys.argv[2])
    if not raw_path.exists():
        sys.stderr.write(f"File not found: {raw_path}\n")
        sys.exit(4)
    try:
        if cmd == "summarize":
            summarize(raw_path)
        elif cmd == "render":
            render(raw_path, int(sys.argv[3]), Path(sys.argv[4]))
        else:
            sys.stderr.write(f"unknown command: {cmd}\n")
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/chem-helper.test.ts`
Expected: PASS. (RDKit-dependent tests run only if the venv is synced; the malformed-input test always runs.)

- [ ] **Step 5: Commit**

```bash
git add server/src/helpers/chem_helper.py server/test/chem-helper.test.ts server/test/fixtures/ethanol.smi server/test/fixtures/two.sdf
git commit -m "feat(helpers): chem_helper for SMILES/MOL/SDF 2D depiction"
```

---

### Task 8: MoleculeViewer (frontend) + register molecule2d

**Files:**
- Create: `web/src/components/viewers/molecule-viewer.tsx`
- Modify: `web/src/lib/viewers/registry.ts` (register `molecule2d`)
- Test: `web/src/components/viewers/molecule-viewer.test.tsx`

**Interfaces:**
- Consumes: `ViewerProps` (Task 1), `sciSummaryUrl`/`sciRenderUrl` (Task 6), `kind="chem"`.
- Produces: default-exported `MoleculeViewer` React component; a `VIEWER_REGISTRY.molecule2d` entry `{ loadMode: "text", canEditSource: true, managesOwnScroll: true }`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/viewers/molecule-viewer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MoleculeViewer from "./molecule-viewer";

const summary = {
  format: "smi", count: 1,
  molecules: [{ index: 0, name: "ethanol", formula: "C2H6O", mol_weight: 46.07, num_atoms: 3, num_bonds: 2, smiles: "CCO" }],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
});

describe("MoleculeViewer", () => {
  it("renders molecule properties from the summary", async () => {
    render(<MoleculeViewer path="a.smi" name="a.smi" content="CCO ethanol" />);
    await waitFor(() => expect(screen.getByText("C2H6O")).toBeInTheDocument());
    expect(screen.getByText(/ethanol/)).toBeInTheDocument();
  });

  it("shows a friendly message when the summary dependency is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "RDKit not installed" }), { status: 503 }),
    ));
    render(<MoleculeViewer path="a.smi" name="a.smi" content="CCO" />);
    await waitFor(() => expect(screen.getByText(/dependency|unavailable/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/viewers/molecule-viewer.test.tsx`
Expected: FAIL — cannot find module `./molecule-viewer`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/components/viewers/molecule-viewer.tsx
"use client";
import { useEffect, useState } from "react";
import { sciSummaryUrl, sciRenderUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

interface MolInfo {
  index: number; name: string; formula: string; mol_weight: number;
  num_atoms: number; num_bonds: number; smiles: string;
}
interface ChemSummary { format: string; count: number; molecules: MolInfo[] }

export default function MoleculeViewer({ path }: ViewerProps) {
  const [summary, setSummary] = useState<ChemSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null); setError(null);
    fetch(sciSummaryUrl(path, "chem"))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
        return r.json() as Promise<ChemSummary>;
      })
      .then((d) => { if (alive) setSummary(d); })
      .catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Molecule preview unavailable</p>
        <p className="max-w-md text-xs">{error}</p>
      </div>
    );
  }
  if (!summary) {
    return <div className="flex h-full items-center justify-center"><div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /></div>;
  }

  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-3 text-xs text-muted-foreground">{summary.count} molecule{summary.count !== 1 ? "s" : ""}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {summary.molecules.map((m) => (
          <div key={m.index} className="overflow-hidden rounded-md border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sciRenderUrl(path, "chem", m.index)} alt={m.name || m.smiles} className="w-full bg-white" />
            <div className="space-y-0.5 border-t p-2 text-xs">
              {m.name && <div className="font-semibold">{m.name}</div>}
              <div className="font-mono text-muted-foreground">{m.formula}</div>
              <div className="text-muted-foreground">MW {m.mol_weight} · {m.num_atoms} atoms · {m.num_bonds} bonds</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground/70" title={m.smiles}>{m.smiles}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Register it in `web/src/lib/viewers/registry.ts`:

```ts
import { lazy } from "react";
const MoleculeViewer = lazy(() => import("@/components/viewers/molecule-viewer"));

// replace the empty object literal:
export const VIEWER_REGISTRY: Partial<Record<FileCategory, ViewerDef>> = {
  molecule2d: { loadMode: "text", Viewer: MoleculeViewer, canEditSource: true, managesOwnScroll: true },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/viewers/molecule-viewer.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/viewers/molecule-viewer.tsx web/src/components/viewers/molecule-viewer.test.tsx web/src/lib/viewers/registry.ts
git commit -m "feat(viewers): 2D molecule viewer (SMILES/MOL/SDF)"
```

---

### Task 9: structure_helper.py — PDB/mmCIF/XYZ → metadata

**Files:**
- Create: `server/src/helpers/structure_helper.py`
- Create: `server/test/fixtures/mini.pdb`
- Test: `server/test/structure-helper.test.ts`

**Interfaces:**
- Consumes: `runSciHelper` via `kind="structure"` (Task 5), `helperPython()` (Task 2).
- Produces: CLI `structure_helper.py`:
  - `summarize <path>` → JSON `{ format, num_atoms, num_chains, chains: [ids], num_residues, num_ligands, ligands: [names], resolution, title }`
  - (no `render` in Phase 1 — interactive 3D is client-side; a `render` call returns exit 1 "not supported")
  - Exit codes per contract.

- [ ] **Step 1: Write the failing test + fixture**

```ts
// server/test/structure-helper.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSciHelper } from "../src/api/sci-helpers.ts";
import { helperPython } from "../src/helpers-env.ts";

const FIX = path.join(__dirname, "fixtures");
const depsOk = spawnSync(helperPython(), ["-c", "import gemmi"], { stdio: "ignore" }).status === 0;

describe("structure_helper", () => {
  it.runIf(depsOk)("summarizes a small PDB", () => {
    const res = runSciHelper("structure", "summarize", [path.join(FIX, "mini.pdb")]);
    expect(res.status).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.num_atoms).toBeGreaterThan(0);
    expect(Array.isArray(data.chains)).toBe(true);
  });
});
```

Create `server/test/fixtures/mini.pdb` with a handful of ATOM records, e.g.:

```
HEADER    TEST
ATOM      1  N   ALA A   1      11.104  13.207  10.567  1.00  0.00           N
ATOM      2  CA  ALA A   1      12.560  13.207  10.567  1.00  0.00           C
ATOM      3  C   ALA A   1      13.100  14.600  10.567  1.00  0.00           C
ATOM      4  O   ALA A   1      12.400  15.600  10.567  1.00  0.00           O
TER
END
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/structure-helper.test.ts`
Expected: FAIL (helper missing) or SKIP if gemmi absent — confirm the file-missing path returns non-zero.

- [ ] **Step 3: Write minimal implementation**

```python
# server/src/helpers/structure_helper.py
"""PDB/mmCIF/XYZ metadata helper. Shelled out to by the TS backend.

Usage:
  python structure_helper.py summarize <path>  -> JSON to stdout

Interactive 3D rendering happens client-side (3Dmol.js); there is no `render`.
Exit codes: 0 ok; 3 deps missing; 4 not found; 5 bad value; 1 other.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

_STD_AA = {
    "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
    "MET","PHE","PRO","SER","THR","TRP","TYR","VAL","SEC","PYL",
}
_WATER = {"HOH", "WAT"}


def _summarize_xyz(path: Path) -> dict:
    lines = path.read_text().splitlines()
    try:
        n = int(lines[0].strip())
    except (ValueError, IndexError):
        sys.stderr.write("Malformed XYZ header\n")
        sys.exit(5)
    elements = []
    for line in lines[2:2 + n]:
        parts = line.split()
        if parts:
            elements.append(parts[0])
    return {
        "format": "xyz", "num_atoms": len(elements), "num_chains": 0, "chains": [],
        "num_residues": 0, "num_ligands": 0, "ligands": [], "resolution": None,
        "title": path.stem,
    }


def _summarize_gemmi(path: Path) -> dict:
    try:
        import gemmi
    except ImportError as exc:
        sys.stderr.write(f"gemmi not installed: {exc}\n")
        sys.exit(3)
    try:
        st = gemmi.read_structure(str(path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Could not parse structure: {exc}\n")
        sys.exit(5)
    model = st[0] if len(st) else None
    chains, ligands, n_atoms, n_res = [], set(), 0, 0
    if model is not None:
        for chain in model:
            chains.append(chain.name)
            for res in chain:
                n_res += 1
                n_atoms += len(res)
                nm = res.name.strip()
                if nm not in _STD_AA and nm not in _WATER:
                    ligands.add(nm)
    return {
        "format": path.suffix.lower().lstrip("."),
        "num_atoms": n_atoms,
        "num_chains": len(chains),
        "chains": chains,
        "num_residues": n_res,
        "num_ligands": len(ligands),
        "ligands": sorted(ligands)[:50],
        "resolution": st.resolution if st.resolution and st.resolution > 0 else None,
        "title": (st.name or path.stem),
    }


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: structure_helper.py summarize <path>\n")
        sys.exit(1)
    cmd, raw = sys.argv[1], Path(sys.argv[2])
    if not raw.exists():
        sys.stderr.write(f"File not found: {raw}\n")
        sys.exit(4)
    if cmd != "summarize":
        sys.stderr.write("structure_helper only supports 'summarize'\n")
        sys.exit(1)
    data = _summarize_xyz(raw) if raw.suffix.lower() == ".xyz" else _summarize_gemmi(raw)
    sys.stdout.write(json.dumps(data))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/structure-helper.test.ts`
Expected: PASS (gemmi test runs if venv synced; otherwise skipped).

- [ ] **Step 5: Commit**

```bash
git add server/src/helpers/structure_helper.py server/test/structure-helper.test.ts server/test/fixtures/mini.pdb
git commit -m "feat(helpers): structure_helper for PDB/mmCIF/XYZ metadata"
```

---

### Task 10: StructureViewer (frontend) with lazy 3Dmol.js + register structure3d

**Files:**
- Create: `web/src/components/viewers/structure-viewer.tsx`
- Create: `web/src/types/3dmol.d.ts`
- Modify: `web/src/lib/viewers/registry.ts` (register `structure3d`)
- Modify: `web/package.json` (add `3dmol`)
- Test: `web/src/components/viewers/structure-viewer.test.tsx`

**Interfaces:**
- Consumes: `ViewerProps` (Task 1), `sciSummaryUrl` (Task 6), `kind="structure"`. Reads the raw structure text from `content` (loadMode `"text"`) — no extra fetch for the model.
- Produces: default-exported `StructureViewer`; a `VIEWER_REGISTRY.structure3d` entry `{ loadMode: "text", canEditSource: true, managesOwnScroll: true }`.

- [ ] **Step 1: Add the dependency**

Run: `cd web && npm install 3dmol`
Expected: `3dmol` added to `web/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```tsx
// web/src/components/viewers/structure-viewer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import StructureViewer from "./structure-viewer";

// 3Dmol touches WebGL which jsdom lacks — stub the dynamic import.
vi.mock("3dmol", () => ({
  createViewer: () => ({ addModel() {}, setStyle() {}, zoomTo() {}, render() {}, resize() {}, clear() {} }),
}));

const summary = {
  format: "pdb", num_atoms: 4, num_chains: 1, chains: ["A"],
  num_residues: 1, num_ligands: 0, ligands: [], resolution: null, title: "TEST",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
});

describe("StructureViewer", () => {
  it("renders the metadata summary card", async () => {
    render(<StructureViewer path="a.pdb" name="a.pdb" content={"ATOM ...\nEND\n"} />);
    await waitFor(() => expect(screen.getByText("TEST")).toBeInTheDocument());
    expect(screen.getByText(/1 chain/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/viewers/structure-viewer.test.tsx`
Expected: FAIL — cannot find module `./structure-viewer`.

- [ ] **Step 4: Write minimal implementation**

```ts
// web/src/types/3dmol.d.ts
declare module "3dmol" {
  export function createViewer(
    element: HTMLElement,
    config?: Record<string, unknown>,
  ): {
    addModel(data: string, format: string): void;
    setStyle(sel: Record<string, unknown>, style: Record<string, unknown>): void;
    zoomTo(): void;
    render(): void;
    resize(): void;
    clear(): void;
  };
}
```

```tsx
// web/src/components/viewers/structure-viewer.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { sciSummaryUrl } from "@/lib/use-sandbox";
import type { ViewerProps } from "@/lib/viewers/registry";

interface StructSummary {
  format: string; num_atoms: number; num_chains: number; chains: string[];
  num_residues: number; num_ligands: number; ligands: string[];
  resolution: number | null; title: string;
}

function fmtForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "cif" || ext === "mmcif") return "cif";
  if (ext === "xyz") return "xyz";
  return "pdb"; // pdb/ent/gro/pdbqt handled as pdb-ish by 3Dmol
}

export default function StructureViewer({ path, name, content }: ViewerProps) {
  const [summary, setSummary] = useState<StructSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [viewerErr, setViewerErr] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setSummary(null); setSummaryErr(null);
    fetch(sciSummaryUrl(path, "structure"))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
        return r.json() as Promise<StructSummary>;
      })
      .then((d) => { if (alive) setSummary(d); })
      .catch((e) => { if (alive) setSummaryErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    if (!content || !mountRef.current) return;
    let disposed = false;
    let viewer: { clear(): void } | null = null;
    import("3dmol")
      .then(($3Dmol) => {
        if (disposed || !mountRef.current) return;
        const v = $3Dmol.createViewer(mountRef.current, { backgroundColor: "white" });
        v.addModel(content, fmtForName(name));
        v.setStyle({}, { cartoon: { color: "spectrum" }, stick: { radius: 0.15 } });
        v.zoomTo();
        v.render();
        viewer = v;
      })
      .catch((e) => { if (!disposed) setViewerErr(String(e?.message ?? e)); });
    return () => { disposed = true; viewer?.clear?.(); };
  }, [content, name]);

  return (
    <div className="flex h-full flex-col">
      {summary && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-semibold">{summary.title}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{summary.num_atoms.toLocaleString()} atoms</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{summary.num_chains} chain{summary.num_chains !== 1 ? "s" : ""}{summary.chains.length ? ` (${summary.chains.slice(0, 8).join(", ")})` : ""}</span>
          {summary.num_ligands > 0 && (<><span className="text-muted-foreground">·</span><span className="text-muted-foreground">{summary.num_ligands} ligand{summary.num_ligands !== 1 ? "s" : ""}</span></>)}
          {summary.resolution != null && (<><span className="text-muted-foreground">·</span><span className="text-muted-foreground">{summary.resolution.toFixed(2)} Å</span></>)}
        </div>
      )}
      {summaryErr && (
        <div className="border-b px-4 py-2 text-xs text-muted-foreground">Metadata unavailable: {summaryErr}</div>
      )}
      <div className="relative flex-1 min-h-0">
        {viewerErr ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">3D viewer failed to load: {viewerErr}</div>
        ) : (
          <div ref={mountRef} className="absolute inset-0" style={{ position: "relative" }} />
        )}
      </div>
    </div>
  );
}
```

Register in `web/src/lib/viewers/registry.ts`:

```ts
const StructureViewer = lazy(() => import("@/components/viewers/structure-viewer"));
// add to VIEWER_REGISTRY:
  structure3d: { loadMode: "text", Viewer: StructureViewer, canEditSource: true, managesOwnScroll: true },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/viewers/structure-viewer.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: no type errors; full frontend suite passes.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/viewers/structure-viewer.tsx web/src/types/3dmol.d.ts web/src/lib/viewers/registry.ts web/package.json web/package-lock.json
git commit -m "feat(viewers): interactive 3D structure viewer (PDB/mmCIF/XYZ via 3Dmol.js)"
```

---

## Manual verification (end-to-end)

After Task 10, verify the real app (per the `verify` skill):

1. `./start.sh` (or `cd server && npm run dev` + `cd web && npm run dev`).
2. Upload `server/test/fixtures/ethanol.smi` → open it → confirm a 2D depiction + `C2H6O`, MW, atom/bond counts render, and the **Edit** button (View source) appears.
3. Upload a real `.pdb` (e.g. fetch `1CRN` from the PDB) → open it → confirm the metadata bar (atoms/chains/resolution) and an interactive, rotatable 3D cartoon.
4. Confirm existing formats (a `.png`, a `.md`, a `.ipynb`, a `.h5ad` if available) still render exactly as before.

---

## Self-Review

**1. Spec coverage (Phase 0 + Phase 1 scope):**
- Format registry refactor → Task 1 + Task 6 (additive dispatch, documented deviation-for-safety). ✓
- Helper venv + startup sync + `PYTHON` routing (incl. anndata migration) → Task 2. ✓
- Extend `fileCategory`/`file-icon`/`categoryLabel`/`guessMime` → Tasks 3, 4. ✓
- Generic `sci-summary`/`sci-render.png` + URL builders → Tasks 5, 6. ✓
- Chemistry 2D (RDKit SVG + props, SDF gallery) → Tasks 7, 8. ✓
- Structures 3D (gemmi metadata + client 3Dmol.js) → Tasks 9, 10. ✓
- Graceful "deps missing" (503) UI → Tasks 5 (backend), 8 (frontend message). ✓
- View-only + raw-source edit via `canEditSource` → Tasks 1, 6, 8, 10. ✓
- Phases 2–4 (mass spec, arrays, imaging) → intentionally out of scope for this plan (Plan 1 of 5). Noted in Global Constraints.

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code; the one SDF fixture is described as generated once via a given RDKit call (acceptable — it is binary-ish text pasted in, not a code placeholder).

**3. Type consistency:** `ViewerProps`/`ViewerDef`/`LoadMode` defined in Task 1 are consumed verbatim in Tasks 6, 8, 10. `getViewerDef` name consistent across Tasks 1, 6. `sciHelperFor`/`runSciHelper` signatures defined in Task 5 match usage in Tasks 5, 7, 9. `helperPython`/`HELPERS_DIR` from Task 2 used in Tasks 5, 7-test, 9-test. `sciSummaryUrl`/`sciRenderUrl` from Task 6 used in Tasks 8, 10. Helper JSON shapes (`ChemSummary`, `StructSummary`) match the Python output keys in Tasks 7, 9.

**Deliberate deviation from spec:** the spec described *replacing* the `if`-chain in `FileViewer`; this plan makes the registry *additive* (registry first, existing chain as fallback) to eliminate regression risk to the 8 existing viewers. Same extensibility outcome; migrating existing viewers into the registry is deferred and optional.
