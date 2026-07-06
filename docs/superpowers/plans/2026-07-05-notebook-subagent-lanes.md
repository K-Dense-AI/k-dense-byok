# Living Lab Notebook — Phase 5: Subagent Lanes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let subagents contribute lab-notebook entries — give child `pi` processes a `notebook` tool via a Pi package, harvest their entries into the parent notebook when each subagent completes, and render the notebook as per-agent collapsible lanes.

**Architecture:** The shipped in-process lead `notebook` tool is left untouched. A new vendored `kady-notebook` Pi package registers a `notebook` tool **only in child processes** (`PI_SUBAGENT_CHILD` env-gate), so the parent never double-registers. Child tool calls are recorded in the child's session JSONL; on subagent completion the parent (which already learns each child's `sessionFile`, exactly as the cost ledger does) parses those calls, stamps `role` = agent name, and appends them to the parent notebook JSONL as the single writer. The frontend re-fetches on subagent completion and groups entries by `role` into lanes.

**Tech Stack:** TypeScript, Pi coding-agent SDK (`@earendil-works/pi-coding-agent@0.79.0`), `pi-subagents`, typebox, Fastify, Next.js 16 / React 19, vitest.

## Global Constraints

- Node ≥ 22.19. Run source via `tsx`, never `tsc` for emit (`tsconfig.json` is `noEmit`). Backend typecheck: `cd server && npm run typecheck`. Frontend: `cd web && npx tsc --noEmit`.
- Backend tests: `cd server && npm test` (vitest; `KADY_PROJECTS_ROOT` → temp dir). Frontend: `cd web && npm test`.
- Baselines to preserve: **server 154 passing**; **web 183 passed / 18 pre-existing jsdom failures** (`web/src/lib/projects.test.ts`, `pdf-annotations.test.ts` — NOT regressions, ignore them).
- Do NOT add a `Co-Authored-By` / Claude co-author trailer to any commit (project rule). Verify each commit with `git show -s --format='%B' HEAD`.
- Company name is **K-Dense** (never "K-Dense AI").
- **Entry timing is batch-on-completion** — subagent entries appear when the subagent finishes, harvested from its session file. No live streaming of child entries, no polling.
- **Layout is grouped collapsible lanes** — lead (`role === "agent"`) first, then each subagent by earliest-entry time. With no subagent entries the view renders exactly as today.
- **Harvested entry `id` is namespaced**: `` `${agentName}:${childToolCallId}` `` — so it can never collide with the lead's entries or another subagent's during the frontend's dedupe-by-`id` merge, and dedup on re-delivery is stable.
- **The in-process lead `notebook` tool (`server/src/agent/notebook.ts`) and its registration in `session-registry.ts` are UNCHANGED** by this plan.
- Manual/e2e agent runs only with Opus 4.8 or GPT-5.5.

## Verified facts this plan relies on (from SDK/pi-subagents investigation)

- A child session JSONL row for a tool call is `{ type:"message", id, parentId, timestamp:"<ISO>", message:{ role:"assistant", content:[ { type:"toolCall", id:"toolu_…", name:"notebook", arguments:{…} }, … ], … } }`. (Timestamps are ISO strings, e.g. `"2026-07-05T20:49:15.610Z"`.)
- The parent learns each child's `agent` name and `sessionFile` on completion: sync via the `subagent` `tool_result` `event.details.results[i].{agent, sessionFile}`, async via the `pi.events` `subagent:async-complete` payload `results[i].{agent, sessionFile}`. `server/src/agent/subagent-bridge.ts` already consumes both.
- Child `pi` processes carry `process.env.PI_SUBAGENT_CHILD`; the in-process parent session does not.
- A Pi package is a dir with `package.json` `"pi": { "extensions": ["./index.ts"] }` + a default-export `ExtensionFactory`; referenced by absolute path in `sandbox/.pi/settings.json` `packages`. `ensureWebAccess(paths)` already pre-trusts the sandbox, which also covers a second package there.
- `NotebookEntry` (backend) is defined in `server/src/agent/notebook-store.ts:31` extending `NotebookEntryInput` (`:21`) with `id: string; timestamp: number; role: string;` (types `NotebookEntryType` `:13`, `NotebookCode` `:16`).

---

## File Structure

**Backend (create):**
- `server/pi-packages/kady-notebook/package.json` — Pi package manifest.
- `server/pi-packages/kady-notebook/index.ts` — env-gated `ExtensionFactory` registering the child `notebook` tool.
- `server/src/agent/notebook-harvest.ts` — `notebookEntriesFromSessionFile(sessionFile, agentName)`, pure.
- `server/src/agent/notebook-bridge.ts` — `seedNotebookPackage(paths)` + `makeSubagentNotebookExtension(projectId, getSessionId)`.

**Backend (modify):**
- `server/src/agent/session-registry.ts` — seed the package + register the harvest extension in `build()`.

**Backend (test):**
- `server/test/notebook-harvest.test.ts`, `server/test/notebook-package.test.ts`, `server/test/notebook-subagent-bridge.test.ts`.

**Frontend (modify):**
- `web/src/lib/use-agent.ts` — `subagentCompletions` counter.
- `web/src/components/chat-tab.tsx` — carry `subagentCompletions` in `ChatTabMeta`.
- `web/src/app/page.tsx` — thread `subagentCompletions` to `FilePreviewPanel`.
- `web/src/components/file-preview-panel.tsx` — pass it through to `LabNotebookView`.
- `web/src/components/lab-notebook-view.tsx` — re-GET on completion; group into lanes.

**Frontend (test):**
- `web/src/components/lab-notebook-view.test.tsx` (extend).

**Docs (modify):**
- `AGENTS.md`, `docs/lab-notebook.md`.

---

## Shared Interfaces (defined once, referenced by every task)

**Harvest — `server/src/agent/notebook-harvest.ts`:**
```ts
import type { NotebookEntry } from "./notebook-store.ts";
export function notebookEntriesFromSessionFile(
  sessionFile: string,
  agentName: string,
): NotebookEntry[];
```

**Bridge — `server/src/agent/notebook-bridge.ts`:**
```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
export function kadyNotebookPackageDir(): string;          // absolute dir of the vendored package
export function seedNotebookPackage(paths: ProjectPaths): boolean;
export function makeSubagentNotebookExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory;
```

**Frontend — `web/src/lib/use-agent.ts` return gains:** `subagentCompletions: number`.

---

# PHASE 1 — Harvest (pure)

### Task 1: `notebookEntriesFromSessionFile`

**Files:**
- Create: `server/src/agent/notebook-harvest.ts`
- Test: `server/test/notebook-harvest.test.ts`

**Interfaces:**
- Consumes: `NotebookEntry`, `NotebookEntryType` from `./notebook-store.ts`.
- Produces: `notebookEntriesFromSessionFile(sessionFile: string, agentName: string): NotebookEntry[]`.

- [ ] **Step 1: Write the failing test.**

```ts
// server/test/notebook-harvest.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { notebookEntriesFromSessionFile } from "../src/agent/notebook-harvest.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-harvest-"));
});

/** One assistant message row carrying the given content blocks. */
const asstRow = (content: unknown[], ts = "2026-07-05T20:49:15.610Z") =>
  JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: ts,
    message: { role: "assistant", content, timestamp: ts },
  });

const toolCall = (id: string, name: string, args: unknown) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function writeSession(name: string, rows: string[]): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, rows.join("\n") + "\n", "utf-8");
  return f;
}

describe("notebookEntriesFromSessionFile", () => {
  it("extracts notebook tool-calls, stamping role and a namespaced id", () => {
    const f = writeSession("s.jsonl", [
      asstRow([
        toolCall("toolu_1", "notebook", {
          type: "hypothesis",
          title: "Six clusters",
          confidence: "high",
          artifacts: ["figures/fig.png"],
        }),
      ]),
      asstRow([toolCall("toolu_2", "bash", { command: "ls" })]), // ignored
      asstRow([
        toolCall("toolu_3", "notebook", { type: "observation", title: "ARI 0.995" }),
      ]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "stats-checker");
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      id: "stats-checker:toolu_1",
      role: "stats-checker",
      type: "hypothesis",
      title: "Six clusters",
      confidence: "high",
      artifacts: ["figures/fig.png"],
    });
    expect(typeof got[0].timestamp).toBe("number");
    expect(got[1].id).toBe("stats-checker:toolu_3");
    expect(got[1].type).toBe("observation");
  });

  it("returns [] for a missing file", () => {
    expect(notebookEntriesFromSessionFile(path.join(dir, "nope.jsonl"), "a")).toEqual([]);
  });

  it("skips malformed rows and invalid entries (bad type, blank title)", () => {
    const f = writeSession("s2.jsonl", [
      "{not json",
      asstRow([toolCall("toolu_1", "notebook", { type: "bogus", title: "x" })]),
      asstRow([toolCall("toolu_2", "notebook", { type: "note", title: "   " })]),
      asstRow([toolCall("toolu_3", "notebook", { type: "note", title: "kept" })]),
    ]);
    const got = notebookEntriesFromSessionFile(f, "a");
    expect(got.map((e) => e.title)).toEqual(["kept"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-harvest`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
// server/src/agent/notebook-harvest.ts
/**
 * Harvest lab-notebook entries a SUBAGENT logged, out of its session JSONL.
 *
 * A child `pi` process gets the `notebook` tool from the kady-notebook package;
 * every call it makes is recorded as an assistant `toolCall` content block in
 * the child's session file. The parent (which learns each child's sessionFile
 * on completion — exactly as usageFromSessionFile harvests cost) parses those
 * calls into NotebookEntry rows, stamped with the child's agent name as `role`
 * and a namespaced id so they never collide with the lead's entries.
 *
 * Pure + defensive: unreadable file / malformed row / invalid entry are skipped.
 */
import fs from "node:fs";
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

/** Coerce a recorded tool-call `arguments` object into a NotebookEntry, or null. */
function entryFromArgs(
  args: Record<string, unknown>,
  id: string,
  role: string,
  timestamp: number,
): NotebookEntry | null {
  if (!isEntryType(args.type)) return null;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  const code =
    args.code && typeof (args.code as { source?: unknown }).source === "string"
      ? {
          source: String((args.code as { source: string }).source),
          lang:
            typeof (args.code as { lang?: unknown }).lang === "string"
              ? String((args.code as { lang: string }).lang)
              : undefined,
        }
      : undefined;
  return {
    id,
    role,
    timestamp,
    type: args.type,
    title,
    body: typeof args.body === "string" ? args.body : undefined,
    artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
    code,
    confidence:
      args.confidence === "low" || args.confidence === "medium" || args.confidence === "high"
        ? args.confidence
        : undefined,
    tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
  };
}

export function notebookEntriesFromSessionFile(
  sessionFile: string,
  agentName: string,
): NotebookEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const out: NotebookEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = row.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN;
    const timestamp = Number.isNaN(ts) ? Date.now() : ts;
    for (const block of msg.content as unknown[]) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "toolCall" ||
        (block as { name?: unknown }).name !== "notebook"
      ) {
        continue;
      }
      const b = block as { id?: unknown; arguments?: unknown };
      const callId = typeof b.id === "string" ? b.id : "";
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      const entry = entryFromArgs(args, `${agentName}:${callId}`, agentName, timestamp);
      if (entry) out.push(entry);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd server && npm test -- notebook-harvest`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit.**

```bash
cd server && npm run typecheck
git add server/src/agent/notebook-harvest.ts server/test/notebook-harvest.test.ts
git commit -m "feat(server): harvest subagent notebook entries from a child session file"
```

---

# PHASE 2 — The kady-notebook Pi package

### Task 2: Vendored package + env-gated tool

**Files:**
- Create: `server/pi-packages/kady-notebook/package.json`
- Create: `server/pi-packages/kady-notebook/index.ts`
- Test: `server/test/notebook-package.test.ts`

**Interfaces:**
- Consumes: `Type` from `typebox`; `ExtensionAPI`, `ToolDefinition` from `@earendil-works/pi-coding-agent`.
- Produces: a default-export `ExtensionFactory`; a named export `notebookChildTool` (the `ToolDefinition`) for testing; `NotebookParams` typebox schema. `index.ts` registers `notebookChildTool` via `pi.registerTool` **only when `process.env.PI_SUBAGENT_CHILD` is set**.

- [ ] **Step 1: Create the package manifest.**

```json
// server/pi-packages/kady-notebook/package.json
{
  "name": "kady-notebook",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "K-Dense: gives child pi processes the notebook tool so subagents contribute lab-notebook entries.",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

- [ ] **Step 2: Write the failing test.**

```ts
// server/test/notebook-package.test.ts
import { describe, it, expect, afterEach } from "vitest";
import factory, { notebookChildTool } from "../pi-packages/kady-notebook/index.ts";

/** Minimal ExtensionAPI stub capturing registerTool calls. */
function fakePi() {
  const registered: unknown[] = [];
  return { registered, api: { registerTool: (t: unknown) => registered.push(t) } };
}

const origChild = process.env.PI_SUBAGENT_CHILD;
afterEach(() => {
  if (origChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = origChild;
});

describe("kady-notebook package", () => {
  it("registers the notebook tool only in a child process", () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const child = fakePi();
    factory(child.api as never);
    expect(child.registered).toHaveLength(1);
    expect((child.registered[0] as { name: string }).name).toBe("notebook");

    delete process.env.PI_SUBAGENT_CHILD;
    const parent = fakePi();
    factory(parent.api as never);
    expect(parent.registered).toHaveLength(0);
  });

  it("the child tool rejects an empty title and returns an ack otherwise", async () => {
    const exec = (id: string, params: unknown) =>
      notebookChildTool.execute(id, params as never, undefined as never, undefined as never, undefined as never);
    await expect(exec("tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
    const ok = await exec("tc_y", { type: "note", title: "kept" });
    expect((ok.content?.[0] as { text: string }).text).toMatch(/tc_y|logged/i);
  });

  it("schema accepts the full NotebookEntryInput shape (parity)", () => {
    // The package schema must accept every field the backend NotebookEntryInput has.
    // Guard: constructing the tool exposes its parameters object.
    const props = (notebookChildTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const k of ["type", "title", "body", "artifacts", "code", "confidence", "tags"]) {
      expect(k in props).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-package`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the package extension.**

```ts
// server/pi-packages/kady-notebook/index.ts
/**
 * kady-notebook — a Pi package that gives CHILD pi processes the `notebook`
 * tool, so subagents can log lab-notebook entries. The parent (in-process)
 * session already has its own notebook tool, so this package registers nothing
 * there: it self-gates on PI_SUBAGENT_CHILD (set only in child processes) to
 * avoid a duplicate `notebook` tool name in the parent.
 *
 * The child tool does NOT write files. A child's tool call is recorded in its
 * session JSONL; the parent harvests it on completion (see
 * server/src/agent/notebook-harvest.ts) and is the single writer.
 *
 * Schema mirrors the in-process tool (server/src/agent/notebook.ts). It is kept
 * self-contained here because a package is loaded standalone by the child pi
 * process; server/test/notebook-package.test.ts asserts field parity.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const CodeSchema = Type.Object({
  source: Type.String({ description: "The code/snippet text" }),
  lang: Type.Optional(Type.String({ description: "Language for highlighting" })),
});

export const NotebookParams = Type.Object({
  type: Type.Union(
    [
      Type.Literal("hypothesis"),
      Type.Literal("method"),
      Type.Literal("observation"),
      Type.Literal("decision"),
      Type.Literal("note"),
    ],
    {
      description:
        "hypothesis = an idea to test, method = what you did/ran, observation = a result, decision = a choice you made and why, note = anything else",
    },
  ),
  title: Type.String({ description: "One-line headline for this entry" }),
  body: Type.Optional(Type.String({ description: "Markdown detail (optional)" })),
  artifacts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative paths this entry produced or references (figures, tables, scripts).",
    }),
  ),
  code: Type.Optional(CodeSchema),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});

export const notebookChildTool: ToolDefinition<typeof NotebookParams> = {
  name: "notebook",
  label: "Notebook",
  description: [
    "Log an entry to the shared living lab notebook as you work.",
    "Record your real reasoning: a `hypothesis` when you form an idea to test, a `method` before/after you run something, an `observation` for a result, a `decision` when a result changes your plan.",
    "Attach `artifacts` (sandbox-relative paths) whenever an entry corresponds to a figure, table, or script you wrote.",
    "This does NOT block; it returns immediately and your run continues. Log liberally at natural milestones.",
  ].join("\n"),
  promptSnippet:
    "notebook: log a hypothesis/method/observation/decision entry to the shared lab notebook",
  promptGuidelines: [
    "Keep a running lab notebook: call `notebook` at natural milestones as you work, not in one dump at the end.",
    "Attach `artifacts` for any entry tied to a file you wrote so the notebook links to real output.",
  ],
  parameters: NotebookParams,
  execute: async (toolCallId, params) => {
    const title = (params.title ?? "").trim();
    if (!title) throw new Error("notebook entry needs a non-empty title");
    return {
      content: [{ type: "text" as const, text: `logged notebook entry ${toolCallId}` }],
      details: {},
    };
  },
};

export default function (pi: ExtensionAPI): void {
  // Parent (in-process) session loads this package too, but already has its own
  // in-process notebook tool — register only in child processes to avoid a
  // duplicate tool name.
  if (!process.env.PI_SUBAGENT_CHILD) return;
  pi.registerTool(notebookChildTool);
}
```

> Note: the `execute` return includes `details: {}` to satisfy the SDK's `AgentToolResult` type (matching the in-process notebook tool). If the `ToolDefinition` import path or the `execute` return type differs from the in-process tool at `server/src/agent/notebook.ts`, mirror whatever that shipped file does — it typechecks today.

- [ ] **Step 5: Run tests + typecheck.**

Run: `cd server && npm test -- notebook-package && npm run typecheck`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 6: Commit.**

```bash
git add server/pi-packages/kady-notebook/ server/test/notebook-package.test.ts
git commit -m "feat(server): kady-notebook Pi package — env-gated notebook tool for subagents"
```

---

# PHASE 3 — Bridge + wiring

### Task 3: `notebook-bridge.ts` + register in the session

**Files:**
- Create: `server/src/agent/notebook-bridge.ts`
- Modify: `server/src/agent/session-registry.ts` (imports; `build()` around the `ensureWebAccess(paths)` call and the `extensionFactories` array)
- Test: `server/test/notebook-subagent-bridge.test.ts`

**Interfaces:**
- Consumes: `notebookEntriesFromSessionFile` from `./notebook-harvest.ts`; `appendNotebookEntry` from `./notebook-store.ts`; `ProjectPaths` from `../projects.ts`; `ExtensionFactory` from `@earendil-works/pi-coding-agent`; `ProjectTrustStore`/`getAgentDir` unused here (trust handled by ensureWebAccess).
- Produces: `kadyNotebookPackageDir(): string`, `seedNotebookPackage(paths): boolean`, `makeSubagentNotebookExtension(projectId, getSessionId): ExtensionFactory`.

- [ ] **Step 1: Write the failing test** (harvest wiring is the risky part; test the extension's harvest+dedup via its event handlers using a fake `pi`).

```ts
// server/test/notebook-subagent-bridge.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeSubagentNotebookExtension } from "../src/agent/notebook-bridge.ts";
import { readNotebookEntries, appendNotebookEntry } from "../src/agent/notebook-store.ts";
import { resolvePaths } from "../src/projects.ts";
import { PROJECTS_ROOT } from "../src/config.ts";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

/** Fake ExtensionAPI capturing the handlers the extension registers. */
function fakePi() {
  const onHandlers: Record<string, (e: unknown) => unknown> = {};
  const eventHandlers: Record<string, (d: unknown) => unknown> = {};
  return {
    onHandlers,
    eventHandlers,
    api: {
      on: (name: string, h: (e: unknown) => unknown) => { onHandlers[name] = h; },
      events: { on: (name: string, h: (d: unknown) => unknown) => { eventHandlers[name] = h; } },
      registerTool: () => {},
    },
  };
}

function writeChildSession(projectId: string, name: string): string {
  const paths = resolvePaths(projectId);
  const dir = path.join(paths.sandbox, ".pi", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  const row = JSON.stringify({
    type: "message",
    timestamp: "2026-07-05T20:49:15.610Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "toolu_c1", name: "notebook", arguments: { type: "observation", title: "child result" } }],
    },
  });
  fs.writeFileSync(f, row + "\n", "utf-8");
  return f;
}

describe("makeSubagentNotebookExtension", () => {
  it("harvests child notebook entries into the parent notebook on tool_result, deduped", () => {
    const projectId = "default";
    const parentSession = "parent-sess";
    const childFile = writeChildSession(projectId, "child.jsonl");

    const pi = fakePi();
    const ext = makeSubagentNotebookExtension(projectId, () => parentSession);
    ext(pi.api as never);

    const evt = {
      toolName: "subagent",
      details: { results: [{ agent: "stats-checker", sessionFile: childFile }] },
    };
    // deliver twice — second must be a no-op (dedup)
    pi.onHandlers["tool_result"](evt);
    pi.onHandlers["tool_result"](evt);

    const entries = readNotebookEntries(parentSession, projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "stats-checker:toolu_c1",
      role: "stats-checker",
      type: "observation",
      title: "child result",
    });
  });

  it("ignores non-subagent tool_result events", () => {
    const pi = fakePi();
    makeSubagentNotebookExtension("default", () => "p2")(pi.api as never);
    pi.onHandlers["tool_result"]({ toolName: "bash", details: {} });
    expect(readNotebookEntries("p2", "default")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-subagent-bridge`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `notebook-bridge.ts`.**

```ts
// server/src/agent/notebook-bridge.ts
/**
 * Wiring so SUBAGENTS contribute to the lab notebook (Phase 5).
 *
 *  1. seedNotebookPackage — reference the vendored kady-notebook package from
 *     sandbox/.pi/settings.json "packages" so child pi processes load it and
 *     get the `notebook` tool. Mirrors seedWebAccessPackage. Sandbox trust is
 *     already established by ensureWebAccess (called in the same build()), so
 *     no separate trust write is needed here.
 *  2. makeSubagentNotebookExtension — on subagent completion (sync tool_result
 *     + async subagent:async-complete, same events the cost ledger uses), parse
 *     each child's session file for `notebook` tool-calls and append them to
 *     the PARENT notebook. The parent is the single writer.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";
import { notebookEntriesFromSessionFile } from "./notebook-harvest.ts";

/** Absolute dir of the vendored kady-notebook package. */
export function kadyNotebookPackageDir(): string {
  // server/src/agent/notebook-bridge.ts → server/pi-packages/kady-notebook
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "kady-notebook");
}

/** True when `entry` points at our kady-notebook package dir. */
function isNotebookSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]kady-notebook$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

/**
 * Reference kady-notebook from the project settings file. Returns true when the
 * file was written. A settings file we cannot parse is left untouched.
 */
export function seedNotebookPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pkgDir = kadyNotebookPackageDir();
  const packages = Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
  const kept = packages.filter((p) => !isNotebookSource(p) || p === pkgDir);
  if (kept.includes(pkgDir) && kept.length === packages.length) return false;
  if (!kept.includes(pkgDir)) kept.push(pkgDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

// Namespaced entry ids already harvested, so a re-delivered async completion
// (delivered to every live session's listener) can't double-append. Module-level
// with a size cap, mirroring subagent-bridge's ledgeredAsyncRuns.
const harvestedIds = new Set<string>();

/** Result shape we consume from both the sync and async completion payloads. */
interface ChildResult {
  agent?: string;
  sessionFile?: string;
}

export function makeSubagentNotebookExtension(
  projectId: string,
  getSessionId: () => string,
): ExtensionFactory {
  const harvest = (results: ChildResult[] | undefined) => {
    const parentSession = getSessionId();
    if (!parentSession) return;
    for (const r of results ?? []) {
      if (!r.agent || !r.sessionFile) continue;
      const entries = notebookEntriesFromSessionFile(r.sessionFile, r.agent);
      for (const entry of entries) {
        if (harvestedIds.has(entry.id)) continue;
        harvestedIds.add(entry.id);
        if (harvestedIds.size > 5000) harvestedIds.clear();
        appendNotebookEntry(parentSession, entry, projectId);
      }
    }
  };

  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "subagent") return;
      const details = event.details as { results?: ChildResult[] } | undefined;
      harvest(details?.results);
    });
    pi.events.on("subagent:async-complete", (data: unknown) => {
      const payload = data as { results?: ChildResult[] };
      harvest(payload.results);
    });
  };
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd server && npm test -- notebook-subagent-bridge`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `session-registry.ts`.** Add the import near the other agent imports:

```ts
import { seedNotebookPackage, makeSubagentNotebookExtension } from "./notebook-bridge.ts";
```

In `build()`, immediately after the existing `ensureWebAccess(paths);` call, add:

```ts
  // Reference the kady-notebook package so child pi processes get the notebook
  // tool (sandbox trust is already handled by ensureWebAccess above).
  seedNotebookPackage(paths);
```

In the `DefaultResourceLoader({ ... extensionFactories: [ ... ] })` array, add the harvest extension alongside the existing `makeSubagentLedgerExtension(...)` entry:

```ts
      makeSubagentNotebookExtension(projectId, () => holder.session?.sessionId ?? ""),
```

- [ ] **Step 6: Typecheck + full backend suite.**

Run: `cd server && npm run typecheck && npm test`
Expected: no type errors; PASS (baseline 154 + new harvest/package/bridge tests).

- [ ] **Step 7: Commit.**

```bash
git add server/src/agent/notebook-bridge.ts server/src/agent/session-registry.ts server/test/notebook-subagent-bridge.test.ts
git commit -m "feat(server): seed kady-notebook package + harvest subagent entries into the parent notebook"
```

---

# PHASE 4 — Frontend refresh signal

### Task 4: `subagentCompletions` counter through the chain

**Files:**
- Modify: `web/src/lib/use-agent.ts` (state ~line 259; live loop ~line 441; `reset` ~line 519; return ~line 532)
- Modify: `web/src/components/chat-tab.tsx` (`ChatTabMeta` ~line 858; `useAgent()` destructure ~line 929; `onMetaChange` payload ~line 1045 + deps ~line 1053)
- Modify: `web/src/app/page.tsx` (derive ~line 174; pass to `FilePreviewPanel` ~line 572)
- Modify: `web/src/components/file-preview-panel.tsx` (props interface ~line 1824; destructure ~line 1843; pass to `LabNotebookView` ~line 1924)

**Interfaces:**
- Consumes: existing `AgentFrame` (`tool_end` frames with `toolName`).
- Produces: `useAgent()` returns `subagentCompletions: number`; `ChatTabMeta.subagentCompletions: number`; `FilePreviewPanel` prop + `LabNotebookView` prop `subagentCompletions: number`.

- [ ] **Step 1: `use-agent.ts` — add state.** After `const [notebookEntries, setNotebookEntries] = useState<NotebookEntry[]>([]);` (line 259):

```ts
  const [subagentCompletions, setSubagentCompletions] = useState(0);
```

- [ ] **Step 2: `use-agent.ts` — increment in the live loop.** In the SSE loop, right after the existing notebook accumulation (the `if (nb) setNotebookEntries(...)` at ~line 442), add:

```ts
              if (frame.type === "tool_end" && frame.toolName === "subagent") {
                setSubagentCompletions((n) => n + 1);
              }
```

- [ ] **Step 3: `use-agent.ts` — clear on reset.** In `reset` (line 519), after `setNotebookEntries([]);`, add:

```ts
    setSubagentCompletions(0);
```

- [ ] **Step 4: `use-agent.ts` — expose it.** In the return object (line 532), add `subagentCompletions,` after `notebookEntries,`.

- [ ] **Step 5: `chat-tab.tsx` — carry it in meta.** Add `subagentCompletions: number;` to `ChatTabMeta` (after `notebookEntries` at line 864); pull `subagentCompletions` from the `useAgent()` destructure (line 929); add `subagentCompletions,` to the `onMetaChange(tabId, {...})` payload (after `notebookEntries` at line 1051) AND add `subagentCompletions` to that effect's dependency array (line 1053).

- [ ] **Step 6: `page.tsx` — derive + pass.** After `const notebookStreaming = activeMeta?.isStreaming ?? false;` (line 175) add:

```ts
  const subagentCompletions = activeMeta?.subagentCompletions ?? 0;
```

In the `<FilePreviewPanel ... />` props (after `notebookStreaming={notebookStreaming}` at line 576) add:

```tsx
              notebookSubagentCompletions={subagentCompletions}
```

- [ ] **Step 7: `file-preview-panel.tsx` — thread through.** Add `notebookSubagentCompletions: number;` to `FilePreviewPanelProps` (after `notebookStreaming` ~line 1828); add `notebookSubagentCompletions,` to the destructure (~line 1847); pass it to `<LabNotebookView>` (after `streaming={notebookStreaming}` ~line 1927):

```tsx
          subagentCompletions={notebookSubagentCompletions}
```

- [ ] **Step 8: Typecheck.** (Type will error until Task 5 adds the `LabNotebookView` prop — that's expected; if you want a clean gate here, add the prop to `LabNotebookView`'s signature as an unused `subagentCompletions: number` first, then Task 5 uses it. Simplest: do Step 8's typecheck AFTER Task 5.)

Run: `cd web && npx tsc --noEmit`
Expected: the only error (if any) is `LabNotebookView` missing the `subagentCompletions` prop — resolved in Task 5. No other errors.

- [ ] **Step 9: Commit** (together with Task 5 is fine, or commit now with the prop added as unused in Task 5). If committing now:

```bash
git add web/src/lib/use-agent.ts web/src/components/chat-tab.tsx web/src/app/page.tsx web/src/components/file-preview-panel.tsx
git commit -m "feat(web): thread a subagentCompletions signal to the notebook view"
```

---

# PHASE 5 — Grouped lanes

### Task 5: Lane rendering + completion re-fetch in `LabNotebookView`

**Files:**
- Modify: `web/src/components/lab-notebook-view.tsx`
- Test: `web/src/components/lab-notebook-view.test.tsx` (extend)

**Interfaces:**
- Consumes: `subagentCompletions: number` (new prop); existing `NotebookEntry.role`; `LabNotebookEntryCard`.
- Produces: grouped-lane rendering; re-GET keyed on `subagentCompletions`.

- [ ] **Step 1: Write the failing tests.** Append to `web/src/components/lab-notebook-view.test.tsx`:

```tsx
it("groups entries into lanes by role (lead first, then subagents)", () => {
  const entries: NotebookEntry[] = [
    { id: "l1", role: "agent", type: "hypothesis", title: "Lead idea", timestamp: 1 },
    { id: "scout:c1", role: "literature-scout", type: "method", title: "Searched refs", timestamp: 2 },
    { id: "stats:c1", role: "stats-checker", type: "observation", title: "p<0.001", timestamp: 3 },
  ];
  render(
    <LabNotebookView sessionId="s1" liveEntries={entries} streaming={false}
      subagentCompletions={0} onOpenFile={() => {}} />,
  );
  // Lane headers present; lead labeled and first.
  const lead = screen.getByText(/Kady \(lead\)/i);
  const scout = screen.getByText("literature-scout");
  expect(lead).toBeInTheDocument();
  expect(scout).toBeInTheDocument();
  // Lead appears before the subagent lane in DOM order.
  expect(lead.compareDocumentPosition(scout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Entries from each lane render.
  expect(screen.getByText("Lead idea")).toBeInTheDocument();
  expect(screen.getByText("p<0.001")).toBeInTheDocument();
});

it("re-fetches the notebook when subagentCompletions increments", async () => {
  const { apiFetch } = await import("@/lib/projects");
  const spy = apiFetch as unknown as ReturnType<typeof vi.fn>;
  spy.mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) });
  const { rerender } = render(
    <LabNotebookView sessionId="s1" liveEntries={[]} streaming={false}
      subagentCompletions={0} onOpenFile={() => {}} />,
  );
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); // initial (sessionId) fetch
  rerender(
    <LabNotebookView sessionId="s1" liveEntries={[]} streaming={false}
      subagentCompletions={1} onOpenFile={() => {}} />,
  );
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2)); // completion re-fetch
});
```

> The existing tests in this file call `<LabNotebookView ... />` without `subagentCompletions`; update each existing render in the file to pass `subagentCompletions={0}` so the prop is required and tests compile.

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd web && npm test -- lab-notebook-view`
Expected: FAIL (prop not accepted / lanes not rendered).

- [ ] **Step 3: Implement.** In `lab-notebook-view.tsx`:

(a) Add the prop to the signature:

```tsx
export function LabNotebookView({
  sessionId,
  liveEntries,
  streaming,
  subagentCompletions,
  onOpenFile,
}: {
  sessionId: string | null;
  liveEntries: NotebookEntry[];
  streaming: boolean;
  subagentCompletions: number;
  onOpenFile: (path: string) => void;
}) {
```

(b) Extract the fetch into a reusable callback and key it on both `sessionId` and `subagentCompletions`. Replace the existing cold-open `useEffect` (lines 100–118) with:

```tsx
  const refetch = useCallback(() => {
    let cancelled = false;
    if (!sessionId) {
      setFetched([]);
      return () => { cancelled = true; };
    }
    (async () => {
      try {
        const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/notebook`);
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: NotebookEntry[] };
        if (!cancelled && Array.isArray(data.entries)) setFetched(data.entries);
      } catch {
        // Non-fatal: live entries still render.
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // Cold-open/reload on session change, and re-pull when a subagent completes
  // (its harvested entries are now in the durable notebook).
  useEffect(() => {
    if (sessionId) setFetched([]); // clear only on a real session switch
    const cleanup = refetch();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (subagentCompletions > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentCompletions]);
```

Add `useCallback` to the React import at the top (`import { useCallback, useEffect, useMemo, useRef, useState } from "react";`).

(c) Group entries into lanes. After the `entries` `useMemo` (line 121–124), add:

```tsx
  // Group into per-agent lanes: lead (role "agent") first, then each subagent
  // ordered by its earliest entry. Entries within a lane stay time-ordered.
  const lanes = useMemo(() => {
    const byRole = new Map<string, NotebookEntry[]>();
    for (const e of entries) {
      const role = e.role ?? "agent";
      const list = byRole.get(role);
      if (list) list.push(e);
      else byRole.set(role, [e]);
    }
    const roles = [...byRole.keys()].sort((a, b) => {
      if (a === "agent") return -1;
      if (b === "agent") return 1;
      return (byRole.get(a)![0]?.timestamp ?? 0) - (byRole.get(b)![0]?.timestamp ?? 0);
    });
    return roles.map((role) => ({
      role,
      label: role === "agent" ? "Kady (lead)" : role,
      entries: byRole.get(role)!,
    }));
  }, [entries]);
```

(d) Replace the flat entry list (lines 180–192, the `entries.length === 0 ? ... : (...)` body) with lane rendering. If there is only the lead lane, render it without a collapsible header (behavior unchanged from today). Otherwise render each lane as a `<details open>` section with a header:

```tsx
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Kady’s notebook — entries appear here as it works.
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {lanes.map((lane) =>
            lanes.length === 1 ? (
              <div key={lane.role} className="space-y-3">
                {lane.entries.map((entry) => (
                  <div key={entry.id} className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
                    <LabNotebookEntryCard entry={entry} onOpenFile={onOpenFile} />
                  </div>
                ))}
              </div>
            ) : (
              <details key={lane.role} open className="rounded-lg border">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium">
                  {lane.label}
                  <span className="ml-2 text-muted-foreground">
                    {lane.entries.length}
                  </span>
                </summary>
                <div className="space-y-3 p-3 pt-0">
                  {lane.entries.map((entry) => (
                    <div key={entry.id} className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
                      <LabNotebookEntryCard entry={entry} onOpenFile={onOpenFile} />
                    </div>
                  ))}
                </div>
              </details>
            ),
          )}
          <div ref={bottomRef} />
        </div>
      )}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd web && npm test -- lab-notebook-view`
Expected: PASS (existing 10 + 2 new).

- [ ] **Step 5: Full frontend gate.**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: no type errors; web at baseline + new passing tests (only the 2 pre-existing jsdom files fail).

- [ ] **Step 6: Commit.**

```bash
git add web/src/components/lab-notebook-view.tsx web/src/components/lab-notebook-view.test.tsx
git commit -m "feat(web): render notebook as per-agent lanes; refresh on subagent completion"
```

> If Task 4 was not committed separately, include its files in this commit.

---

# PHASE 6 — Docs

### Task 6: Update the caveat + feature doc

**Files:**
- Modify: `AGENTS.md` (the "Living Lab Notebook (`notebook`)" caveat bullet in "Caveats worth knowing")
- Modify: `docs/lab-notebook.md`

- [ ] **Step 1: Update `AGENTS.md`.** The existing caveat says the notebook tool is in-process and subagents don't see it. Replace it to reflect Phase 5: the lead uses the in-process tool (live), and subagents get a `notebook` tool via the vendored `kady-notebook` Pi package (env-gated on `PI_SUBAGENT_CHILD` so the parent doesn't double-register); their entries are harvested from each child's session file on completion and appended to the parent notebook (parent = single writer), then rendered in per-agent lanes. Note the v1 limitation: nested subagents (depth > 1) are not harvested.

- [ ] **Step 2: Update `docs/lab-notebook.md`.** Add a short "Subagent lanes" section: subagents contribute entries; the notebook groups entries into collapsible per-agent lanes (Lead first); subagent entries appear when the subagent finishes (batch, not live); nested-subagent entries are out of scope for now.

- [ ] **Step 3: Commit.**

```bash
git show -s --format='%B' HEAD   # (sanity: previous commit had no trailer)
git add AGENTS.md docs/lab-notebook.md
git commit -m "docs: subagent notebook lanes (Phase 5)"
```

---

## Self-Review

**1. Spec coverage:**
- Env-gated package registers tool only in children → Task 2 (`PI_SUBAGENT_CHILD` gate + test). ✅
- Package referenced from settings.json, trust shared with ensureWebAccess → Task 3 (`seedNotebookPackage`) + wiring. ✅
- Harvest child entries from session file, role-stamped, namespaced id → Task 1 (`notebookEntriesFromSessionFile`, id `agent:callId`). ✅
- Harvest on sync `tool_result` + async `subagent:async-complete`, dedup, parent single writer → Task 3 (`makeSubagentNotebookExtension`, `harvestedIds`). ✅
- In-process lead tool untouched → not modified in any task (Global Constraints + verified `notebook.ts`/`session-registry` lead registration left as-is). ✅
- Frontend re-fetch on subagent completion → Tasks 4 (signal) + 5 (re-GET on `subagentCompletions`). ✅
- Grouped collapsible lanes, lead first, single-lane unchanged → Task 5. ✅
- Edge cases: missing/malformed file → Task 1 guards; dedup → Task 3; nested-subagent limitation → Task 6 docs + spec (not harvested by design). ✅
- Testing: harvest, package, bridge, frontend lanes/refetch → Tasks 1,2,3,5. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step has complete code. The one "mirror whatever the shipped file does" note (Task 2, `execute` return type) is a concrete instruction with a named reference file (`server/src/agent/notebook.ts`), not a placeholder — it exists because the exact `AgentToolResult` return shape must match the SDK version in use.

**3. Type consistency:** `notebookEntriesFromSessionFile(sessionFile, agentName)` identical across Task 1 (def), Task 3 (call), tests. `NotebookEntry` id namespacing `agent:callId` consistent (Task 1 impl, Task 3 dedup key, Task 5 fixtures). `makeSubagentNotebookExtension(projectId, getSessionId)` consistent (Task 3 def + session-registry call). `subagentCompletions: number` consistent across useAgent return (Task 4), ChatTabMeta (Task 4), FilePreviewPanel prop `notebookSubagentCompletions` → LabNotebookView prop `subagentCompletions` (Tasks 4 & 5 — note the panel-level prop is intentionally named `notebookSubagentCompletions` to match the existing `notebook*` prop convention in `file-preview-panel.tsx`, and is passed to the view as `subagentCompletions`). `seedNotebookPackage`/`kadyNotebookPackageDir` consistent (Task 3). ✅
