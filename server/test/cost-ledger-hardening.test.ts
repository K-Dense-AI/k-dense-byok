/**
 * Regressions for the ledger's failure modes around the spend cap.
 *
 * Every case here previously *understated* spend, which is the dangerous
 * direction: the cap compares against these totals, so an undercount admits
 * billable work that should have been refused.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject, ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  isBudgetExceeded,
  projectCostSummary,
  sessionCostSummary,
  trackInFlightRun,
  untrackInFlightRun,
  type CostEntry,
} from "../src/cost/ledger.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

function costsFile(sessionId: string, projectId: string): string {
  return path.join(
    resolvePaths(projectId).sandbox,
    ".kady",
    "runs",
    sessionId,
    "costs.jsonl",
  );
}

function writeRows(sessionId: string, projectId: string, lines: string[]): void {
  ensureProjectExists(projectId);
  const file = costsFile(sessionId, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

const row = (over: Partial<CostEntry> = {}): CostEntry => ({
  entryId: "e1",
  ts: 1,
  sessionId: "s1",
  role: "agent",
  model: "openrouter/anthropic/claude-opus",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  cachedTokens: 0,
  costUsd: 1,
  ...over,
});

describe("ledger reads survive damaged rows", () => {
  it("keeps the intact rows when one line is torn", () => {
    writeRows("s1", "default", [
      JSON.stringify(row({ entryId: "a", costUsd: 1.5 })),
      '{"entryId":"torn","costUsd":2', // crash mid-append
      JSON.stringify(row({ entryId: "b", costUsd: 2.5 })),
    ]);
    const summary = sessionCostSummary("s1", "default");
    expect(summary.entries.map((e) => e.entryId)).toEqual(["a", "b"]);
    expect(summary.totalUsd).toBeCloseTo(4, 6);
  });

  it("coerces missing and non-numeric costs to zero instead of NaN", () => {
    writeRows("s2", "default", [
      JSON.stringify(row({ entryId: "a", costUsd: 1 })),
      JSON.stringify({ ...row({ entryId: "b" }), costUsd: "oops" }),
      JSON.stringify({ ...row({ entryId: "c" }), costUsd: undefined }),
    ]);
    const summary = sessionCostSummary("s2", "default");
    expect(Number.isFinite(summary.totalUsd)).toBe(true);
    expect(summary.totalUsd).toBeCloseTo(1, 6);
  });

  it("does not let a NaN cost fail the cap open", () => {
    createProject({ name: "Capped", projectId: "capped", spendLimitUsd: 1 });
    writeRows("s3", "capped", [
      JSON.stringify({ ...row({ entryId: "a" }), costUsd: Number.NaN }),
      JSON.stringify(row({ entryId: "b", costUsd: 2 })),
    ]);
    expect(isBudgetExceeded("capped").exceeded).toBe(true);
  });
});

describe("in-flight run accounting", () => {
  it("counts a started-but-unledgered run toward the project total", () => {
    createProject({ name: "Live", projectId: "live", spendLimitUsd: 10 });
    writeRows("s1", "live", [JSON.stringify(row({ costUsd: 2 }))]);
    expect(projectCostSummary("live").committedUsd).toBeCloseTo(2, 6);

    trackInFlightRun("live:s2", "live", () => 3);
    try {
      const summary = projectCostSummary("live");
      expect(summary.spentUsd).toBeCloseTo(2, 6);
      expect(summary.inFlightUsd).toBeCloseTo(3, 6);
      expect(summary.committedUsd).toBeCloseTo(5, 6);
      expect(summary.budget.totalUsd).toBeCloseTo(5, 6);
    } finally {
      untrackInFlightRun("live:s2");
    }
    expect(projectCostSummary("live").inFlightUsd).toBe(0);
  });

  it("blocks a second run whose combined spend would exceed the cap", () => {
    createProject({ name: "Tight", projectId: "tight", spendLimitUsd: 5 });
    writeRows("s1", "tight", [JSON.stringify(row({ costUsd: 3 }))]);
    expect(isBudgetExceeded("tight").exceeded).toBe(false);

    trackInFlightRun("tight:s1", "tight", () => 2.5);
    try {
      expect(isBudgetExceeded("tight").exceeded).toBe(true);
    } finally {
      untrackInFlightRun("tight:s1");
    }
  });

  it("ignores a project's other in-flight runs and throwing reporters", () => {
    createProject({ name: "A", projectId: "a" });
    createProject({ name: "B", projectId: "b" });
    trackInFlightRun("b:s1", "b", () => 4);
    trackInFlightRun("a:bad", "a", () => {
      throw new Error("session disposed");
    });
    try {
      expect(projectCostSummary("a").inFlightUsd).toBe(0);
      expect(projectCostSummary("b").inFlightUsd).toBeCloseTo(4, 6);
    } finally {
      untrackInFlightRun("b:s1");
      untrackInFlightRun("a:bad");
    }
  });
});
