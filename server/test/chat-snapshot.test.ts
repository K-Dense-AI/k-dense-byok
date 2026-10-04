import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProjectExists } from "../src/projects.ts";
import { fitTurns, snapshotChat, toolResultSummary, type Turn } from "../src/agent/chat-snapshot.ts";
import { buildComposerContext, EMPTY_DELEGATION } from "../../web/src/lib/composer-context.ts";

const msg = (message: Record<string, unknown>) => ({ type: "message", message });

function writeSession(projectId: string, sessionId: string, rows: unknown[]) {
  const paths = ensureProjectExists(projectId);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const file = path.join(paths.sessionsDir, `2026-10-03T00-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { paths, file };
}

function rows(sandbox: string) {
  return [
    { type: "session", id: "s1" },
    msg({ role: "user", content: [{ type: "text", text: "Fit the curve" + buildComposerContext({ delegation: { ...EMPTY_DELEGATION, verify: true }, research: [] }) }] }),
    msg({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET REASONING" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: `cd ${sandbox} && python fit.py` } },
        { type: "toolCall", id: "c2", name: "notebook_search", arguments: { query: "Emax" } },
        { type: "toolCall", id: "c3", name: "notebook", arguments: { type: "decision", title: "Keep Emax" } },
      ],
    }),
    msg({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(5000) }], isError: true }),
    msg({ role: "toolResult", toolCallId: "c2", toolName: "notebook_search", content: [{ type: "text", text: JSON.stringify({ rules: "long rules", hits: [{ title: "Fit Emax" }] }) }] }),
    msg({ role: "toolResult", toolCallId: "c3", toolName: "notebook", content: [{ type: "text", text: "logged notebook entry (id: call_9) — reference this id in relatesTo" }] }),
    { type: "custom_message", customType: "subagent_notice", content: "Reviewer finished", display: true },
    { type: "compaction", summary: `Worked in ${sandbox}/figures` },
    msg({ role: "assistant", content: [{ type: "text", text: `Saved ${sandbox}/figures/dose.png` }] }),
  ];
}

describe("snapshotChat", () => {
  it("writes a compact, sandbox-relative transcript without reasoning or full outputs", () => {
    const { paths } = writeSession("snapshot-basic", "sess-a", []);
    writeSession("snapshot-basic", "sess-a", rows(paths.sandbox));
    const snap = snapshotChat(paths, "sess-a", { title: "QC\nchat", now: Date.UTC(2026, 9, 3) })!;
    expect(snap.path).toMatch(/^\.kady\/chat-snapshots\/sess-a-[a-f0-9]{16}\.md$/);
    expect(snap).toMatchObject({ prompts: 1, omittedTurns: 0 });
    const text = fs.readFileSync(path.join(paths.sandbox, snap.path), "utf-8");
    expect(text).toContain("# Chat snapshot: QC chat");
    expect(text).toContain("- Captured: 2026-10-03T00:00:00.000Z");
    expect(text).toContain("_(Added from the + menu: verification gate)_");
    expect(text).not.toContain("<composer-context>");
    expect(text).not.toContain("SECRET REASONING");
    expect(text).not.toContain(paths.sandbox);
    expect(text).toContain("- `bash` cd . && python fit.py → error: xxx");
    expect(text).not.toContain("x".repeat(400));
    expect(text).toContain('- `notebook_search` search "Emax" → 1 hit: "Fit Emax"');
    expect(text).toContain("- `notebook` decision: Keep Emax → logged (id: call_9)");
    expect(text).toContain("> Notice (subagent_notice): Reviewer finished");
    expect(text).toContain("> **Earlier messages were compacted.** Summary:");
    expect(text).toContain("Saved figures/dose.png");
  });

  it("reuses the snapshot while the chat is unchanged and writes a new one after it changes", () => {
    const { paths } = writeSession("snapshot-reuse", "sess-b", []);
    const base = rows(paths.sandbox);
    writeSession("snapshot-reuse", "sess-b", base);
    const first = snapshotChat(paths, "sess-b")!;
    const again = snapshotChat(paths, "sess-b")!;
    expect(again.path).toBe(first.path);
    expect(again.digest).toBe(first.digest);
    writeSession("snapshot-reuse", "sess-b", [...base, msg({ role: "user", content: [{ type: "text", text: "Next" }] })]);
    const changed = snapshotChat(paths, "sess-b")!;
    expect(changed.path).not.toBe(first.path);
    expect(changed.prompts).toBe(2);
    expect(fs.existsSync(path.join(paths.sandbox, first.path))).toBe(true);
  });

  it("returns null for an unknown session and rejects unsafe ids", () => {
    const paths = ensureProjectExists("snapshot-missing");
    expect(snapshotChat(paths, "nope")).toBeNull();
    expect(() => snapshotChat(paths, "../etc")).toThrow(/Invalid session id/);
  });
});

describe("fitTurns", () => {
  const turn = (label: string, isPrompt = true): Turn => ({ lines: [label, "y".repeat(90)], isPrompt });
  it("keeps the first prompt and the latest turns, marking the gap", () => {
    const turns = [turn("pre", false), turn("first"), turn("t2"), turn("t3"), turn("t4")];
    const { body, omitted } = fitTurns(turns, 330);
    expect(omitted).toBe(2);
    expect(body).toContain("pre");
    expect(body).toContain("first");
    expect(body).toContain("t4");
    expect(body).not.toContain("t2");
    expect(body).toContain("2 turns omitted for length");
  });
});

describe("toolResultSummary", () => {
  it("falls back to omitting unknown notebook_search output", () => {
    expect(toolResultSummary({ type: "toolCall", id: "x", name: "notebook_search" }, "not json")).toBe("");
    expect(toolResultSummary({ type: "toolCall", id: "x", name: "notebook_search" }, JSON.stringify({ hit: { title: "A" } }))).toBe('read "A"');
    expect(toolResultSummary({ type: "toolCall", id: "x", name: "subagent", arguments: { action: "list" } }, "long")).toBe("listed specialists");
  });
});
