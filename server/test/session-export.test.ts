import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  indexToolResults,
  readRows,
  toNotebook,
  toShellScript,
  type MessageRow,
} from "../src/agent/session-export.ts";
import { toHistory } from "../src/agent/session-history.ts";

const SANDBOX = "/sb";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kady-session-export-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Write a JSONL fixture in the real Pi log shape: tool results are whole
 *  messages (role "toolResult") with linkage at the message level. */
function writeFixture(name: string, rows: unknown[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const msg = (message: Record<string, unknown>) => ({ type: "message", message });

const FIXTURE = [
  { type: "session", id: "s1" },
  msg({
    role: "user",
    content: [{ type: "text", text: "Analyze counts.csv" }],
    timestamp: 1000,
  }),
  msg({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Plan the analysis" },
      { type: "text", text: "Reading the file." },
      {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: `cd ${SANDBOX} && head counts.csv` },
      },
    ],
    timestamp: 2000,
  }),
  msg({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "gene,ctrl,treat" }],
    isError: false,
    timestamp: 3000,
  }),
  msg({
    role: "assistant",
    content: [{ type: "text", text: "Done — 2 conditions." }],
    timestamp: 4000,
  }),
  msg({
    role: "user",
    content: [{ type: "text", text: "Now plot it" }],
    timestamp: 5000,
  }),
  msg({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_2",
        name: "write",
        arguments: { path: `${SANDBOX}/plot.py`, content: "…" },
      },
    ],
    timestamp: 6000,
  }),
  msg({
    role: "toolResult",
    toolCallId: "call_2",
    toolName: "write",
    content: [
      { type: "text", text: "ok" },
      { type: "image", data: "…" },
    ],
    isError: false,
    timestamp: 7000,
  }),
];

describe("indexToolResults", () => {
  it("indexes Pi's message-level toolResult rows", () => {
    const file = writeFixture("index.jsonl", FIXTURE);
    const byId = indexToolResults(readRows(file));
    expect(byId.get("call_1")?.content?.[0].text).toBe("gene,ctrl,treat");
    expect(byId.get("call_2")?.toolName).toBe("write");
  });

  it("still reads legacy content-part toolResults", () => {
    const rows: MessageRow[] = [
      {
        type: "message",
        message: {
          role: "tool",
          content: [
            {
              type: "toolResult",
              toolCallId: "legacy_1",
              content: [{ type: "text", text: "legacy output" }],
            },
          ],
        },
      },
    ];
    const byId = indexToolResults(rows);
    expect(byId.get("legacy_1")?.content?.[0].text).toBe("legacy output");
  });
});

describe("toNotebook", () => {
  it("includes tool outputs beneath each command", () => {
    const file = writeFixture("notebook.jsonl", FIXTURE);
    const md = toNotebook(file, "s1", SANDBOX);
    expect(md).toContain("**Output**");
    expect(md).toContain("gene,ctrl,treat");
    // Image parts are noted rather than dropped.
    expect(md).toContain("[1 image attachment]");
    // Sandbox paths are relativized.
    expect(md).toContain("cd . && head counts.csv");
    expect(md).not.toContain(`cd ${SANDBOX} &&`);
  });
});

describe("toShellScript", () => {
  it("replays bash commands in order", () => {
    const file = writeFixture("script.jsonl", FIXTURE);
    const sh = toShellScript(file, "s1", SANDBOX);
    expect(sh).toContain("cd . && head counts.csv");
    expect(sh).toContain("# [step 1]");
  });
});

describe("toHistory", () => {
  it("replays the log as user messages and assistant frame runs", () => {
    const file = writeFixture("history.jsonl", FIXTURE);
    const history = toHistory(file, SANDBOX);

    expect(history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "Analyze counts.csv",
      timestamp: 1000,
    });

    const frames = history[1].frames!;
    expect(frames.map((f) => f.type)).toEqual([
      "thinking_delta",
      "text_delta",
      "tool_start",
      "tool_end",
      "text_delta",
    ]);
    const start = frames[2];
    expect(start).toMatchObject({ toolCallId: "call_1", toolName: "bash" });
    expect((start.args as { command: string }).command).toBe(
      "cd . && head counts.csv",
    );
    expect(frames[3]).toMatchObject({
      toolCallId: "call_1",
      isError: false,
      result: "gene,ctrl,treat",
    });

    // Second turn: the image-bearing result keeps only its text (same as the
    // live stream's result extraction).
    expect(history[3].frames![1]).toMatchObject({
      type: "tool_end",
      toolCallId: "call_2",
      result: "ok",
    });
  });

  it("caps oversized results like the live stream does", () => {
    const big = "x".repeat(5000);
    const file = writeFixture("cap.jsonl", [
      msg({ role: "user", content: [{ type: "text", text: "go" }] }),
      msg({
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      }),
      msg({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: big }],
      }),
    ]);
    const result = toHistory(file)[1].frames![1].result as string;
    expect(result.length).toBe(4001);
    expect(result.endsWith("…")).toBe(true);
  });
});
