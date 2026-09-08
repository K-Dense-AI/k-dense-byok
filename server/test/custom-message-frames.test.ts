/**
 * Custom (extension-injected) messages on the wire and in reloaded history.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { customMessageFrame, toClientFrame } from "../src/agent/events.ts";
import { toHistory } from "../src/agent/session-history.ts";
import { readEntries } from "../src/agent/session-export.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-history-"));
  temps.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

describe("customMessageFrame", () => {
  it("forwards whitelisted scalar details and drops the rest", () => {
    const frame = customMessageFrame(
      {
        customType: "subagent_supervisor_request",
        content: [{ type: "text", text: "Which p-value cutoff?" }],
        display: true,
        details: {
          agent: "statistical-reviewer",
          reason: "need_decision",
          expectsReply: true,
          childIndex: 0,
          interview: { questions: [] },
          replyHint: 'subagent_supervisor({ action: "reply", replyTo: "r1" })',
        },
      },
      "/sandbox",
    );
    expect(frame).toEqual({
      type: "message_start",
      role: "custom",
      customType: "subagent_supervisor_request",
      content: "Which p-value cutoff?",
      details: {
        agent: "statistical-reviewer",
        reason: "need_decision",
        expectsReply: true,
        childIndex: 0,
        replyHint: 'subagent_supervisor({ action: "reply", replyTo: "r1" })',
      },
    });
  });

  it("omits details for unknown types, caps long content, and hides display:false", () => {
    const long = "x".repeat(9_000);
    const frame = customMessageFrame({ customType: "some-extension", content: long, details: { a: 1 } });
    expect(frame).toMatchObject({ customType: "some-extension" });
    expect(frame).not.toHaveProperty("details");
    expect((frame!.content as string).length).toBeLessThanOrEqual(8_001);
    expect(customMessageFrame({ customType: "x", content: "hidden", display: false })).toBeNull();
  });

  it("relativizes sandbox paths in content and details", () => {
    const frame = customMessageFrame(
      {
        customType: "subagent-notify",
        content: "Wrote /sandbox/results/fig1.png",
        details: { handoffPath: "/sandbox/.pi/subagents/x/handoff.json" },
      },
      "/sandbox",
    );
    expect(frame!.content).toBe("Wrote results/fig1.png");
    expect((frame!.details as Record<string, unknown>).handoffPath).toBe(".pi/subagents/x/handoff.json");
  });
});

describe("toClientFrame custom + compaction", () => {
  it("maps a custom message_start and a successful compaction_end", () => {
    expect(
      toClientFrame({
        type: "message_start",
        message: { role: "custom", customType: "subagent_watchdog_warning", content: "Claims tests ran", display: true, details: { severity: "blocker", category: "test-gap" } },
      } as never),
    ).toEqual({
      type: "message_start",
      role: "custom",
      customType: "subagent_watchdog_warning",
      content: "Claims tests ran",
      details: { severity: "blocker", category: "test-gap" },
    });
    expect(
      toClientFrame({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: false,
        result: { summary: "…", firstKeptEntryId: "e9", tokensBefore: 120_000 },
      } as never),
    ).toEqual({
      type: "message_start",
      role: "custom",
      customType: "compaction",
      content: "Context compacted",
      details: { tokensBefore: 120_000, reason: "threshold" },
    });
    expect(
      toClientFrame({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined } as never),
    ).toBeNull();
    expect(toClientFrame({ type: "compaction_start", reason: "manual" } as never)).toBeNull();
  });
});

describe("toHistory system items", () => {
  it("emits system items for custom messages and compactions, splitting the assistant bubble", () => {
    const file = writeJsonl([
      { type: "session", version: 3, id: "s", timestamp: "2026-09-08T00:00:00.000Z", cwd: "/sandbox" },
      { type: "message", id: "1", parentId: null, timestamp: "2026-09-08T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
      { type: "message", id: "2", parentId: "1", timestamp: "2026-09-08T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: 2 } },
      { type: "custom_message", id: "3", parentId: "2", timestamp: "2026-09-08T00:00:03.000Z", customType: "subagent_supervisor_request", content: "Child asks: which cutoff?", display: true, details: { agent: "worker", interview: {} } },
      { type: "message", id: "4", parentId: "3", timestamp: "2026-09-08T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "relaying" }], timestamp: 4 } },
      { type: "custom_message", id: "5", parentId: "4", timestamp: "2026-09-08T00:00:05.000Z", customType: "subagent-compaction-resume", content: "hidden", display: false },
      { type: "compaction", id: "6", parentId: "5", timestamp: "2026-09-08T00:00:06.000Z", summary: "Summary…", firstKeptEntryId: "4", tokensBefore: 50_000 },
      { type: "message", id: "7", parentId: "6", timestamp: "2026-09-08T00:00:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "after compaction" }], timestamp: 7 } },
    ]);
    expect(readEntries(file).map((r) => r.type)).toEqual([
      "message", "message", "custom_message", "message", "custom_message", "compaction", "message",
    ]);
    const history = toHistory(file, "/sandbox");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "system", "assistant", "system", "assistant"]);
    expect(history[2]).toMatchObject({
      role: "system",
      customType: "subagent_supervisor_request",
      content: "Child asks: which cutoff?",
      details: { agent: "worker" },
      timestamp: Date.parse("2026-09-08T00:00:03.000Z"),
    });
    expect(history[2].details).not.toHaveProperty("interview");
    expect(history[4]).toMatchObject({ role: "system", customType: "compaction", details: { tokensBefore: 50_000 } });
    expect(history[3].frames).toEqual([{ type: "text_delta", delta: "relaying" }]);
    expect(history[5].frames).toEqual([{ type: "text_delta", delta: "after compaction" }]);
  });
});
