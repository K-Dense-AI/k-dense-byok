# Thinking-Level UI Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Pi's per-session thinking level (off/minimal/low/medium/high/xhigh) as a chip selector in the chat composer, sent as `thinkingLevel` on every run.

**Architecture:** The backend `/sessions/:id/run` route already applies `body.thinkingLevel` via Pi's `session.setThinkingLevel()`; it only needs input validation (extracted as a pure `parseThinkingLevel()`). The frontend gets a new `ThinkingSelector` chip+popover (mirroring `ComputeSelector`), per-tab `useState` defaulting to `"high"`, and the level threaded through `send()` / the message queue / the imperative send paths exactly like `computeTarget`. Runs for Ollama and Fusion models send no level (selector disabled).

**Tech Stack:** Next.js 16 / React 19, Radix popover + lucide icons (existing `web/src/components/ui/*`), vitest + @testing-library/react (jsdom), Fastify + Pi SDK on the server.

**Spec:** `docs/superpowers/specs/2026-07-05-thinking-level-ui-design.md`

## Global Constraints

- The six levels, verbatim and in this order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (Pi's `ThinkingLevel` in `@earendil-works/pi-agent-core`).
- Default level for a new chat tab: `high`.
- Per-tab ephemeral `useState` only — no localStorage persistence.
- An explicit `"off"` IS sent on the wire (Pi sessions remember the level across runs; off is what resets it). Only disabled-model runs omit the field.
- Server runs via `tsx` — never compile with `tsc` for emit; `npm run typecheck` is `tsc --noEmit`.
- Do not include Claude as co-author on commit messages.
- Known-failing web tests on a clean checkout (pre-existing, NOT regressions): `src/lib/projects.test.ts`, `src/lib/pdf-annotations.test.ts` (jsdom localStorage issue).

---

### Task 1: Backend — `parseThinkingLevel()` validation

The run route currently blind-casts: `session.setThinkingLevel(body.thinkingLevel as ThinkingLevel)` (`server/src/api/sessions.ts:324-326`). Extract validation into a tiny pure module and use it in the route (invalid values are logged and ignored, matching how a failed `setModel` is handled in the same route).

**Files:**
- Create: `server/src/agent/thinking.ts`
- Create: `server/test/thinking.test.ts`
- Modify: `server/src/api/sessions.ts` (imports at ~line 10; the `if (body.thinkingLevel)` block at ~line 324)

**Interfaces:**
- Consumes: `type ThinkingLevel` from `@earendil-works/pi-agent-core` (already a server dependency).
- Produces: `THINKING_LEVELS: readonly ThinkingLevel[]` and `parseThinkingLevel(value: unknown): ThinkingLevel | undefined` from `server/src/agent/thinking.ts`. No later task imports these (the web app deliberately has its own copy of the union — no shared package exists between `server/` and `web/`).

- [ ] **Step 1: Write the failing test**

Create `server/test/thinking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseThinkingLevel, THINKING_LEVELS } from "../src/agent/thinking.ts";

describe("parseThinkingLevel", () => {
  it("accepts every Pi level", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    for (const level of THINKING_LEVELS) {
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(parseThinkingLevel("ultra")).toBeUndefined();
    expect(parseThinkingLevel("OFF")).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel(null)).toBeUndefined();
    expect(parseThinkingLevel(3)).toBeUndefined();
    expect(parseThinkingLevel({ level: "high" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/thinking.test.ts`
Expected: FAIL — cannot find module `../src/agent/thinking.ts`

- [ ] **Step 3: Write the module**

Create `server/src/agent/thinking.ts`:

```ts
/**
 * Thinking-level validation for the run endpoint. Pi's session clamps the
 * level per model capability; this only guards the untrusted wire value.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** The value as a ThinkingLevel, or undefined if it isn't one (caller keeps the session's current level). */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/thinking.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Use it in the run route**

In `server/src/api/sessions.ts`:

1. Delete the now-unused type import near the top of the file:

```ts
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
```

2. Add (alphabetically with the other `../agent/` imports):

```ts
import { parseThinkingLevel } from "../agent/thinking.ts";
```

3. Replace the block at ~line 324:

```ts
        if (body.thinkingLevel) {
          session.setThinkingLevel(body.thinkingLevel as ThinkingLevel);
        }
```

with:

```ts
        if (body.thinkingLevel !== undefined) {
          const level = parseThinkingLevel(body.thinkingLevel);
          if (level) session.setThinkingLevel(level);
          else req.log.warn({ thinkingLevel: body.thinkingLevel }, "ignoring invalid thinkingLevel");
        }
```

- [ ] **Step 6: Typecheck and full server test suite**

Run: `cd server && npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (including the new `thinking.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add server/src/agent/thinking.ts server/test/thinking.test.ts server/src/api/sessions.ts
git commit -m "feat(server): validate run-body thinkingLevel via parseThinkingLevel"
```

---

### Task 2: Frontend — `ThinkingSelector` component

A chip + popover in the composer footer, structurally mirroring `web/src/components/compute-selector.tsx` (read it first for the visual idiom: chip styling, popover header, row layout with a check circle).

**Files:**
- Create: `web/src/components/thinking-selector.tsx`
- Create: `web/src/components/thinking-selector.test.tsx`

**Interfaces:**
- Consumes: `Popover/PopoverContent/PopoverTrigger` from `@/components/ui/popover`, `Tooltip/*` from `@/components/ui/tooltip`, `cn` from `@/lib/utils`, icons from `lucide-react`.
- Produces (Task 3/4 rely on these exact names):
  - `export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `export const DEFAULT_THINKING_LEVEL: ThinkingLevel` (= `"high"`)
  - `export const THINKING_LEVELS: { id: ThinkingLevel; label: string; description: string }[]`
  - `export function ThinkingSelector(props: { selected: ThinkingLevel; onChange: (level: ThinkingLevel) => void; disabled?: boolean; disabledReason?: string })`

- [ ] **Step 1: Write the failing test**

Create `web/src/components/thinking-selector.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingSelector, THINKING_LEVELS } from "./thinking-selector";

describe("ThinkingSelector", () => {
  it("shows the current level on the chip", () => {
    render(<ThinkingSelector selected="high" onChange={() => {}} />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("lists all six levels and fires onChange with the picked one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThinkingSelector selected="high" onChange={onChange} />);
    await user.click(screen.getByRole("button"));
    // Chip + popover row can both show the selected label — use getAllByText.
    for (const level of THINKING_LEVELS) {
      expect(screen.getAllByText(level.label).length).toBeGreaterThan(0);
    }
    await user.click(screen.getByText("XHigh"));
    expect(onChange).toHaveBeenCalledWith("xhigh");
  });

  it("when disabled: shows Off, does not open, never fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThinkingSelector selected="high" onChange={onChange} disabled />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.queryByText("Medium")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/thinking-selector.test.tsx`
Expected: FAIL — cannot resolve `./thinking-selector`

- [ ] **Step 3: Write the component**

Create `web/src/components/thinking-selector.tsx`:

```tsx
"use client";

import { useState } from "react";
import { BrainIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Pi's reasoning levels (`ThinkingLevel` in @earendil-works/pi-agent-core). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

export const THINKING_LEVELS: { id: ThinkingLevel; label: string; description: string }[] = [
  { id: "off", label: "Off", description: "No extended reasoning — fastest and cheapest." },
  { id: "minimal", label: "Minimal", description: "Bare-minimum reasoning for models that require some." },
  { id: "low", label: "Low", description: "Brief reasoning for straightforward tasks." },
  { id: "medium", label: "Medium", description: "Balanced reasoning effort and cost." },
  { id: "high", label: "High", description: "Deep reasoning for hard problems." },
  { id: "xhigh", label: "XHigh", description: "Maximum effort — slowest, most thorough, most tokens." },
];

export function ThinkingSelector({
  selected,
  onChange,
  disabled = false,
  disabledReason = "This model doesn't support adjustable thinking",
}: {
  selected: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = THINKING_LEVELS.find((l) => l.id === selected) ?? THINKING_LEVELS[0];

  const chip = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors text-xs select-none",
        disabled
          ? "cursor-not-allowed border-transparent opacity-50"
          : open || selected !== "off"
            ? "cursor-pointer border-border bg-muted/60"
            : "cursor-pointer border-transparent hover:border-border hover:bg-muted/40",
      )}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
    >
      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "whitespace-nowrap",
          disabled ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {disabled ? "Off" : current.label}
      </span>
      {!disabled && (
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform ml-0.5",
            open && "rotate-180",
          )}
        />
      )}
    </div>
  );

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            {disabledReason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Thinking
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {THINKING_LEVELS.map((level) => {
            const isSelected = level.id === selected;
            return (
              <div
                key={level.id}
                onClick={() => {
                  onChange(level.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2.5 text-xs transition-colors cursor-pointer hover:bg-muted/60",
                  isSelected && "bg-muted/40",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background",
                  )}
                >
                  {isSelected && <CheckIcon className="size-2" />}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-foreground">{level.label}</span>
                  <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">
                    {level.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// The selected level rides the run request as `thinkingLevel`; the backend
// applies it with Pi's setThinkingLevel (clamped to what the model supports).
// Disabled for Ollama (reasoning:false) and Fusion (wire body rewritten) models,
// whose runs carry no level.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/thinking-selector.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/thinking-selector.tsx web/src/components/thinking-selector.test.tsx
git commit -m "feat(web): ThinkingSelector chip for Pi thinking levels"
```

---

### Task 3: Frontend — run body carries `thinkingLevel`

`send()` in `web/src/lib/use-agent.ts` builds the run POST body inline (~line 381). Extract it as an exported pure `buildRunBody()` (this codebase tests hook logic via exported pure helpers — see `applyFrameToMessage` / `use-agent-events.test.ts` — not by rendering hooks) and add the `thinkingLevel` parameter.

**Files:**
- Modify: `web/src/lib/use-agent.ts` (the `send` callback, ~lines 342-396)
- Create: `web/src/lib/use-agent.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 relies on these):
  - `export function buildRunBody(opts: { message: string; model?: string; fusionConfig?: Record<string, unknown>; computeTarget?: string; thinkingLevel?: string }): Record<string, unknown>`
  - `send(text, model?, _legacyMeta?, fusionConfig?, computeTarget?, thinkingLevel?)` — new optional sixth parameter, type `string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/use-agent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRunBody } from "@/lib/use-agent";

describe("buildRunBody", () => {
  it("includes thinkingLevel when provided — including an explicit 'off'", () => {
    expect(
      buildRunBody({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" }),
    ).toEqual({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" });
    // Pi sessions remember the level across runs; "off" must reach the wire to reset it.
    expect(buildRunBody({ message: "hi", thinkingLevel: "off" })).toEqual({
      message: "hi",
      thinkingLevel: "off",
    });
  });

  it("omits thinkingLevel when absent", () => {
    expect(buildRunBody({ message: "hi" })).toEqual({ message: "hi" });
  });

  it("keeps computeTarget behavior: sent when set, omitted for 'local'", () => {
    expect(buildRunBody({ message: "hi", computeTarget: "h100" })).toEqual({
      message: "hi",
      computeTarget: "h100",
    });
    expect(buildRunBody({ message: "hi", computeTarget: "local" })).toEqual({ message: "hi" });
  });

  it("includes fusionConfig when provided", () => {
    const fusionConfig = { plugins: [] };
    expect(buildRunBody({ message: "hi", model: "fusion/x", fusionConfig })).toEqual({
      message: "hi",
      model: "fusion/x",
      fusionConfig,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/use-agent.test.ts`
Expected: FAIL — `buildRunBody` is not exported

- [ ] **Step 3: Implement `buildRunBody` and thread the parameter**

In `web/src/lib/use-agent.ts`, add above `export function useAgent()` (~line 232):

```ts
/**
 * JSON body for POST /sessions/:id/run. Pure so tests can pin the wire shape.
 * `thinkingLevel: "off"` is deliberately sent (not stripped): Pi sessions
 * remember the level across runs, so an explicit off resets a raised one.
 * Callers omit the field entirely for models without adjustable thinking.
 */
export function buildRunBody(opts: {
  message: string;
  model?: string;
  fusionConfig?: Record<string, unknown>;
  computeTarget?: string;
  thinkingLevel?: string;
}): Record<string, unknown> {
  const { message, model, fusionConfig, computeTarget, thinkingLevel } = opts;
  return {
    message,
    ...(model ? { model } : {}),
    ...(fusionConfig ? { fusionConfig } : {}),
    ...(computeTarget && computeTarget !== "local" ? { computeTarget } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
```

Then in the `send` callback:

1. Add the parameter after `computeTarget` (and mention it in the comment above `send`, which already documents `computeTarget`):

```ts
    async (
      text: string,
      model?: string,
      _legacyMeta?: unknown,
      fusionConfig?: Record<string, unknown>,
      computeTarget?: string,
      thinkingLevel?: string,
    ): Promise<string | undefined> => {
```

2. Replace the inline body in `startRun` (~line 381):

```ts
            body: JSON.stringify({
              message: text,
              ...(model ? { model } : {}),
              ...(fusionConfig ? { fusionConfig } : {}),
              ...(computeTarget && computeTarget !== "local" ? { computeTarget } : {}),
            }),
```

with:

```ts
            body: JSON.stringify(
              buildRunBody({ message: text, model, fusionConfig, computeTarget, thinkingLevel }),
            ),
```

(The `send` useCallback deps `[status, ensureSession]` are unchanged — the new value flows in as a parameter.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/use-agent.test.ts src/lib/use-agent-events.test.ts`
Expected: PASS (new file 4 tests; events file unchanged and green)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/use-agent.ts web/src/lib/use-agent.test.ts
git commit -m "feat(web): send() carries thinkingLevel in the run body"
```

---

### Task 4: Frontend — wire the selector into the chat tab

Add per-tab state, gate it by model, render the chip between Model and Compute, and pass the level through every `send()` path: direct send, message queue, `sendQuick`, `launchWorkflow`.

**Files:**
- Modify: `web/src/components/chat-tab.tsx` —
  - imports (top of file, next to the `ComputeSelector` import at ~line 32)
  - `QueuedMessage` interface (~line 73)
  - `ChatComposer` props (destructure ~line 383, types ~line 413)
  - composer footer render (~line 685, between `<ModelSelector>` and `<ComputeSelector>`)
  - `ChatTab` per-tab state (~line 911)
  - queue drain effect (~line 988), `enqueue` (~line 1020), `handleSend` (~line 1050), `useImperativeHandle` (`sendQuick` ~line 1109, `launchWorkflow` ~line 1119)
  - `<ChatComposer …>` render (~line 1235)

**Interfaces:**
- Consumes: `ThinkingSelector`, `type ThinkingLevel`, `DEFAULT_THINKING_LEVEL` from `@/components/thinking-selector` (Task 2); `send(text, model, meta, fusionConfig, computeTarget, thinkingLevel)` (Task 3).
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Imports and module-scope gating helper**

Add next to the `ComputeSelector` import:

```ts
import {
  DEFAULT_THINKING_LEVEL,
  ThinkingSelector,
  type ThinkingLevel,
} from "@/components/thinking-selector";
```

Add below the `QueuedMessage` interface:

```ts
/** Models whose runs must NOT carry a thinkingLevel: Ollama models are built
 *  with reasoning:false (Pi clamps to off) and Fusion rewrites the wire body,
 *  so a level is meaningless there. Mirrors isOllama in model-selector.tsx. */
function thinkingUnsupported(model: { id: string; provider?: string }): boolean {
  return (
    model.provider === "Ollama" ||
    model.id.startsWith("ollama/") ||
    model.id.startsWith("fusion/")
  );
}
```

- [ ] **Step 2: Extend `QueuedMessage`**

In the interface (~line 73), after `computeTarget`:

```ts
  /** Thinking level at enqueue time (null = model doesn't support one). */
  thinkingLevel: ThinkingLevel | null;
```

- [ ] **Step 3: ChatComposer props + render**

Add to the destructure (after `onComputeTargetChange`): `thinkingLevel`, `onThinkingLevelChange`, `thinkingDisabled`.
Add to the prop types (after `onComputeTargetChange`):

```ts
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  thinkingDisabled: boolean;
```

In the footer render, between `<ModelSelector …/>` and `<ComputeSelector …/>`:

```tsx
              <ThinkingSelector
                selected={thinkingLevel}
                onChange={onThinkingLevelChange}
                disabled={thinkingDisabled}
              />
```

- [ ] **Step 4: ChatTab state, gating, and send paths**

1. State (with the other per-tab settings, ~line 912):

```ts
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
```

2. Derived flag, right after the state block:

```ts
  const thinkingDisabled = thinkingUnsupported(selectedModel);
```

3. `enqueue` (~line 1020): add to the queue item after `computeTarget`:

```ts
          thinkingLevel: thinkingDisabled ? null : thinkingLevel,
```

and extend the dep array with `thinkingDisabled, thinkingLevel`.

4. Queue drain effect (~line 988): add a sixth argument to the `send` call:

```ts
        next.computeTarget ?? undefined,
        next.thinkingLevel ?? undefined,
```

(No gating here — the level was resolved against the queued message's model at enqueue time.)

5. `handleSend`'s `sendNow` (~line 1050): add a sixth argument:

```ts
          selectedComputeTarget?.id,
          thinkingDisabled ? undefined : thinkingLevel,
```

and extend `handleSend`'s dep array with `thinkingDisabled, thinkingLevel`.

6. `sendQuick` (~line 1109):

```ts
        await send(
          prompt,
          selectedModel.id,
          undefined,
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
          thinkingDisabled ? undefined : thinkingLevel,
        );
```

7. `launchWorkflow` (~line 1119): gate on the **incoming** `model` (it may differ from `selectedModel`, which is set asynchronously):

```ts
          model.fusionConfig,
          selectedComputeTarget?.id,
          thinkingUnsupported(model) ? undefined : thinkingLevel,
```

8. Extend the `useImperativeHandle` dep array (~line 1132) with `thinkingDisabled, thinkingLevel` (keep the existing entries).

9. `<ChatComposer …>` render (~line 1235): after `onComputeTargetChange`:

```tsx
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={setThinkingLevel}
            thinkingDisabled={thinkingDisabled}
```

- [ ] **Step 5: Typecheck and full web test suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: typecheck clean; all tests pass EXCEPT the pre-existing `projects.test.ts` / `pdf-annotations.test.ts` failures (see Global Constraints — do not attempt to fix them).

- [ ] **Step 6: Smoke check in the running app**

Run `./start.sh` (or `cd server && npm run dev` + `cd web && npm run dev`), open http://localhost:3000 and verify:
- The 🧠 chip shows **High** by default between the model and compute chips.
- Picking a level and sending a message: the network tab shows `thinkingLevel` in the `POST /sessions/<id>/run` body, and the assistant reply streams a reasoning block (collapsible "thinking" section) on a reasoning model.
- Switching the model to an Ollama or Fusion entry disables the chip (shows Off + tooltip) and the next run body has no `thinkingLevel`.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/chat-tab.tsx
git commit -m "feat(web): thinking-level selector in the chat composer"
```
