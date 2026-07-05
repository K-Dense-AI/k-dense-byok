# Mid-Run Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user inject a message into the agent's *live* run (Pi `session.steer()`) from the chat composer — Enter steers, Alt+Enter keeps today's queue-a-new-run behavior, Stop restores undelivered steers to the composer.

**Architecture:** A new `POST /sessions/:id/steer` side-channel queues the message on the live Pi session; the existing `/run` SSE stream remains the only event channel (already-mapped `queue_update` frames report pending steers; an enriched `message_start` frame marks the delivery point). The frontend replaces its single-assistant-bubble stream loop with a pure transcript reducer so a run can contain user (steer) messages mid-stream.

**Tech Stack:** Fastify + Pi SDK (`@earendil-works/pi-coding-agent`) on the server; Next.js 16 / React 19 + vitest on the web side.

**Spec:** `docs/superpowers/specs/2026-07-05-mid-run-steering-design.md`

## Global Constraints

- Node ≥ 22.19 for the server; run via `tsx`, never `tsc` for emit (`tsconfig.json` is noEmit).
- Server tests: `cd server && npm test` (vitest; `KADY_PROJECTS_ROOT` points at a temp dir via `vitest.config.ts`). Typecheck: `npm run typecheck`.
- Web tests: `cd web && npm test`. Typecheck: `npx tsc --noEmit`.
- Do not change the `/run` endpoint's contract or the `activeRuns` guard.
- Pi `followUp()` is NOT used anywhere — the client-side "run after" queue covers deferred work.
- Steering chips have no per-item remove in v1. Pending steers have no client-side cap; `MAX_QUEUE` (5) applies only to the run-after queue.
- Match the repo's comment style: comments state constraints/why, not what-the-next-line-does.

---

### Task 1: `events.ts` — user-message content on `message_start`

**Files:**
- Modify: `server/src/agent/events.ts` (the `message_start` case, ~line 90)
- Test: `server/test/backend.test.ts` (inside the existing `describe("events → client frames")`, ~line 257)

**Interfaces:**
- Produces: `toClientFrame` now returns `{ type: "message_start", role: "user", content: string }` for user messages (assistant/other roles keep `{ type, role }` with no `content`). Task 4's reducer consumes `frame.content`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("events → client frames")` block in `server/test/backend.test.ts`:

```ts
  it("includes content on user message_start (string and content-array forms)", () => {
    expect(
      toClientFrame({
        type: "message_start",
        message: { role: "user", content: "exclude sample 7" },
      } as never),
    ).toEqual({ type: "message_start", role: "user", content: "exclude sample 7" });

    expect(
      toClientFrame({
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "look at" },
            { type: "image", data: "…", mimeType: "image/png" },
            { type: "text", text: "plot.png" },
          ],
        },
      } as never),
    ).toEqual({ type: "message_start", role: "user", content: "look at\nplot.png" });
  });

  it("omits content on assistant message_start", () => {
    expect(
      toClientFrame({
        type: "message_start",
        message: { role: "assistant", content: "internal" },
      } as never),
    ).toEqual({ type: "message_start", role: "assistant" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/backend.test.ts -t "message_start"`
Expected: FAIL — received `{ type: "message_start", role: "user" }` (no `content`).

- [ ] **Step 3: Implement**

In `server/src/agent/events.ts`, add this helper above `toClientFrame` (next to `resultText`):

```ts
/** Flatten a user message's content (string or content-part array) to plain
 *  text. Image parts are dropped — the UI renders steered messages as text. */
function userMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
```

Replace the `message_start` case:

```ts
    case "message_start": {
      const role = (ev.message as { role?: string }).role;
      // User content marks the exact point a steered message was delivered
      // into the run, so the client can split the transcript there.
      if (role === "user") {
        return { type: "message_start", role, content: userMessageText(ev.message) };
      }
      return { type: "message_start", role };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/backend.test.ts`
Expected: PASS (all — the untouched cases must stay green).

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/events.ts server/test/backend.test.ts
git commit -m "feat(server): include user message content on message_start frames"
```

---

### Task 2: Server — `POST /sessions/:id/steer`

**Files:**
- Modify: `server/src/api/sessions.ts` (add route after the `/abort` route, ~line 188)
- Create: `server/test/steer-abort.test.ts`

**Interfaces:**
- Consumes: `getSession(projectId, paths, id)` from `server/src/agent/session-registry.ts`; `isBudgetExceeded(projectId)` from `server/src/cost/ledger.ts` (both already imported in `sessions.ts`); Pi session methods `isStreaming`, `steer(text)`, `getSteeringMessages()`, `clearQueue()`.
- Produces: HTTP contract used by Task 5's `steer()`:
  - 404 `{ detail }` unknown session
  - 400 `{ detail }` empty message
  - 409 `{ detail, reason: "not_streaming" }` no live run (also when the run ends while queueing)
  - 403 `{ detail, reason: "budget" }` spend cap reached
  - 200 `{ ok: true, pending: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `server/test/steer-abort.test.ts`:

```ts
/**
 * HTTP-level tests for the steering side-channel and abort queue restore.
 * The session registry is mocked so no real Pi session (auth, model) is
 * needed; the fake exposes exactly the surface the routes touch.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const fakeSessions = new Map<string, FakeSession>();

class FakeSession {
  isStreaming = true;
  steered: string[] = [];
  aborted = false;
  clearQueueCalls = 0;
  /** Called by steer(); lets a test flip isStreaming mid-call. */
  onSteer: (() => void) | null = null;

  async steer(text: string): Promise<void> {
    this.steered.push(text);
    this.onSteer?.();
  }
  getSteeringMessages(): readonly string[] {
    return this.steered;
  }
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const steering = [...this.steered];
    this.steered = [];
    return { steering, followUp: [] };
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

vi.mock("../src/agent/session-registry.ts", () => ({
  getAuthStorage: vi.fn(),
  getModelRegistry: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(async (_projectId: string, _paths: unknown, id: string) =>
    fakeSessions.get(id) ?? null,
  ),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";

const app = await buildApp();

beforeEach(() => {
  fakeSessions.clear();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function steer(id: string, body: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/steer`,
    headers: { "x-project-id": projectId, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });
}

describe("POST /sessions/:id/steer", () => {
  it("404s for an unknown session", async () => {
    const res = await steer("nope", { message: "hi" });
    expect(res.statusCode).toBe(404);
  });

  it("400s for an empty message", async () => {
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("409s with reason not_streaming when no run is live", async () => {
    const s = new FakeSession();
    s.isStreaming = false;
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
    expect(s.steered).toEqual([]);
  });

  it("queues the message and returns the pending list", async () => {
    const s = new FakeSession();
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "exclude sample 7" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pending: ["exclude sample 7"] });
    expect(s.steered).toEqual(["exclude sample 7"]);
  });

  it("409s and clears the queue when the run ends while queueing", async () => {
    const s = new FakeSession();
    s.onSteer = () => {
      s.isStreaming = false;
    };
    fakeSessions.set("s1", s);
    const res = await steer("s1", { message: "too late" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
    // The stale steer must not leak into the next run.
    expect(s.clearQueueCalls).toBe(1);
    expect(s.steered).toEqual([]);
  });

  it("403s with reason budget when the project cap is reached", async () => {
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "s1",
      projectId: p.id,
      model: "m",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    fakeSessions.set("s1", new FakeSession());
    const res = await steer("s1", { message: "hi" }, p.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "budget" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/steer-abort.test.ts`
Expected: FAIL — every steer test gets 404 (route not registered; Fastify returns 404 for unknown URLs).

- [ ] **Step 3: Implement the route**

In `server/src/api/sessions.ts`, add after the `/abort` route (before the `/run` route):

```ts
  // Steering side-channel: queue a message into the LIVE run (delivered by Pi
  // after the current tool calls, before the next LLM call). Never creates a
  // run or an SSE stream — the /run stream carries the delivery + queue_update
  // frames. 409 reason "not_streaming" tells the client to fall back to a
  // normal run.
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/sessions/:id/steer",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      // A steer extends a live run's spend past what the run-start check
      // gated, so re-check the cap here.
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      await session.steer(message);
      // The run can end between the guard and the queue write; a steer left
      // behind would silently deliver into the NEXT run, so pull it back out.
      if (!session.isStreaming) {
        session.clearQueue();
        reply.code(409);
        return { detail: "Run ended before the message was delivered", reason: "not_streaming" };
      }
      return { ok: true, pending: [...session.getSteeringMessages()] };
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/steer-abort.test.ts`
Expected: PASS for all `POST /sessions/:id/steer` tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npm run typecheck
git add server/src/api/sessions.ts server/test/steer-abort.test.ts
git commit -m "feat(server): steering side-channel POST /sessions/:id/steer"
```

---

### Task 3: Server — abort returns the cleared queue

**Files:**
- Modify: `server/src/api/sessions.ts` (the `/abort` route, ~line 184)
- Test: `server/test/steer-abort.test.ts` (extend)

**Interfaces:**
- Produces: `POST /sessions/:id/abort` → `{ ok: true, restored: string[] }` (empty array when no session or nothing queued). Task 5's `stop()` consumes `restored`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/steer-abort.test.ts`:

```ts
describe("POST /sessions/:id/abort", () => {
  it("clears the queue before aborting and returns the texts", async () => {
    const s = new FakeSession();
    await s.steer("pending steer");
    fakeSessions.set("s1", s);
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: ["pending steer"] });
    expect(s.aborted).toBe(true);
    expect(s.clearQueueCalls).toBe(1);
  });

  it("returns ok with empty restored for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions/nope/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/steer-abort.test.ts -t "abort"`
Expected: FAIL — body is `{ ok: true }` with no `restored`.

- [ ] **Step 3: Implement**

Replace the `/abort` route in `server/src/api/sessions.ts`:

```ts
  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const session = await getSession(currentProjectId(), activePaths(), req.params.id);
    if (!session) return { ok: true, restored: [] };
    // Clear BEFORE abort so a pending steer can't be delivered into the
    // dying loop; the texts go back to the composer client-side.
    const cleared = session.clearQueue();
    await session.abort();
    return { ok: true, restored: [...cleared.steering, ...cleared.followUp] };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/steer-abort.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Run the full server suite, typecheck, commit**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

```bash
git add server/src/api/sessions.ts server/test/steer-abort.test.ts
git commit -m "feat(server): abort clears the steering queue and returns it for composer restore"
```

---

### Task 4: Web — `applyFrameToTranscript` pure reducer

**Files:**
- Modify: `web/src/lib/use-agent.ts` (add exports next to `applyFrameToMessage`; extend `AgentFrame`)
- Test: `web/src/lib/use-agent-events.test.ts` (extend)

**Interfaces:**
- Consumes: `applyFrameToMessage(message, frame, now)` and `ChatMessage` (existing, same file).
- Produces (used verbatim by Task 5):

```ts
export interface TranscriptRunState {
  assistantId: string;
  sawPromptEcho: boolean;
}
export interface TranscriptResult {
  messages: ChatMessage[];
  state: TranscriptRunState;
  steering: string[] | null;
}
export function applyFrameToTranscript(
  messages: ChatMessage[],
  state: TranscriptRunState,
  frame: AgentFrame,
  nextId: () => string,
  now?: number,
): TranscriptResult;
```

- [ ] **Step 1: Write the failing tests**

Add to `web/src/lib/use-agent-events.test.ts`:

```ts
import {
  applyFrameToTranscript,
  type TranscriptRunState,
} from "@/lib/use-agent";

describe("applyFrameToTranscript", () => {
  const start = (): { messages: ChatMessage[]; state: TranscriptRunState } => ({
    messages: [
      { id: "u1", role: "user", content: "run the analysis", timestamp: 1 },
      { id: "a1", role: "assistant", content: "", timestamp: 1 },
    ],
    state: { assistantId: "a1", sawPromptEcho: false },
  });
  const makeNextId = () => {
    let n = 100;
    return () => String(++n);
  };

  it("skips the first user message_start (the prompt echo)", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      makeNextId(),
      5,
    );
    expect(r.messages).toBe(messages);
    expect(r.state.sawPromptEcho).toBe(true);
  });

  it("splits the transcript on a delivered steer", () => {
    const { messages, state } = start();
    const nextId = makeNextId();
    let r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      nextId,
      5,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "text_delta", delta: "starting" },
      nextId,
      6,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "message_start", role: "user", content: "exclude sample 7" },
      nextId,
      7,
    );
    expect(r.messages).toHaveLength(4);
    expect(r.messages[1]).toMatchObject({ id: "a1", content: "starting" });
    expect(r.messages[2]).toMatchObject({ role: "user", content: "exclude sample 7" });
    expect(r.messages[3]).toMatchObject({ role: "assistant", content: "" });
    // Later frames land on the NEW bubble.
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "text_delta", delta: "ok, excluding" },
      nextId,
      8,
    );
    expect(r.messages[3].content).toBe("ok, excluding");
    expect(r.messages[1].content).toBe("starting");
  });

  it("lands the cost frame on the last assistant bubble", () => {
    const { messages, state } = start();
    const nextId = makeNextId();
    let r = applyFrameToTranscript(
      messages,
      state,
      { type: "message_start", role: "user", content: "run the analysis" },
      nextId,
      5,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "message_start", role: "user", content: "steer" },
      nextId,
      6,
    );
    r = applyFrameToTranscript(
      r.messages,
      r.state,
      { type: "cost", runCost: 0.5, runTokens: 42 },
      nextId,
      7,
    );
    const last = r.messages[r.messages.length - 1];
    expect(last).toMatchObject({ runCostUsd: 0.5, runTokens: 42 });
    expect(r.messages[1].runCostUsd).toBeUndefined();
  });

  it("reports pending steering from queue_update without touching messages", () => {
    const { messages, state } = start();
    const r = applyFrameToTranscript(
      messages,
      state,
      { type: "queue_update", steering: ["a", "b"], followUp: [] },
      makeNextId(),
      5,
    );
    expect(r.steering).toEqual(["a", "b"]);
    expect(r.messages).toBe(messages);
  });

  it("ignores a user message_start without content after the echo", () => {
    const { messages } = start();
    const r = applyFrameToTranscript(
      messages,
      { assistantId: "a1", sawPromptEcho: true },
      { type: "message_start", role: "user" },
      makeNextId(),
      5,
    );
    expect(r.messages).toBe(messages);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/use-agent-events.test.ts`
Expected: FAIL — `applyFrameToTranscript` is not exported.

- [ ] **Step 3: Implement**

In `web/src/lib/use-agent.ts`, extend `AgentFrame` (add two optional fields to the existing interface):

```ts
  role?: string;
  content?: string;
  steering?: unknown;
```

Add below `applyFrameToMessage`:

```ts
export interface TranscriptRunState {
  /** Id of the assistant bubble frames currently apply to. */
  assistantId: string;
  /** True once the run's own prompt echoed back as a user message_start. */
  sawPromptEcho: boolean;
}

export interface TranscriptResult {
  messages: ChatMessage[];
  state: TranscriptRunState;
  /** Pending steering texts when the frame updated them; null otherwise. */
  steering: string[] | null;
}

/**
 * Apply one SSE frame to a run's transcript. Pure; returns the input
 * `messages` reference when nothing changed so callers can skip re-renders.
 * A user message_start after the initial prompt echo is a delivered steering
 * message: it closes the current assistant bubble and opens a new one.
 */
export function applyFrameToTranscript(
  messages: ChatMessage[],
  state: TranscriptRunState,
  frame: AgentFrame,
  nextId: () => string,
  now = Date.now(),
): TranscriptResult {
  if (frame.type === "queue_update") {
    const steering = Array.isArray(frame.steering) ? frame.steering.map(String) : [];
    return { messages, state, steering };
  }
  if (frame.type === "message_start" && frame.role === "user") {
    if (!state.sawPromptEcho) {
      return { messages, state: { ...state, sawPromptEcho: true }, steering: null };
    }
    const content = typeof frame.content === "string" ? frame.content : "";
    if (!content.trim()) return { messages, state, steering: null };
    const userId = nextId();
    const assistantId = nextId();
    return {
      messages: [
        ...messages,
        { id: userId, role: "user", content, timestamp: now },
        { id: assistantId, role: "assistant", content: "", timestamp: now },
      ],
      state: { ...state, assistantId },
      steering: null,
    };
  }
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== state.assistantId) return m;
    const applied = applyFrameToMessage(m, frame, now);
    if (applied !== m) changed = true;
    return applied;
  });
  return { messages: changed ? next : messages, state, steering: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/use-agent-events.test.ts`
Expected: PASS (all, including the pre-existing `applyFrameToMessage` tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/use-agent.ts web/src/lib/use-agent-events.test.ts
git commit -m "feat(web): pure transcript reducer for multi-message (steered) runs"
```

---

### Task 5: Web — wire the reducer, `steer()`, `pendingSteers`, and `stop()` restore into `useAgent`

**Files:**
- Modify: `web/src/lib/use-agent.ts` (the `useAgent` hook body: `send`, `stop`, `reset`, return value)

**Interfaces:**
- Consumes: Task 4's `applyFrameToTranscript`; Task 2's `/steer` contract; Task 3's `restored` field.
- Produces (consumed by Task 6):
  - `steer(text: string): Promise<"ok" | "not_streaming" | "error">`
  - `pendingSteers: string[]`
  - `stop(): Promise<string[]>` (was `() => void`; resolves with restored texts)

No new unit tests in this task — the frame logic is covered by Task 4's pure tests; the hook wiring is verified by typecheck, the existing suite, and Task 7's manual pass.

- [ ] **Step 1: Add `pendingSteers` state and the `steer` function**

In `useAgent`, next to the existing state:

```ts
  const [pendingSteers, setPendingSteers] = useState<string[]>([]);
```

Add after `ensureSession`:

```ts
  /** Queue a message into the live run. "not_streaming" = the run ended
   *  first; the caller should fall back to a normal send. */
  const steer = useCallback(
    async (text: string): Promise<"ok" | "not_streaming" | "error"> => {
      const id = sessionIdRef.current;
      if (!id) return "not_streaming";
      try {
        const res = await apiFetch(`/sessions/${id}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (res.ok) {
          const data = (await res.json()) as { pending?: unknown };
          if (Array.isArray(data.pending)) setPendingSteers(data.pending.map(String));
          return "ok";
        }
        return res.status === 409 ? "not_streaming" : "error";
      } catch {
        return "error";
      }
    },
    [],
  );
```

- [ ] **Step 2: Replace the single-bubble stream loop in `send()`**

Replace the two optimistic `setMessages` calls (user then assistant, ~lines 263–274) with one that also captures a local snapshot, and drop the `updateAssistant` helper in favor of transcript-based updates. The frame decisions run OUTSIDE React updaters (so id generation and run-state advances can't double-fire under StrictMode); `transcript` is authoritative during the run because nothing else writes `messages` while a run streams (the queue effect only fires on `status === "ready"`, `loadSession` refuses once bound):

```ts
      const userMsgId = nextId();
      const assistantId = nextId();
      let runState: TranscriptRunState = { assistantId, sawPromptEcho: false };
      let transcript: ChatMessage[] = [];
      setMessages((prev) => {
        transcript = [
          ...prev,
          { id: userMsgId, role: "user", content: text, timestamp: Date.now() },
          { id: assistantId, role: "assistant", content: "", timestamp: Date.now() },
        ];
        return transcript;
      });
      setStatus("submitted");
```

In the SSE read loop, replace `updateAssistant((m) => applyFrameToMessage(m, frame));` with:

```ts
              const r = applyFrameToTranscript(transcript, runState, frame, nextId);
              transcript = r.messages;
              runState = r.state;
              if (r.steering) setPendingSteers(r.steering);
              setMessages(transcript);
```

Replace the post-loop cleanup (`updateAssistant` marking activities complete) with a transcript-wide sweep:

```ts
        transcript = transcript.map((m) =>
          m.role === "assistant" && m.activities?.some((a) => a.status === "running")
            ? {
                ...m,
                activities: m.activities.map((a) =>
                  a.status === "running" ? { ...a, status: "complete" as const } : a,
                ),
              }
            : m,
        );
        setMessages(transcript);
        setPendingSteers([]);
        setStatus("ready");
```

Replace the `catch` block's `updateAssistant` with the same pattern targeting the LAST bubble (`runState.assistantId`):

```ts
      } catch (err: unknown) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        transcript = transcript.map((m) => {
          const isCurrent = m.id === runState.assistantId;
          const activities = (m.activities ?? []).map((a) =>
            a.status === "running"
              ? { ...a, status: (aborted ? "complete" : "error") as ActivityItem["status"] }
              : a,
          );
          if (!isCurrent) return m.activities ? { ...m, activities } : m;
          return {
            ...m,
            content: aborted
              ? m.content
              : m.content || "Something went wrong. Please try again.",
            activities,
          };
        });
        setMessages(transcript);
        setPendingSteers([]);
        setStatus(aborted ? "ready" : "error");
      } finally {
```

(`ActivityItem` is already defined in this file; no new imports.)

- [ ] **Step 3: Make `stop()` return the restored texts and clear steers on `reset()`**

```ts
  const stop = useCallback(async (): Promise<string[]> => {
    abortRef.current?.abort();
    const id = sessionIdRef.current;
    let restored: string[] = [];
    if (id) {
      try {
        const res = await apiFetch(`/sessions/${id}/abort`, { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { restored?: unknown };
          if (Array.isArray(data.restored)) restored = data.restored.map(String);
        }
      } catch {
        /* abort is best-effort; restore is a bonus */
      }
    }
    setPendingSteers([]);
    setStatus("ready");
    return restored;
  }, []);
```

In `reset()`, add `setPendingSteers([]);` after `setMessages([]);`.

- [ ] **Step 4: Extend the hook's return value**

```ts
  return { messages, status, send, stop, reset, getSessionId, loadSession, steer, pendingSteers };
```

- [ ] **Step 5: Typecheck and run the web suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: PASS. (`chat-tab.tsx` still compiles: `stop`'s widened return type is assignable to its existing `onStop: () => void` usage.)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/use-agent.ts
git commit -m "feat(web): useAgent steering — steer(), pendingSteers, stop() returns restored queue"
```

---

### Task 6: Web — composer routing, steering chips, stop restore

**Files:**
- Create: `web/src/lib/chat-routing.ts`
- Create: `web/src/lib/chat-routing.test.ts`
- Modify: `web/src/components/chat-tab.tsx` (ChatInput props/submit/keydown/placeholder/tooltips, `MessageQueueDisplay`, ChatTab handleSend/handleStop/render)

**Interfaces:**
- Consumes: Task 5's `steer` / `pendingSteers` / `stop`.
- Produces:

```ts
// web/src/lib/chat-routing.ts
export type SendIntent = "auto" | "queue";
export type SubmitRoute = "send" | "steer" | "queue";
export function routeSubmit(isStreaming: boolean, intent: SendIntent): SubmitRoute;
export function steerNotStreamingFallback(queueLength: number): "queue" | "send";
```

- [ ] **Step 1: Write the failing routing tests**

Create `web/src/lib/chat-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { routeSubmit, steerNotStreamingFallback } from "@/lib/chat-routing";

describe("routeSubmit", () => {
  it("sends normally when idle, regardless of intent", () => {
    expect(routeSubmit(false, "auto")).toBe("send");
    expect(routeSubmit(false, "queue")).toBe("send");
  });
  it("steers by default while streaming", () => {
    expect(routeSubmit(true, "auto")).toBe("steer");
  });
  it("queues on explicit intent while streaming", () => {
    expect(routeSubmit(true, "queue")).toBe("queue");
  });
});

describe("steerNotStreamingFallback", () => {
  it("preserves order behind a non-empty queue", () => {
    expect(steerNotStreamingFallback(2)).toBe("queue");
  });
  it("sends directly when the queue is empty", () => {
    expect(steerNotStreamingFallback(0)).toBe("send");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/chat-routing.test.ts`
Expected: FAIL — module `@/lib/chat-routing` does not exist.

- [ ] **Step 3: Implement the routing module**

Create `web/src/lib/chat-routing.ts`:

```ts
/**
 * Submit routing for the chat composer. While a run streams, Enter steers
 * the live run and Alt+Enter queues a NEW run for afterwards (the queue
 * keeps per-message model/compute selection, which steering cannot).
 * A steer that races the run's end (server 409 "not_streaming") falls back
 * behind the queue when one exists, so message order is preserved.
 */
export type SendIntent = "auto" | "queue";
export type SubmitRoute = "send" | "steer" | "queue";

export function routeSubmit(isStreaming: boolean, intent: SendIntent): SubmitRoute {
  if (!isStreaming) return "send";
  return intent === "queue" ? "queue" : "steer";
}

export function steerNotStreamingFallback(queueLength: number): "queue" | "send" {
  return queueLength > 0 ? "queue" : "send";
}
```

Run: `cd web && npx vitest run src/lib/chat-routing.test.ts`
Expected: PASS.

- [ ] **Step 4: ChatInput — Alt+Enter intent, `onSend` prop, composer-restore registration, inline error**

In `web/src/components/chat-tab.tsx`:

**(a)** Add imports: `ZapIcon` to the lucide import list; `import { routeSubmit, steerNotStreamingFallback, type SendIntent } from "@/lib/chat-routing";` and add `type MutableRefObject` to the react import list.

**(b)** In the `ChatInput` props, replace `onSubmit: Parameters<typeof PromptInput>[0]["onSubmit"];` with:

```ts
  onSend: (text: string, intent: SendIntent) => void;
  pendingSteers: string[];
  composerRestoreRef: MutableRefObject<((text: string) => void) | null>;
  inlineError: string | null;
```

(and the matching destructured parameters). Keep every other prop.

**(c)** Register the restore function (below the existing `controllerRef` effect):

```ts
  // Steer failures and Stop restore undelivered text into this composer;
  // the parent holds the ref because it owns the steer/stop calls.
  useEffect(() => {
    composerRestoreRef.current = (text: string) =>
      appendToComposer(controllerRef.current.textInput, text, "\n");
    return () => {
      composerRestoreRef.current = null;
    };
  }, [composerRestoreRef]);
```

**(d)** Capture the Alt modifier at keydown time — the form submit event carries no modifiers. Add near the mention state:

```ts
  const queueIntentRef = useRef(false);
```

At the TOP of the existing `handleKeyDown` (before the mention branches):

```ts
    if (e.key === "Enter" && !e.shiftKey) {
      queueIntentRef.current = e.altKey;
    }
```

(The external onKeyDown runs before the textarea's internal Enter→requestSubmit, so the flag is set before submit. It is read-and-cleared in `handleSubmit`, so a blocked submit can leave it stale only until the next Enter/click, which overwrites or clears it.)

**(e)** Rewrite `handleSubmit` to read the intent and call `onSend`:

```ts
  const handleSubmit = useCallback<Parameters<typeof PromptInput>[0]["onSubmit"]>(
    (msg, event) => {
      const intent: SendIntent = queueIntentRef.current ? "queue" : "auto";
      queueIntentRef.current = false;
      if (budgetBlocked) {
        event?.preventDefault();
        return;
      }
      const refs = attachedFiles.length > 0 ? "\n" + attachedFiles.join("\n") : "";
      const dbCtx = buildDatabaseContext(selectedDbs);
      const skillsCtx = buildSkillsContext(selectedSkills);
      const baseText = msg.text ?? "";
      if (!baseText.trim() && attachedFiles.length === 0) return;
      onSend(baseText + refs + dbCtx + skillsCtx, intent);
      onClearFiles();
    },
    [budgetBlocked, onSend, attachedFiles, onClearFiles, selectedDbs, selectedSkills]
  );
```

**(f)** Placeholder while streaming (replace the existing `placeholder` expression on `PromptInputTextarea`):

```ts
            placeholder={
              isStreaming
                ? pendingSteers.length > 0
                  ? `Steer the run… (${pendingSteers.length} pending · ⌥↵ to run after)`
                  : "Steer the run… (⌥↵ to run after)"
                : queuedMessages.length >= MAX_QUEUE
                  ? `Queue full (${MAX_QUEUE}/${MAX_QUEUE})`
                  : "Ask Kady anything… (@ for files, + for data / compute / skills)"
            }
```

**(g)** Inline error banner — render above the budget banner:

```tsx
        {inlineError && (
          <div
            role="alert"
            className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inlineError}
          </div>
        )}
```

**(h)** Update the send/stop tooltip's streaming branch:

```tsx
                  ) : isStreaming ? (
                    <>
                      <b>Stop</b>
                      <br />
                      Cancel the current turn (⏎ steers it instead). Undelivered
                      steering messages return to the composer; files the agent
                      already wrote stay in the sandbox.
                    </>
```

and the ready-state branch's last sentence to: `Prompts sent while the agent is busy steer the live run; ⌥⏎ queues a new run instead.`

**(i)** Pass steering to the queue popover: `<MessageQueueDisplay queue={queuedMessages} steering={pendingSteers} onRemove={onRemoveFromQueue} />`.

- [ ] **Step 5: `MessageQueueDisplay` — steering group**

Replace the component's signature and empty-check, and add the steering group above the existing list:

```tsx
function MessageQueueDisplay({
  queue,
  steering,
  onRemove,
}: {
  queue: QueuedMessage[];
  steering: string[];
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0 && steering.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-10 mb-2">
      <div className="overflow-hidden rounded-xl border bg-background shadow-lg">
        {steering.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ZapIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Steering — delivers mid-run
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {steering.length}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto border-b py-1">
              {steering.map((text, i) => (
                <div key={`${i}-${text}`} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums text-muted-foreground">
                    ⏳
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground">{text}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {queue.length > 0 && (
          <>
            {/* existing "Queued" header row, retitled */}
            ...
          </>
        )}
      </div>
    </div>
  );
}
```

For the `queue.length > 0` block, keep the EXISTING header row and item list exactly as they are today (the `ListOrderedIcon` header, `{queue.length}/{MAX_QUEUE}` counter, numbered items with remove buttons), only changing the header label text from `Queued` to `Run after` and wrapping both in the conditional fragment shown above.

- [ ] **Step 6: ChatTab — handleSend / handleStop / render wiring**

**(a)** Destructure the new hook surface:

```ts
  const { messages, status, send, stop, steer, pendingSteers, getSessionId, loadSession } = useAgent();
```

**(b)** Add state/refs near `messageQueue`:

```ts
  const composerRestoreRef = useRef<((text: string) => void) | null>(null);
  const [steerError, setSteerError] = useState<string | null>(null);

  useEffect(() => {
    if (!steerError) return;
    const t = window.setTimeout(() => setSteerError(null), 5000);
    return () => window.clearTimeout(t);
  }, [steerError]);
```

**(c)** Extract the queue-push from the old `handleSubmit` into a helper (same object shape as today):

```ts
  const enqueue = useCallback(
    (trimmed: string) => {
      if (messageQueue.length >= MAX_QUEUE) return;
      setMessageQueue((prev) => [
        ...prev,
        {
          id: String(++queueIdCounter.current),
          rawText: trimmed.split("\n")[0],
          text: trimmed,
          model: {
            id: selectedModel.id,
            label: selectedModel.label,
            fusionConfig: selectedModel.fusionConfig,
          },
          databases: [...selectedDbs],
          skills: [...selectedSkills],
          files: [...attachedFiles],
          computeTarget: selectedComputeTarget?.id ?? null,
          timestamp: Date.now(),
        },
      ]);
    },
    [messageQueue.length, selectedModel, selectedDbs, selectedSkills, attachedFiles, selectedComputeTarget],
  );
```

**(d)** Replace `handleSubmit` with `handleSend` (the send-call arguments are identical to today's):

```ts
  const handleSend = useCallback(
    async (text: string, intent: SendIntent) => {
      if (budgetState === "exceeded") return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const sendNow = () =>
        send(
          trimmed,
          selectedModel.id,
          {
            attachments: attachedFiles,
            skills: selectedSkills.map((s) => s.name),
            databases: selectedDbs.map((db) => db.name),
          },
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
        );
      const route = routeSubmit(isStreaming, intent);
      if (route === "queue") {
        enqueue(trimmed);
        return;
      }
      if (route === "steer") {
        const result = await steer(trimmed);
        if (result === "ok") return;
        if (result === "not_streaming") {
          // The run ended while we typed: keep ordering behind any queue.
          if (steerNotStreamingFallback(messageQueue.length) === "queue") enqueue(trimmed);
          else void sendNow();
          return;
        }
        composerRestoreRef.current?.(trimmed);
        setSteerError("Couldn't deliver the steering message — your text was restored.");
        return;
      }
      await sendNow();
    },
    [
      budgetState,
      isStreaming,
      steer,
      enqueue,
      send,
      selectedModel,
      selectedComputeTarget,
      selectedDbs,
      selectedSkills,
      attachedFiles,
      messageQueue.length,
    ],
  );
```

**(e)** Add the stop wrapper:

```ts
  const handleStop = useCallback(async () => {
    const restored = await stop();
    if (restored.length > 0) composerRestoreRef.current?.(restored.join("\n"));
  }, [stop]);
```

**(f)** Update the `<ChatInput>` render props: `onSubmit={handleSubmit}` → `onSend={handleSend}`, `onStop={stop}` → `onStop={handleStop}`, and add `pendingSteers={pendingSteers}`, `composerRestoreRef={composerRestoreRef}`, `inlineError={steerError}`.

(The `useImperativeHandle` block keeps exposing the raw `stop` — parent callers ignore its return value, and the widened `Promise<string[]>` return type is assignable.)

- [ ] **Step 7: Typecheck and run the full web suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: PASS, no unused-variable errors (the old `handleSubmit` body is fully replaced; `MAX_QUEUE` is now used by `enqueue` and the placeholder).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/chat-routing.ts web/src/lib/chat-routing.test.ts web/src/components/chat-tab.tsx
git commit -m "feat(web): Enter steers the live run; Alt+Enter queues; Stop restores undelivered steers"
```

---

### Task 7: Full verification (automated + manual)

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

```bash
cd server && npm run typecheck && npm test
cd ../web && npx tsc --noEmit && npm test
```

Expected: all green.

- [ ] **Step 2: Manual end-to-end (requires `OPENROUTER_API_KEY`; use Opus 4.8 or GPT-5.5 per project testing policy)**

Start the app with `./start.sh`, open a chat tab, then verify each spec scenario:

1. **Steer mid-run:** send `Run "sleep 20" in bash, then tell me a fun fact about zebrafish.` While the sleep runs, type `Actually make the fact about axolotls instead.` and press Enter. Expect: a "Steering — delivers mid-run" chip appears, then your message shows up as a user bubble mid-transcript, a new assistant bubble follows, and the fact is about axolotls.
2. **Two steers back-to-back:** same long-run prompt; Enter two steering messages quickly. Expect both chips, both delivered as separate user bubbles in order.
3. **Stop with a pending steer:** same long-run prompt; steer once while the tool call is still running, then press Stop before delivery. Expect: run aborts, the steer text reappears in the composer.
4. **Alt+Enter queue:** while a run streams, press Alt+Enter on a message. Expect it lands in the "Run after" group and auto-sends as a NEW run when the current one finishes.
5. **Reload after a steered run:** after scenario 1 completes, reload the page and reopen the session. Expect the transcript shows the steered user message interleaved at the same position.
6. **Budget-capped steer:** set the project spend limit below current spend in project settings, start a run (it will be blocked — instead temporarily set the limit just above current spend so the run starts, then steer). Expect the steer is rejected and the text is restored to the composer with the inline error.

- [ ] **Step 3: Final commit if any fixups were needed, then report**

Report results per scenario (pass/fail with what was observed), per the verification-before-completion discipline.
