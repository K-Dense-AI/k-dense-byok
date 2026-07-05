# Living Lab Notebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A center-panel notebook that writes itself in real time as Kady works — structured Hypothesis/Method/Observation/Decision entries the agent authors via a `notebook` tool, each wired to the code/figures it produced, durable and exportable.

**Architecture:** A non-blocking in-process Pi custom tool (`notebook`, modeled on `interview`) validates + server-stamps + appends each entry to `sandbox/.kady/notebook/<sessionId>.jsonl`. The entry rides the existing `tool_start` SSE frame (no new frame type). The frontend accumulates entries live from the active chat tab's stream, lifts them to the page, and renders them in a pinned "Lab Notebook" tab in the center panel; a backend `GET` endpoint provides durable reload/cold-open, and a Markdown export endpoint produces a lab record.

**Tech Stack:** TypeScript, Pi coding-agent SDK (`@earendil-works/pi-coding-agent`), typebox (tool schema), Fastify (backend routes), Next.js 16 / React 19 (frontend), vitest (tests).

## Global Constraints

- Node ≥ 22.19 (Pi target). Run source via `tsx`, never `tsc` for emit (`tsconfig.json` is `noEmit`).
- Backend tests: `cd server && npm test` (vitest; `KADY_PROJECTS_ROOT` → temp dir via `vitest.config.ts`). Frontend tests: `cd web && npm test`.
- Typecheck: `cd server && npm run typecheck`; `cd web && npx tsc --noEmit` (must stay clean).
- All backend routes are project-scoped via `currentProjectId()` + `activePaths()` (`server/src/scope.ts`, `server/src/projects.ts`); the frontend `apiFetch` (`web/src/lib/projects.ts`) injects `X-Project-Id`.
- Company name is **K-Dense** (not "K-Dense AI"); website www.k-dense.ai. Do not add Claude as a commit co-author.
- Entry `id` **is** the tool's `toolCallId` — the single dedupe key shared between the live `tool_start` frame and the persisted/authoritative entry.
- Session-id path segments must be validated with `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` before use (traversal guard; mirrors `server/src/cost/ledger.ts`).
- Pre-existing web test failures on a clean checkout: `web/src/lib/projects.test.ts` and `pdf-annotations.test.ts` (jsdom localStorage). Do NOT treat these as regressions.
- Manual/e2e agent runs: only Opus 4.8 or GPT-5.5.
- The name `NotebookViewer` is already taken (Jupyter `.ipynb` viewer in `file-preview-panel.tsx`). Use `LabNotebook*` names for all new components to avoid collision.

---

## File Structure

**Backend (create):**
- `server/src/agent/notebook-store.ts` — entry types, path resolver, `appendNotebookEntry`, `readNotebookEntries`. Pure I/O; no Pi dependency.
- `server/src/agent/notebook-export.ts` — `notebookToMarkdown(entries, opts)`. Pure function.
- `server/src/agent/notebook.ts` — the `notebook` tool definition (typebox schema + non-blocking `execute` + prompt guidelines).

**Backend (modify):**
- `server/src/projects.ts` — add `notebookDir` to `ProjectPaths` + `resolvePaths`.
- `server/src/agent/session-registry.ts` — register the tool in `build()`.
- `server/src/api/sessions.ts` — add `GET /sessions/:id/notebook` + `GET /sessions/:id/notebook/export`.

**Backend (test):**
- `server/test/notebook-store.test.ts`, `server/test/notebook-export.test.ts`, `server/test/notebook-tool.test.ts`.

**Frontend (create):**
- `web/src/lib/notebook.ts` — `NotebookEntry` type + pure helpers `parseNotebookFrame`, `mergeNotebookEntries`.
- `web/src/components/lab-notebook-view.tsx` — timeline view (header actions, empty state, GET-merge, export).
- `web/src/components/lab-notebook-entry-card.tsx` — one entry card.

**Frontend (modify):**
- `web/src/lib/use-agent.ts` — accumulate + expose `notebookEntries`.
- `web/src/components/chat-tab.tsx` — surface `notebookEntries` via `ChatTabMeta`.
- `web/src/components/file-preview-panel.tsx` — pinned "Lab Notebook" tab + render `LabNotebookView`.
- `web/src/app/page.tsx` — `showNotebook` state; pass active tab's entries + `onOpenFile` + `sessionId` into `FilePreviewPanel`.

**Frontend (test):**
- `web/src/lib/notebook.test.ts`, `web/src/components/lab-notebook-view.test.tsx`.

---

## Shared Interfaces (defined once, referenced by every task)

**Backend — `server/src/agent/notebook-store.ts`:**

```ts
export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

export interface NotebookCode {
  source: string;
  lang?: string;
}

/** The model-supplied fields (what the tool schema accepts). */
export interface NotebookEntryInput {
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: NotebookCode;
  confidence?: "low" | "medium" | "high";
  tags?: string[];
}

/** A persisted entry: input + server-stamped fields. */
export interface NotebookEntry extends NotebookEntryInput {
  id: string;        // == toolCallId
  timestamp: number; // ms epoch (server wall-clock at receipt)
  role: string;      // "agent" now; subagent name in the Phase 5 follow-on
}
```

**Frontend — `web/src/lib/notebook.ts`** mirrors this (same field names/types), plus:

```ts
export function parseNotebookFrame(frame: AgentFrame): NotebookEntry | null;
export function mergeNotebookEntries(a: NotebookEntry[], b: NotebookEntry[]): NotebookEntry[];
```

---

# PHASE 1 — Tool, persistence, registration

### Task 1: Notebook store (path + append + read)

**Files:**
- Modify: `server/src/projects.ts` (`ProjectPaths` interface ~line 44; `resolvePaths` return ~line 112)
- Create: `server/src/agent/notebook-store.ts`
- Test: `server/test/notebook-store.test.ts`

**Interfaces:**
- Consumes: `resolvePaths`, `activePaths` from `../projects.ts`.
- Produces: `NotebookEntryType`, `NotebookCode`, `NotebookEntryInput`, `NotebookEntry` (see Shared Interfaces); `notebookPath(sessionId, projectId?)`, `appendNotebookEntry(sessionId, entry, projectId?)`, `readNotebookEntries(sessionId, projectId?)`.

- [ ] **Step 1: Add `notebookDir` to `ProjectPaths`.** In `server/src/projects.ts`, add `notebookDir: string;` to the `ProjectPaths` interface (after `runsDir`), and in `resolvePaths` add `notebookDir: path.join(kadyDir, "notebook"),` to the returned object (after `runsDir`).

- [ ] **Step 2: Write the failing test.**

```ts
// server/test/notebook-store.test.ts
import { describe, it, expect } from "vitest";
import {
  appendNotebookEntry,
  readNotebookEntries,
  type NotebookEntry,
} from "../src/agent/notebook-store.ts";

const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "tc_1",
  type: "hypothesis",
  title: "Six populations recoverable",
  timestamp: 1_000,
  role: "agent",
  ...over,
});

describe("notebook-store", () => {
  it("returns [] for a session with no notebook file", () => {
    expect(readNotebookEntries("nope-session")).toEqual([]);
  });

  it("appends entries and reads them back in order", () => {
    const s = "sess-store-a";
    appendNotebookEntry(s, entry({ id: "tc_1", timestamp: 1 }));
    appendNotebookEntry(s, entry({ id: "tc_2", timestamp: 2, type: "observation" }));
    const got = readNotebookEntries(s);
    expect(got.map((e) => e.id)).toEqual(["tc_1", "tc_2"]);
    expect(got[1].type).toBe("observation");
  });

  it("skips malformed lines instead of throwing", () => {
    const s = "sess-store-b";
    appendNotebookEntry(s, entry({ id: "ok" }));
    const { notebookPath } = require("../src/agent/notebook-store.ts");
    require("node:fs").appendFileSync(notebookPath(s), "{not json\n");
    expect(readNotebookEntries(s).map((e) => e.id)).toEqual(["ok"]);
  });

  it("rejects a traversal session id", () => {
    expect(() => readNotebookEntries("../../etc")).toThrow(/Invalid session id/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-store`
Expected: FAIL (module `notebook-store.ts` not found).

- [ ] **Step 4: Implement the store.**

```ts
// server/src/agent/notebook-store.ts
/**
 * Durable per-session lab-notebook store.
 *
 * One JSONL row per entry under sandbox/.kady/notebook/<sessionId>.jsonl —
 * the same layout family as the cost ledger (.kady/runs/.../costs.jsonl).
 * This file is the authoritative source of truth for reload and export;
 * the live SSE `tool_start` frame is only a provisional mirror.
 */
import fs from "node:fs";
import path from "node:path";
import { activePaths, resolvePaths } from "../projects.ts";

export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

export interface NotebookCode {
  source: string;
  lang?: string;
}

export interface NotebookEntryInput {
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: NotebookCode;
  confidence?: "low" | "medium" | "high";
  tags?: string[];
}

export interface NotebookEntry extends NotebookEntryInput {
  id: string;
  timestamp: number;
  role: string;
}

export function notebookPath(sessionId: string, projectId?: string): string {
  // Session id becomes a filename; it arrives raw from the URL. Reject traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const paths = projectId ? resolvePaths(projectId) : activePaths();
  return path.join(paths.notebookDir, `${sessionId}.jsonl`);
}

export function appendNotebookEntry(
  sessionId: string,
  entry: NotebookEntry,
  projectId?: string,
): void {
  const file = notebookPath(sessionId, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

export function readNotebookEntries(
  sessionId: string,
  projectId?: string,
): NotebookEntry[] {
  const file = notebookPath(sessionId, projectId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw exc;
  }
  const out: NotebookEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NotebookEntry);
    } catch {
      // Skip a truncated/corrupt row rather than failing the whole read.
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `cd server && npm test -- notebook-store`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit.**

```bash
git add server/src/agent/notebook-store.ts server/src/projects.ts server/test/notebook-store.test.ts
git commit -m "feat(server): notebook-store — per-session lab-notebook JSONL persistence"
```

---

### Task 2: The `notebook` tool

**Files:**
- Create: `server/src/agent/notebook.ts`
- Test: `server/test/notebook-tool.test.ts`

**Interfaces:**
- Consumes: `appendNotebookEntry`, `NotebookEntry`, `NotebookEntryInput` from `./notebook-store.ts`; `Type`, `Static` from `typebox`; `ToolDefinition` from `@earendil-works/pi-coding-agent`.
- Produces: `makeNotebookTool(projectId: string, getSessionId: () => string): ToolDefinition<typeof NotebookParams>`; `NotebookParams` typebox schema.

- [ ] **Step 1: Write the failing test.**

```ts
// server/test/notebook-tool.test.ts
import { describe, it, expect } from "vitest";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { readNotebookEntries } from "../src/agent/notebook-store.ts";

const run = (tool: ReturnType<typeof makeNotebookTool>, id: string, params: unknown) =>
  tool.execute(id, params as never, undefined as never);

describe("notebook tool", () => {
  it("persists a stamped entry and returns a non-blocking ack", async () => {
    const s = "sess-tool-a";
    const tool = makeNotebookTool("default", () => s);
    const res = await run(tool, "tc_abc", {
      type: "hypothesis",
      title: "Clusters map to six cell types",
      body: "Silhouette suggests k=6.",
      confidence: "medium",
      artifacts: ["figures/fig08_silhouette.png"],
    });
    // Ack mentions the id; run is not blocked.
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toMatch(/tc_abc/);

    const entries = readNotebookEntries(s);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tc_abc",
      type: "hypothesis",
      role: "agent",
      confidence: "medium",
    });
    expect(typeof entries[0].timestamp).toBe("number");
  });

  it("rejects an empty title", async () => {
    const tool = makeNotebookTool("default", () => "sess-tool-b");
    await expect(run(tool, "tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
  });

  it("declares the notebook tool name", () => {
    expect(makeNotebookTool("default", () => "s").name).toBe("notebook");
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-tool`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the tool.**

```ts
// server/src/agent/notebook.ts
/**
 * Native `notebook` tool: Kady logs its own research narrative as structured
 * lab-notebook entries (hypothesis / method / observation / decision / note).
 *
 * Modeled on the `interview` tool, but NON-BLOCKING: it validates, server-
 * stamps (id = toolCallId, timestamp, role), appends to the durable store,
 * and returns immediately so the run keeps flowing. The entry rides the normal
 * `tool_start` SSE frame (tool name "notebook", args = the entry), which the
 * center-panel Lab Notebook view renders live.
 *
 * In-process custom tool → seen only by the lead agent, not by pi-subagents'
 * child `pi` processes (a Phase 5 follow-on promotes it to a Pi package).
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";

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
        "Sandbox-relative paths this entry produced or references (figures, tables, scripts). Attach whenever the entry corresponds to a file you wrote.",
    }),
  ),
  code: Type.Optional(CodeSchema),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Your confidence (mainly for hypothesis/decision)",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form labels" })),
});

export type NotebookParamsT = Static<typeof NotebookParams>;

export function makeNotebookTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof NotebookParams> {
  return {
    name: "notebook",
    label: "Notebook",
    description: [
      "Log an entry to your living lab notebook — the scientist watching you works from it.",
      "Record your real reasoning as you go: a `hypothesis` when you form an idea to test, a `method` before/after you run an analysis, an `observation` when you get a result, and a `decision` when a result makes you change course.",
      "Attach `artifacts` (sandbox-relative paths) whenever an entry corresponds to a figure, table, or script you just wrote — they become clickable links in the notebook.",
      "This does NOT block; it returns immediately and your run continues. Log liberally at natural milestones rather than in one dump at the end.",
    ].join("\n"),
    promptSnippet:
      "notebook: log a structured hypothesis/method/observation/decision entry to the live lab notebook",
    promptGuidelines: [
      "Keep a running lab notebook: call `notebook` at natural milestones — when forming a hypothesis, before and after running an analysis, and whenever a result changes your plan.",
      "Prefer several small, timely entries over one big summary at the end; the user watches the notebook fill in as you work.",
      "Attach `artifacts` for any entry tied to a file you wrote (figure, table, script) so the notebook links to the real output.",
    ],
    parameters: NotebookParams,
    execute: async (toolCallId, params, _signal) => {
      const title = (params.title ?? "").trim();
      if (!title) throw new Error("notebook entry needs a non-empty title");

      const entry: NotebookEntry = {
        ...params,
        title,
        id: toolCallId,
        timestamp: Date.now(),
        role: "agent",
      };
      try {
        appendNotebookEntry(getSessionId(), entry, projectId);
      } catch (exc) {
        // Never abort a run over a notebook write; report softly to the model.
        return {
          content: [
            {
              type: "text" as const,
              text: `notebook entry not saved (${(exc as Error).message}); continue your work.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: `logged notebook entry ${toolCallId}` }],
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd server && npm test -- notebook-tool`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck.**

Run: `cd server && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add server/src/agent/notebook.ts server/test/notebook-tool.test.ts
git commit -m "feat(server): notebook tool — non-blocking, agent-authored lab-notebook entries"
```

---

### Task 3: Register the tool in the session

**Files:**
- Modify: `server/src/agent/session-registry.ts` (imports ~line 27; `build()` tool wiring ~lines 105–129)

**Interfaces:**
- Consumes: `makeNotebookTool` from `./notebook.ts`.
- Produces: sessions created by `build()` now expose the `notebook` tool to the lead agent.

- [ ] **Step 1: Import the factory.** After the `makeInterviewTool` import (line 27), add:

```ts
import { makeNotebookTool } from "./notebook.ts";
```

- [ ] **Step 2: Construct the tool.** In `build()`, right after the `interviewTool` construction (~line 107), add:

```ts
  // Non-blocking lab-notebook tool: logs the agent's own narrative entries.
  const notebookTool = makeNotebookTool(projectId, () => holder.session?.sessionId ?? "");
```

- [ ] **Step 3: Register in the tool lists.** In the `createAgentSession({ ... })` call, add `"notebook"` to the `tools:` array (after `"interview"`) and `notebookTool` to the `customTools:` array:

```ts
    tools: [
      ...BUILTIN_TOOLS,
      "subagent",
      "interview",
      "notebook",
      ...WEB_ACCESS_TOOLS,
      ...(modalTool ? ["modal_run"] : []),
      ...mcpTools.map((t) => t.name),
    ],
    customTools: [interviewTool, notebookTool, ...(modalTool ? [modalTool] : []), ...mcpTools],
```

- [ ] **Step 4: Typecheck.**

Run: `cd server && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full backend suite (nothing regressed).**

Run: `cd server && npm test`
Expected: PASS (existing suites + the two new notebook suites).

- [ ] **Step 6: Commit.**

```bash
git add server/src/agent/session-registry.ts
git commit -m "feat(server): register the notebook tool on each agent session"
```

---

# PHASE 2 — Live center-panel view + reload

### Task 4: Backend `GET /sessions/:id/notebook`

**Files:**
- Modify: `server/src/api/sessions.ts` (imports; add route near the `/sessions/:id/costs` route ~line 109)
- Test: `server/test/notebook-routes.test.ts`

**Interfaces:**
- Consumes: `readNotebookEntries` from `../agent/notebook-store.ts`; `currentProjectId` from `../scope.ts`.
- Produces: `GET /sessions/:id/notebook` → `{ entries: NotebookEntry[] }`.

- [ ] **Step 1: Write the failing test.**

```ts
// server/test/notebook-routes.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSessionRoutes } from "../src/api/sessions.ts";
import { appendNotebookEntry, type NotebookEntry } from "../src/agent/notebook-store.ts";
import { runWithProject } from "../src/scope.ts";

// The session routes read the project from AsyncLocalStorage; wrap requests.
async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    runWithProject("default", () => done());
  });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "tc_1", type: "method", title: "Ran PCA", timestamp: 1, role: "agent", ...over,
});

describe("GET /sessions/:id/notebook", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await build(); });

  it("returns [] for a session with no entries", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions/empty-sess/notebook" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("returns persisted entries", async () => {
    appendNotebookEntry("route-sess", entry({ id: "tc_1" }), "default");
    appendNotebookEntry("route-sess", entry({ id: "tc_2", type: "observation" }), "default");
    const res = await app.inject({ method: "GET", url: "/sessions/route-sess/notebook" });
    expect(res.json().entries.map((e: NotebookEntry) => e.id)).toEqual(["tc_1", "tc_2"]);
  });
});
```

> Note: confirm the actual scope helper name/signature in `server/src/scope.ts` (it may be `runWithProject`, or an `AsyncLocalStorage` you enter differently). Match the pattern used by an existing route test in `server/test/` (e.g. the steer/abort test) — adjust the `onRequest` hook to whatever that test uses. The assertion logic stays the same.

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd server && npm test -- notebook-routes`
Expected: FAIL (route returns 404 / not registered).

- [ ] **Step 3: Add the import.** In `server/src/api/sessions.ts`, add near the other agent imports:

```ts
import { readNotebookEntries } from "../agent/notebook-store.ts";
```

- [ ] **Step 4: Register the route.** After the `/sessions/:id/costs` route, add:

```ts
  app.get<{ Params: { id: string } }>("/sessions/:id/notebook", async (req, reply) => {
    try {
      return { entries: readNotebookEntries(req.params.id, currentProjectId()) };
    } catch (exc) {
      reply.code(400);
      return { detail: (exc as Error).message };
    }
  });
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `cd server && npm test -- notebook-routes`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit.**

```bash
git add server/src/api/sessions.ts server/test/notebook-routes.test.ts
git commit -m "feat(server): GET /sessions/:id/notebook returns persisted entries"
```

---

### Task 5: Frontend notebook lib (parse + merge)

**Files:**
- Create: `web/src/lib/notebook.ts`
- Test: `web/src/lib/notebook.test.ts`

**Interfaces:**
- Consumes: `AgentFrame` from `./use-agent`.
- Produces: `NotebookEntry`, `NotebookEntryType` types; `parseNotebookFrame(frame): NotebookEntry | null`; `mergeNotebookEntries(a, b): NotebookEntry[]`.

- [ ] **Step 1: Write the failing test.**

```ts
// web/src/lib/notebook.test.ts
import { describe, it, expect } from "vitest";
import { parseNotebookFrame, mergeNotebookEntries, type NotebookEntry } from "./notebook";
import type { AgentFrame } from "./use-agent";

const frame = (args: unknown, over: Partial<AgentFrame> = {}): AgentFrame => ({
  type: "tool_start", toolName: "notebook", toolCallId: "tc_1", args, ...over,
} as AgentFrame);

describe("parseNotebookFrame", () => {
  it("parses a notebook tool_start frame into a provisional entry", () => {
    const e = parseNotebookFrame(frame({ type: "hypothesis", title: "Six types", confidence: "high" }));
    expect(e).toMatchObject({ id: "tc_1", type: "hypothesis", title: "Six types", confidence: "high" });
    expect(typeof e!.timestamp).toBe("number");
  });

  it("ignores non-notebook tool_start frames", () => {
    expect(parseNotebookFrame(frame({ type: "hypothesis", title: "x" }, { toolName: "bash" }))).toBeNull();
  });

  it("ignores non-tool_start frames", () => {
    expect(parseNotebookFrame({ type: "text_delta", delta: "hi" } as AgentFrame)).toBeNull();
  });

  it("returns null for an unknown entry type", () => {
    expect(parseNotebookFrame(frame({ type: "bogus", title: "x" }))).toBeNull();
  });

  it("returns null when title is missing", () => {
    expect(parseNotebookFrame(frame({ type: "note" }))).toBeNull();
  });
});

describe("mergeNotebookEntries", () => {
  const mk = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry =>
    ({ id, type: "note", title: id, timestamp: 0, ...over });

  it("dedupes by id, letting the authoritative (b) entry win", () => {
    const live = [mk("tc_1", { title: "provisional", timestamp: 5 })];
    const fetched = [mk("tc_1", { title: "authoritative", timestamp: 100, role: "agent" })];
    const merged = mergeNotebookEntries(live, fetched);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("authoritative");
  });

  it("sorts the union by timestamp", () => {
    const merged = mergeNotebookEntries([mk("a", { timestamp: 3 })], [mk("b", { timestamp: 1 })]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd web && npm test -- notebook`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the lib.**

```ts
// web/src/lib/notebook.ts
/**
 * Lab-notebook entry model + pure helpers shared by useAgent and the view.
 *
 * A live `tool_start` frame (toolName "notebook") carries only the model-
 * supplied fields — parseNotebookFrame builds a *provisional* entry from it
 * (client timestamp). The authoritative entry (server timestamp + role) comes
 * from GET /sessions/:id/notebook; mergeNotebookEntries reconciles the two by id.
 */
import type { AgentFrame } from "./use-agent";

export type NotebookEntryType =
  | "hypothesis" | "method" | "observation" | "decision" | "note";

const ENTRY_TYPES: readonly NotebookEntryType[] = [
  "hypothesis", "method", "observation", "decision", "note",
];

export interface NotebookEntry {
  id: string;
  type: NotebookEntryType;
  title: string;
  body?: string;
  artifacts?: string[];
  code?: { source: string; lang?: string };
  confidence?: "low" | "medium" | "high";
  tags?: string[];
  timestamp: number;
  role?: string;
}

function isEntryType(v: unknown): v is NotebookEntryType {
  return typeof v === "string" && (ENTRY_TYPES as readonly string[]).includes(v);
}

export function parseNotebookFrame(frame: AgentFrame): NotebookEntry | null {
  if (frame.type !== "tool_start" || frame.toolName !== "notebook") return null;
  const a = frame.args as Record<string, unknown> | undefined;
  if (!a || !isEntryType(a.type)) return null;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) return null;
  return {
    id: String(frame.toolCallId ?? title),
    type: a.type,
    title,
    body: typeof a.body === "string" ? a.body : undefined,
    artifacts: Array.isArray(a.artifacts) ? a.artifacts.map(String) : undefined,
    code:
      a.code && typeof (a.code as { source?: unknown }).source === "string"
        ? {
            source: String((a.code as { source: string }).source),
            lang: typeof (a.code as { lang?: unknown }).lang === "string"
              ? String((a.code as { lang: string }).lang)
              : undefined,
          }
        : undefined,
    confidence:
      a.confidence === "low" || a.confidence === "medium" || a.confidence === "high"
        ? a.confidence
        : undefined,
    tags: Array.isArray(a.tags) ? a.tags.map(String) : undefined,
    timestamp: Date.now(),
  };
}

export function mergeNotebookEntries(
  a: NotebookEntry[],
  b: NotebookEntry[],
): NotebookEntry[] {
  const byId = new Map<string, NotebookEntry>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e); // b (authoritative) wins on conflict
  return [...byId.values()].sort((x, y) => x.timestamp - y.timestamp);
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd web && npm test -- notebook`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add web/src/lib/notebook.ts web/src/lib/notebook.test.ts
git commit -m "feat(web): notebook lib — parse tool_start frames, merge/dedupe entries"
```

---

### Task 6: Accumulate `notebookEntries` in `useAgent`

**Files:**
- Modify: `web/src/lib/use-agent.ts` (imports; state ~line 256; live loop ~line 438; `reset` ~line 514; return ~line 526)

**Interfaces:**
- Consumes: `parseNotebookFrame`, `mergeNotebookEntries`, `NotebookEntry` from `./notebook`.
- Produces: `useAgent()` return object gains `notebookEntries: NotebookEntry[]`.

- [ ] **Step 1: Import.** Add near the top imports of `use-agent.ts`:

```ts
import { parseNotebookFrame, mergeNotebookEntries, type NotebookEntry } from "./notebook";
```

- [ ] **Step 2: Add state.** After `const [messages, setMessages] = useState<ChatMessage[]>([]);` (line 256):

```ts
  const [notebookEntries, setNotebookEntries] = useState<NotebookEntry[]>([]);
```

- [ ] **Step 3: Accumulate in the live loop.** In the SSE loop, immediately after `const frame = JSON.parse(jsonStr) as AgentFrame;` (line 438) and before `applyFrameToTranscript(...)`, add:

```ts
              const nb = parseNotebookFrame(frame);
              if (nb) setNotebookEntries((prev) => mergeNotebookEntries(prev, [nb]));
```

- [ ] **Step 4: Clear on reset.** In `reset` (line 514), after `setMessages([]);`, add:

```ts
    setNotebookEntries([]);
```

- [ ] **Step 5: Expose it.** In the return object (line 526), add `notebookEntries`:

```ts
  return { messages, status, send, stop, reset, getSessionId, loadSession, steer, pendingSteers, notebookEntries };
```

- [ ] **Step 6: Write a hook test.** Append to `web/src/lib/use-agent.test.ts` a test that drives a fake SSE stream containing a `tool_start` notebook frame and asserts `result.current.notebookEntries` gains the entry. Match the existing test's harness in that file (how it mocks `fetch`/stream and calls `send`). Minimal assertion:

```ts
it("accumulates notebook entries from tool_start frames", async () => {
  // ...set up the same fetch/stream mock the other tests use, emitting:
  //   {"type":"tool_start","toolName":"notebook","toolCallId":"tc_1",
  //    "args":{"type":"hypothesis","title":"Six types"}}
  // then await send(...) and:
  expect(result.current.notebookEntries.map((e) => e.id)).toEqual(["tc_1"]);
});
```

- [ ] **Step 7: Run tests + typecheck.**

Run: `cd web && npm test -- use-agent && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit.**

```bash
git add web/src/lib/use-agent.ts web/src/lib/use-agent.test.ts
git commit -m "feat(web): useAgent accumulates live notebook entries"
```

---

### Task 7: Entry card component

**Files:**
- Create: `web/src/components/lab-notebook-entry-card.tsx`
- Test: (covered by Task 9's view test; no standalone test)

**Interfaces:**
- Consumes: `NotebookEntry` from `@/lib/notebook`.
- Produces: `LabNotebookEntryCard({ entry, onOpenFile }: { entry: NotebookEntry; onOpenFile: (path: string) => void })`; `TYPE_META` map (exported for the view's legend/testing).

- [ ] **Step 1: Implement the card.** Uses existing markdown rendering if the repo has a shared renderer; otherwise render `body` as plain text with `whitespace-pre-wrap` (do NOT introduce a new markdown dep). Check `web/src/components/` for an existing markdown component (the chat renders markdown — reuse that component/import). Color + icon per type; artifact chips call `onOpenFile`; foldable code; confidence pill; relative time.

```tsx
// web/src/components/lab-notebook-entry-card.tsx
"use client";
import { useState } from "react";
import {
  LightbulbIcon, FlaskConicalIcon, BarChart3Icon, SignpostIcon, StickyNoteIcon,
  ChevronRightIcon, FileIcon,
} from "lucide-react";
import type { NotebookEntry, NotebookEntryType } from "@/lib/notebook";

export const TYPE_META: Record<
  NotebookEntryType,
  { label: string; Icon: typeof LightbulbIcon; spine: string; chip: string }
> = {
  hypothesis: { label: "Hypothesis", Icon: LightbulbIcon, spine: "bg-amber-400", chip: "text-amber-600 dark:text-amber-400" },
  method: { label: "Method", Icon: FlaskConicalIcon, spine: "bg-blue-400", chip: "text-blue-600 dark:text-blue-400" },
  observation: { label: "Observation", Icon: BarChart3Icon, spine: "bg-emerald-400", chip: "text-emerald-600 dark:text-emerald-400" },
  decision: { label: "Decision", Icon: SignpostIcon, spine: "bg-purple-400", chip: "text-purple-600 dark:text-purple-400" },
  note: { label: "Note", Icon: StickyNoteIcon, spine: "bg-neutral-400", chip: "text-neutral-500" },
};

export function LabNotebookEntryCard({
  entry,
  onOpenFile,
}: {
  entry: NotebookEntry;
  onOpenFile: (path: string) => void;
}) {
  const meta = TYPE_META[entry.type];
  const [codeOpen, setCodeOpen] = useState(false);
  return (
    <div className="relative pl-6" data-testid={`nb-entry-${entry.id}`} data-nb-type={entry.type}>
      <span className={`absolute left-0 top-0 h-full w-1 rounded ${meta.spine}`} aria-hidden />
      <div className="rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex items-center gap-2 text-xs">
          <meta.Icon className={`size-4 ${meta.chip}`} />
          <span className={`font-medium ${meta.chip}`}>{meta.label}</span>
          {entry.confidence && (
            <span className="ml-auto rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {entry.confidence}
            </span>
          )}
        </div>
        <h4 className="mt-1 text-sm font-semibold">{entry.title}</h4>
        {entry.body && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>
        )}
        {entry.code && (
          <div className="mt-2">
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setCodeOpen((o) => !o)}
            >
              <ChevronRightIcon className={`size-3 transition-transform ${codeOpen ? "rotate-90" : ""}`} />
              {entry.code.lang ?? "code"}
            </button>
            {codeOpen && (
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                <code>{entry.code.source}</code>
              </pre>
            )}
          </div>
        )}
        {entry.artifacts && entry.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {entry.artifacts.map((p) => (
              <button
                key={p}
                onClick={() => onOpenFile(p)}
                title={p}
                className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <FileIcon className="size-3 shrink-0" />
                <span className="truncate">{p.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

> Before finalizing, verify the icon names exist in the installed `lucide-react` (grep an existing component's imports); swap any missing icon for a present one. Verify `bg-card`, `bg-muted`, `text-muted-foreground` are the tokens this project uses (grep other components) — match whatever the codebase already uses.

- [ ] **Step 2: Typecheck.**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add web/src/components/lab-notebook-entry-card.tsx
git commit -m "feat(web): LabNotebookEntryCard — color-coded entry with artifact links"
```

---

### Task 8: The Lab Notebook view (timeline + reload merge + self-writing)

**Files:**
- Create: `web/src/components/lab-notebook-view.tsx`
- Test: `web/src/components/lab-notebook-view.test.tsx`

**Interfaces:**
- Consumes: `LabNotebookEntryCard` from `./lab-notebook-entry-card`; `NotebookEntry`, `mergeNotebookEntries` from `@/lib/notebook`; `apiFetch` from `@/lib/projects`.
- Produces: `LabNotebookView({ sessionId, liveEntries, streaming, onOpenFile }: { sessionId: string | null; liveEntries: NotebookEntry[]; streaming: boolean; onOpenFile: (path: string) => void })`.

- [ ] **Step 1: Write the failing test.**

```tsx
// web/src/components/lab-notebook-view.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LabNotebookView } from "./lab-notebook-view";
import type { NotebookEntry } from "@/lib/notebook";

vi.mock("@/lib/projects", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })),
  API_BASE: "http://x",
  getActiveProjectId: () => "default",
}));

const e = (over: Partial<NotebookEntry>): NotebookEntry =>
  ({ id: "tc_1", type: "hypothesis", title: "Six cell types", timestamp: 1, ...over });

describe("LabNotebookView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the empty state with no entries", () => {
    render(<LabNotebookView sessionId="s1" liveEntries={[]} streaming={false} onOpenFile={() => {}} />);
    expect(screen.getByText(/entries appear here/i)).toBeInTheDocument();
  });

  it("renders live entries with the right type", () => {
    render(<LabNotebookView sessionId="s1" liveEntries={[e({})]} streaming onOpenFile={() => {}} />);
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
    expect(screen.getByTestId("nb-entry-tc_1").getAttribute("data-nb-type")).toBe("hypothesis");
  });

  it("fires onOpenFile when an artifact chip is clicked", () => {
    const onOpenFile = vi.fn();
    render(
      <LabNotebookView
        sessionId="s1"
        liveEntries={[e({ artifacts: ["figures/fig08.png"] })]}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByTitle("figures/fig08.png"));
    expect(onOpenFile).toHaveBeenCalledWith("figures/fig08.png");
  });

  it("merges fetched entries from the backend on mount", async () => {
    const { apiFetch } = await import("@/lib/projects");
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [e({ id: "tc_persisted", title: "From disk" })] }),
    });
    render(<LabNotebookView sessionId="s1" liveEntries={[]} streaming={false} onOpenFile={() => {}} />);
    await waitFor(() => expect(screen.getByText("From disk")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd web && npm test -- lab-notebook-view`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the view.**

```tsx
// web/src/components/lab-notebook-view.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, DownloadIcon } from "lucide-react";
import { apiFetch, API_BASE, getActiveProjectId } from "@/lib/projects";
import { mergeNotebookEntries, type NotebookEntry } from "@/lib/notebook";
import { LabNotebookEntryCard } from "./lab-notebook-entry-card";

export function LabNotebookView({
  sessionId,
  liveEntries,
  streaming,
  onOpenFile,
}: {
  sessionId: string | null;
  liveEntries: NotebookEntry[];
  streaming: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [fetched, setFetched] = useState<NotebookEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Cold-open / reload: pull the durable entries whenever the session changes.
  useEffect(() => {
    let cancelled = false;
    setFetched([]);
    if (!sessionId) return;
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

  // Authoritative (fetched) entries win over provisional (live) ones by id.
  const entries = useMemo(
    () => mergeNotebookEntries(liveEntries, fetched),
    [liveEntries, fetched],
  );

  // Auto-scroll to the newest entry as it streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  const exportHref = sessionId
    ? `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/notebook/export?format=md&project=${encodeURIComponent(getActiveProjectId())}`
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
        <BookOpenIcon className="size-4" />
        <span className="font-medium">Lab Notebook</span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            writing…
          </span>
        )}
        {exportHref && entries.length > 0 && (
          <a
            href={exportHref}
            download={`lab-notebook-${sessionId}.md`}
            className="ml-auto inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
          >
            <DownloadIcon className="size-3" /> Export
          </a>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Kady’s notebook — entries appear here as it works.
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {entries.map((entry) => (
            <div key={entry.id} className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
              <LabNotebookEntryCard entry={entry} onOpenFile={onOpenFile} />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
```

> The `motion-safe:animate-in fade-in slide-in-from-bottom-1` classes are `tailwindcss-animate` utilities (already used by shadcn/ui in this project — grep to confirm; if absent, use a plain CSS `@keyframes` in `globals.css` guarded by `@media (prefers-reduced-motion: no-preference)`). `motion-safe:` already respects reduced-motion.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd web && npm test -- lab-notebook-view`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck.**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add web/src/components/lab-notebook-view.tsx web/src/components/lab-notebook-view.test.tsx
git commit -m "feat(web): LabNotebookView — self-writing timeline with reload merge + export"
```

---

### Task 9: Wire the view into the center panel + page

**Files:**
- Modify: `web/src/components/chat-tab.tsx` (`ChatTabMeta` ~line 857; `onMetaChange` call ~line 1043)
- Modify: `web/src/components/file-preview-panel.tsx` (`FilePreviewPanel` props + `TabBar` + body)
- Modify: `web/src/app/page.tsx` (state + `FilePreviewPanel` usage ~line 558)

**Interfaces:**
- Consumes: `LabNotebookView`; `useAgent().notebookEntries`.
- Produces: `ChatTabMeta.notebookEntries: NotebookEntry[]`; a pinned "Lab Notebook" tab in the center panel.

- [ ] **Step 1: Surface entries from the tab.** In `chat-tab.tsx`: import `NotebookEntry` from `@/lib/notebook`; pull `notebookEntries` out of `useAgent()`; add `notebookEntries: NotebookEntry[];` to `ChatTabMeta`; include `notebookEntries` in the `onMetaChange(tabId, {...})` payload (line 1043) and add it to that `useEffect`'s dependency array.

- [ ] **Step 2: Add props to `FilePreviewPanel`.** In `file-preview-panel.tsx`, extend the props with:

```ts
  showNotebook: boolean;
  onSelectNotebook: () => void;
  notebookSessionId: string | null;
  notebookEntries: NotebookEntry[];
  notebookStreaming: boolean;
  onOpenNotebookFile: (path: string) => void;
```

Render a pinned "Lab Notebook" button as the first item in `TabBar` (before the file tabs) — active when `showNotebook`, calling `onSelectNotebook` on click; selecting any file tab must set `showNotebook=false` (handled by the page via `onTabSelect`). In the panel body, when `showNotebook` is true render:

```tsx
<LabNotebookView
  sessionId={notebookSessionId}
  liveEntries={notebookEntries}
  streaming={notebookStreaming}
  onOpenFile={onOpenNotebookFile}
/>
```

otherwise render the existing `FileViewer` chain unchanged.

- [ ] **Step 3: Wire the page.** In `page.tsx`:
  - Add `const [showNotebook, setShowNotebook] = useState(false);`
  - Derive the active tab's notebook data from `tabsMeta[activeTabId]`: `const activeMeta = tabsMeta[activeTabId]; const notebookEntries = activeMeta?.notebookEntries ?? []; const notebookStreaming = activeMeta?.isStreaming ?? false;`
  - Change `handleFileSelect` to also `setShowNotebook(false)` (opening a file leaves the notebook).
  - Pass the new props to `<FilePreviewPanel>`:

```tsx
  showNotebook={showNotebook}
  onSelectNotebook={() => setShowNotebook(true)}
  notebookSessionId={activeSessionId}
  notebookEntries={notebookEntries}
  notebookStreaming={notebookStreaming}
  onOpenNotebookFile={handleFileSelect}
```

  (`handleFileSelect` already sets `showNotebook=false` per the change above, so clicking an artifact chip opens the file and switches away from the notebook.)

- [ ] **Step 4: Typecheck.**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full frontend suite.**

Run: `cd web && npm test`
Expected: PASS (except the two pre-existing baseline failures noted in Global Constraints).

- [ ] **Step 6: Manual verification (the wow, end-to-end).** Start the app (`./start.sh`), open a project, and prompt Kady (Opus 4.8) with a small task that will make it log entries (e.g. "Form a hypothesis about this dataset, run a quick check, and record your reasoning in the notebook as you go"). Confirm: the Lab Notebook tab pulses and fills with cards live; clicking an artifact chip opens that file; reloading the page and reopening the session re-renders the notebook from disk.

- [ ] **Step 7: Commit.**

```bash
git add web/src/components/chat-tab.tsx web/src/components/file-preview-panel.tsx web/src/app/page.tsx
git commit -m "feat(web): pin the Lab Notebook tab in the center panel, fed live from the active chat"
```

---

# PHASE 3 — Cross-links polish

Phase 2 already wires artifact chips → `onOpenFile` → the file preview. Phase 3 hardens the link experience.

### Task 10: Robust artifact opening + "open as file" for code

**Files:**
- Modify: `web/src/components/lab-notebook-entry-card.tsx`
- Test: `web/src/components/lab-notebook-view.test.tsx` (add cases)

**Interfaces:**
- Consumes: existing `onOpenFile`.
- Produces: an "Open as file" affordance on `code` entries whose `artifacts[0]` is a script path; graceful handling when an artifact path is missing.

- [ ] **Step 1: Write failing tests.** Add to `lab-notebook-view.test.tsx`:
  - A `method` entry with `code` and `artifacts: ["scripts/02_pipeline.py"]` shows an "Open as file" control that calls `onOpenFile("scripts/02_pipeline.py")`.
  - An entry with an empty `artifacts` array renders no chips (no crash).

```tsx
it("offers 'open as file' for code entries with a script artifact", () => {
  const onOpenFile = vi.fn();
  render(
    <LabNotebookView sessionId="s1" streaming={false} onOpenFile={onOpenFile}
      liveEntries={[{ id: "m1", type: "method", title: "Ran pipeline", timestamp: 1,
        code: { source: "print(1)", lang: "python" }, artifacts: ["scripts/02_pipeline.py"] }]} />,
  );
  fireEvent.click(screen.getByText(/open as file/i));
  expect(onOpenFile).toHaveBeenCalledWith("scripts/02_pipeline.py");
});
```

- [ ] **Step 2: Run to verify fail.** `cd web && npm test -- lab-notebook-view` → FAIL.

- [ ] **Step 3: Implement.** In `LabNotebookEntryCard`, when `entry.code` and `entry.artifacts?.[0]` matches a code extension (`/\.(py|r|jl|sh|ts|js|ipynb|sql)$/i`), render an "Open as file" button next to the code fold that calls `onOpenFile(entry.artifacts[0])`. Guard all `.map` over `artifacts` with a length check (already done in Task 7 — keep it).

- [ ] **Step 4: Run to verify pass.** `cd web && npm test -- lab-notebook-view` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add web/src/components/lab-notebook-entry-card.tsx web/src/components/lab-notebook-view.test.tsx
git commit -m "feat(web): notebook code entries offer open-as-file; harden artifact chips"
```

---

# PHASE 4 — Export (Markdown, then PDF)

### Task 11: Markdown export (server)

**Files:**
- Create: `server/src/agent/notebook-export.ts`
- Modify: `server/src/api/sessions.ts` (add export route)
- Test: `server/test/notebook-export.test.ts`, and add a route case to `server/test/notebook-routes.test.ts`

**Interfaces:**
- Consumes: `NotebookEntry`, `readNotebookEntries` from `./notebook-store.ts`.
- Produces: `notebookToMarkdown(entries: NotebookEntry[], opts: { sessionId: string; projectName?: string }): string`; `GET /sessions/:id/notebook/export?format=md`.

- [ ] **Step 1: Write the failing export test.**

```ts
// server/test/notebook-export.test.ts
import { describe, it, expect } from "vitest";
import { notebookToMarkdown } from "../src/agent/notebook-export.ts";
import type { NotebookEntry } from "../src/agent/notebook-store.ts";

const entries: NotebookEntry[] = [
  { id: "a", type: "hypothesis", title: "Six types", body: "k=6.", timestamp: 1000, role: "agent", confidence: "high" },
  { id: "b", type: "observation", title: "ARI 0.995", timestamp: 2000, role: "agent",
    artifacts: ["figures/fig08_silhouette.png", "data/counts.csv"],
    code: { source: "print('hi')", lang: "python" } },
];

describe("notebookToMarkdown", () => {
  const md = notebookToMarkdown(entries, { sessionId: "sess-1", projectName: "TME scRNA-seq" });

  it("has a titled header naming the project and session", () => {
    expect(md).toMatch(/# Lab Notebook/);
    expect(md).toMatch(/TME scRNA-seq/);
    expect(md).toMatch(/sess-1/);
  });

  it("renders each entry's type label and title", () => {
    expect(md).toMatch(/Hypothesis/);
    expect(md).toMatch(/Six types/);
    expect(md).toMatch(/Observation/);
  });

  it("embeds image artifacts as images and other files as links", () => {
    expect(md).toContain("![fig08_silhouette.png](figures/fig08_silhouette.png)");
    expect(md).toContain("[data/counts.csv](data/counts.csv)");
  });

  it("renders code as a fenced block with its language", () => {
    expect(md).toContain("```python");
    expect(md).toContain("print('hi')");
  });
});
```

- [ ] **Step 2: Run to verify fail.** `cd server && npm test -- notebook-export` → FAIL (module not found).

- [ ] **Step 3: Implement the exporter.**

```ts
// server/src/agent/notebook-export.ts
/**
 * Render notebook entries to a Markdown lab record: a header, then one section
 * per entry with type label, title, body, embedded image artifacts (other
 * files as links), and fenced code. Elapsed is derived from the first entry.
 */
import type { NotebookEntry, NotebookEntryType } from "./notebook-store.ts";

const LABEL: Record<NotebookEntryType, string> = {
  hypothesis: "Hypothesis",
  method: "Method",
  observation: "Observation",
  decision: "Decision",
  note: "Note",
};

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

export function notebookToMarkdown(
  entries: NotebookEntry[],
  opts: { sessionId: string; projectName?: string },
): string {
  const lines: string[] = [];
  lines.push(`# Lab Notebook`);
  if (opts.projectName) lines.push(`**Project:** ${opts.projectName}`);
  lines.push(`**Session:** ${opts.sessionId}`);
  if (entries.length > 0) {
    const start = new Date(entries[0].timestamp).toISOString();
    const end = new Date(entries[entries.length - 1].timestamp).toISOString();
    lines.push(`**Span:** ${start} → ${end}`);
    lines.push(`**Entries:** ${entries.length}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  const t0 = entries[0]?.timestamp ?? 0;
  for (const e of entries) {
    const elapsed = Math.max(0, Math.round((e.timestamp - t0) / 1000));
    lines.push(`## ${LABEL[e.type]}: ${e.title}`);
    const bits = [`+${elapsed}s`];
    if (e.confidence) bits.push(`confidence: ${e.confidence}`);
    if (e.tags?.length) bits.push(e.tags.map((t) => `#${t}`).join(" "));
    lines.push(`_${bits.join(" · ")}_`);
    lines.push("");
    if (e.body) { lines.push(e.body); lines.push(""); }
    if (e.code) {
      lines.push("```" + (e.code.lang ?? ""));
      lines.push(e.code.source);
      lines.push("```");
      lines.push("");
    }
    if (e.artifacts?.length) {
      for (const p of e.artifacts) {
        const name = p.split("/").pop() ?? p;
        lines.push(IMAGE_RE.test(p) ? `![${name}](${p})` : `[${p}](${p})`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify pass.** `cd server && npm test -- notebook-export` → PASS (4 tests).

- [ ] **Step 5: Add the export route.** In `sessions.ts`, import `notebookToMarkdown` and `getProject` (to fetch the project name — check `server/src/projects.ts` for the accessor; use `currentProjectId()` if a name accessor isn't handy). Register:

```ts
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/notebook/export",
    async (req, reply) => {
      const format = req.query.format ?? "md";
      if (format !== "md") {
        reply.code(400);
        return { detail: "Only format=md is supported (PDF is exported client-side)" };
      }
      try {
        const projectId = currentProjectId();
        const entries = readNotebookEntries(req.params.id, projectId);
        const md = notebookToMarkdown(entries, { sessionId: req.params.id, projectName: projectId });
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="lab-notebook-${req.params.id}.md"`,
        );
        return md;
      } catch (exc) {
        reply.code(400);
        return { detail: (exc as Error).message };
      }
    },
  );
```

- [ ] **Step 6: Add a route test.** In `notebook-routes.test.ts` add: after appending entries, `GET /sessions/route-sess/notebook/export?format=md` returns 200 with `content-type` containing `text/markdown` and a body matching `/# Lab Notebook/`; `?format=pdf` returns 400.

- [ ] **Step 7: Run + typecheck.** `cd server && npm test -- notebook && npm run typecheck` → PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add server/src/agent/notebook-export.ts server/src/api/sessions.ts server/test/notebook-export.test.ts server/test/notebook-routes.test.ts
git commit -m "feat(server): Markdown export of the lab notebook (GET /notebook/export)"
```

---

### Task 12: PDF export (client print)

**Files:**
- Modify: `web/src/components/lab-notebook-view.tsx` (add a "PDF" action)
- Test: `web/src/components/lab-notebook-view.test.tsx` (assert the button exists + calls the handler)

**Interfaces:**
- Consumes: existing `entries` in the view.
- Produces: a print-to-PDF action that opens a print-styled window of the rendered notebook and calls `window.print()`.

- [ ] **Step 1: Write failing test.** Add a case: with entries present, a "PDF" button renders; clicking it calls a mocked `window.open` (mock `window.open` to return an object with `document.write`, `document.close`, `focus`, `print`). Assert `print` is called.

- [ ] **Step 2: Run to verify fail.** `cd web && npm test -- lab-notebook-view` → FAIL.

- [ ] **Step 3: Implement.** Add a `PDF` button next to `Export`. Its handler builds a self-contained HTML string from `entries` (headings + bodies + `<img src>` using `API_BASE + /sandbox/raw?path=` for image artifacts, matching `use-sandbox.ts`'s `rawUrl`), opens a new window, writes the HTML with a print stylesheet, and calls `print()`. Guard `window.open` returning `null` (popup blocked) — show nothing / no throw.

- [ ] **Step 4: Run to verify pass.** `cd web && npm test -- lab-notebook-view` → PASS.

- [ ] **Step 5: Typecheck + manual check.** `cd web && npx tsc --noEmit`. Manually: run a session that logs entries with a figure artifact, click PDF, confirm the print preview shows the notebook with the figure embedded.

- [ ] **Step 6: Commit.**

```bash
git add web/src/components/lab-notebook-view.tsx web/src/components/lab-notebook-view.test.tsx
git commit -m "feat(web): export the lab notebook to PDF via print (figures embedded)"
```

---

### Task 13: Docs

**Files:**
- Modify: `docs/file-previews.md` (or create `docs/lab-notebook.md` if that reads better) and `AGENTS.md` (a one-line caveat)

- [ ] **Step 1: Document the feature.** Add a short section describing the Living Lab Notebook: what it is, that Kady authors entries via the `notebook` tool, where they persist (`sandbox/.kady/notebook/<sessionId>.jsonl`), the center-panel tab, and MD/PDF export. In `AGENTS.md`, add a one-line caveat mirroring the interview/modal notes: "`notebook` is an in-process custom tool (like `interview`/`modal_run`), so sub-agent child processes do not see it (Phase 5 follow-on promotes it to a Pi package)."

- [ ] **Step 2: Commit.**

```bash
git add docs/ AGENTS.md
git commit -m "docs: Living Lab Notebook feature + notebook-tool caveat"
```

---

# PHASE 5 — Subagent lanes (follow-on; re-plan as its own spec→plan)

**Why this is a separate cycle:** letting subagents contribute entries requires promoting the in-process `notebook` tool to a **Pi package** so pi-subagents' child `pi` CLI processes discover it — the same non-trivial wiring `server/src/agent/web-access-bridge.ts` does for `pi-web-access` (reference the local package from `sandbox/.pi/settings.json` "packages", pre-trust the sandbox in `<agentDir>/trust.json`, and route child writes to the same notebook store keyed by `role`). Per the project memory note on child-process package wiring, this is intricate and best validated against the *then-current* web-access-bridge pattern rather than pre-planned in detail now. The sketch below is the intended shape; turn it into its own spec + plan after Phases 1–4 ship.

**Sketch (not bite-sized — to be re-planned):**
1. Extract the notebook entry-writing into a tiny Pi extension package (a local package dir with an extension that registers a `notebook` tool writing to `sandbox/.kady/notebook/<sessionId>.jsonl`, stamping `role` from the child's agent name). Model directory layout + `package.json` on the installed `pi-web-access`.
2. Add a `notebook-bridge.ts` mirroring `web-access-bridge.ts`: `seedNotebookPackage(paths)` (settings.json "packages" entry) + reuse the existing `ProjectTrustStore` pre-trust already done by `ensureWebAccess`. Call it from `build()` in `session-registry.ts`.
3. Remove the in-process `notebookTool` (now provided by the package) OR keep in-process for the lead agent and ensure a single writer contract (no double-write for the lead). Decide during re-planning.
4. Frontend: group entries by `role` into lanes in `LabNotebookView` (lead lane + one per subagent); the entry model already carries `role`.
5. Tests: child-process integration (a subagent run produces a `role`-stamped entry in the store), lane rendering.

---

## Self-Review

**1. Spec coverage:**
- Data model (entry types + server-stamped fields) → Task 1 (store types) + Task 2 (tool stamping). ✅
- Non-blocking agent-authored tool + prompt guidelines → Task 2. ✅
- In-process registration (lead-agent-only) → Task 3. ✅
- SSE reuses `tool_start` (no new frame) → Task 5/6 (parse `tool_start`); no server frame change needed. ✅
- Persistence to `.kady/notebook/<sessionId>.jsonl` → Task 1. ✅
- `GET /sessions/:id/notebook` → Task 4. ✅
- Center-panel first-class "Notebook" tab; chat stays right → Task 9. ✅
- Self-writing timeline, color-coded cards, confidence pill, code fold, timestamps → Tasks 7, 8. ✅
- Cross-links (artifact chips open files; open-as-file) → Tasks 7 (chips), 10 (open-as-file). ✅
- Live merge with GET, dedupe by id → Task 5 (merge) + Task 8 (view merge). ✅
- Reduced-motion → Task 8 (`motion-safe:`). ✅
- Empty state → Task 8. ✅
- Export MD then PDF → Tasks 11, 12. ✅
- Error handling (malformed → typebox/parse guards; persistence hiccup → soft error; missing artifact → preview's own not-found) → Task 2 (soft error), Task 1/5 (parse guards), Task 9 (chip → existing preview). ✅
- Long-run performance: entries render in a scroll container; virtualization is NOT implemented in this plan. **Gap flagged:** the spec mentions windowing/virtualization for very long runs. Decision: defer — a scrolling list handles realistic entry counts (tens–low hundreds) fine, and virtualization adds a dependency + complexity not worth it for v1. Noted here so it's a conscious omission, not an oversight. If runs routinely exceed ~500 entries, add react-virtual in a fast-follow.
- Subagent lanes → Phase 5 (explicit follow-on). ✅
- Testing (backend + frontend suites; Opus/GPT-5.5 for manual) → per-task tests + Global Constraints. ✅

**2. Placeholder scan:** No "TBD/TODO/implement later". Every code step shows complete code. The three "verify against the codebase" notes (scope helper name in Task 4; icon/token names in Task 7; `tailwindcss-animate` in Task 8; project-name accessor in Task 11) are explicit verification instructions with a concrete fallback, not placeholders — they exist because these are the few spots where an exact repo detail must be confirmed at implementation time.

**3. Type consistency:** `NotebookEntry`/`NotebookEntryInput` field names identical across backend (`notebook-store.ts`) and frontend (`notebook.ts`). `id === toolCallId` used consistently as the dedupe key (Task 2 stamps it; Task 5 reads `frame.toolCallId`; Task 8 merges by `id`). `notebookToMarkdown(entries, opts)` signature matches between Task 11's implementation, test, and route. `makeNotebookTool(projectId, getSessionId)` matches between Task 2 and Task 3. `mergeNotebookEntries(a, b)` — b wins — used consistently (Task 5 defines, Task 8 calls with `(liveEntries, fetched)` so fetched/authoritative wins). ✅
