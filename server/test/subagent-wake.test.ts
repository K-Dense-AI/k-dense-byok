/**
 * pi-subagents (0.77+) wakes an idle parent with a fixed user prompt after
 * appending a hidden completion notice. The prompt is addressed to the model,
 * so the chat, its reload, exports and snapshots never show it as a message
 * the user wrote.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { toClientFrame } from "../src/agent/events.ts";
import { toHistory } from "../src/agent/session-history.ts";
import { toNotebook } from "../src/agent/session-export.ts";
import { PARENT_WAKE_TEXT, isParentWake } from "../src/agent/subagent-wake.ts";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-wake-"));
  temps.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const user = (text: string, timestamp: number) => ({
  type: "message",
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});
const assistant = (text: string, timestamp: number) => ({
  type: "message",
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text }], timestamp },
});

describe("pi-subagents parent wake", () => {
  it("matches the wake prompt of the installed package", async () => {
    const { PARENT_WAKE_TEXT: upstream } = await import(
      pathToFileURL(path.join(subagentsPackageDir(), "src/shared/parent-wake.js")).href
    );
    expect(PARENT_WAKE_TEXT).toBe(upstream);
    expect(isParentWake(`${upstream}\n`)).toBe(true);
    expect(isParentWake("Inspect subagent updates above.")).toBe(false);
  });

  it("keeps the frame as the run's prompt echo but shows no text", () => {
    const frame = (text: string) =>
      toClientFrame({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } } as never);
    expect(frame(PARENT_WAKE_TEXT)).toEqual({ type: "message_start", role: "user", content: "" });
    expect(frame("Run the analysis")).toEqual({ type: "message_start", role: "user", content: "Run the analysis" });
  });

  it("leaves the wake out of reloaded history and the exported notebook", () => {
    const file = writeJsonl([
      user("Launch a scout in the background", 1),
      assistant("Launched.", 2),
      { type: "custom_message", customType: "subagent-notify", content: "Background task completed: scout", display: false, timestamp: new Date(3).toISOString() },
      user(PARENT_WAKE_TEXT, 4),
      assistant("The scout found four files.", 5),
    ]);
    const history = toHistory(file);
    expect(history.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Launch a scout in the background"]);
    expect(JSON.stringify(history)).not.toContain(PARENT_WAKE_TEXT);
    const notebook = toNotebook(file, "s1");
    expect(notebook).toContain("## 1. Prompt");
    expect(notebook).not.toContain("## 2. Prompt");
    expect(notebook).not.toContain(PARENT_WAKE_TEXT);
  });
});
