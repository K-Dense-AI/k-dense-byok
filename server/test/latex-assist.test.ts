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
