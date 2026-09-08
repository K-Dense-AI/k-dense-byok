import { describe, expect, it } from "vitest";
import { normalizeRobustnessDraft, parseRobustnessResult, summarizeRobustness, robustnessText } from "./notebook-robustness";
import { robustnessDraft as draft, robustnessWorkflow as workflow } from "../test/robustness-fixture";

describe("robustness protocol", () => {
  it("strips forged approval/command fields and validates parameter objects", () => {
    expect(normalizeRobustnessDraft({ ...draft, approved: true, command: "evil" })).toEqual(draft);
    expect(() => normalizeRobustnessDraft({ ...draft, specifications: [draft.specifications[0], { ...draft.specifications[1], parametersJson: '[1,2]' }] })).toThrow(/objects/);
    expect(() => normalizeRobustnessDraft({ ...draft, specifications: [draft.specifications[0], { ...draft.specifications[1], parametersJson: '{"n":1e999}' }] })).toThrow(/finite/);
  });
  it("bounds spec count, seed, runtime and package pins", () => {
    expect(() => normalizeRobustnessDraft({ ...draft, specifications: [] })).toThrow(/2–16/);
    expect(() => normalizeRobustnessDraft({ ...draft, specifications: [draft.specifications[0], draft.specifications[0]] })).toThrow(/unique/);
    expect(() => normalizeRobustnessDraft({ ...draft, timeoutSec: 4000 })).toThrow(/3600/);
    expect(() => normalizeRobustnessDraft({ ...draft, packages: ["numpy>=2"] })).toThrow(/exact/);
    expect(() => normalizeRobustnessDraft({ ...draft, packages: ["https://example.com/pkg.whl"] })).toThrow(/exact/);
  });
  it("requires comparable units and valid intervals, without requiring fabricated QC-fail estimates", () => {
    const result = workflow.attempts[0].result!;
    expect(parseRobustnessResult(result, "difference", "score")).toEqual(result);
    expect(() => parseRobustnessResult(result, "odds ratio", "ratio")).toThrow(/matching/);
    expect(() => parseRobustnessResult({ ...result, estimate: null }, "difference", "score")).toThrow(/finite/);
    expect(() => parseRobustnessResult({ ...result, interval: { low: 2, high: 1, level: 0.95 } }, "difference", "score")).toThrow(/interval/);
    expect(parseRobustnessResult({ schemaVersion: 1, metric: "difference", unit: "score", qc: "fail", notes: "Model did not converge" }, "difference", "score").estimate).toBeUndefined();
  });
  it("summarizes only successful valid QC-pass outputs and retains all exclusions", () => {
    const attempts = [...workflow.attempts,
      { ...workflow.attempts[0], state: "failed", result: { ...workflow.attempts[0].result!, estimate: 9999 } },
      { ...workflow.attempts[0], result: { ...workflow.attempts[0].result!, qc: "warn" as const, estimate: 9999 } },
      { ...workflow.attempts[0], resultStatus: "unverified" as const, result: undefined },
    ];
    expect(summarizeRobustness(attempts)).toEqual({ total: 5, eligible: 2, excluded: 3, min: -1, max: 2, median: 0.5 });
    expect(summarizeRobustness([]).median).toBeUndefined();
  });
  it("exports failures and rationale without significance voting or claims of replication", () => {
    const text = robustnessText([{ ...workflow, attempts: [workflow.attempts[0], { ...workflow.attempts[1], state: "cancelled", result: undefined, resultStatus: "missing" }] }]);
    expect(text).toContain("cancelled"); expect(text).toContain("Check confounding"); expect(text).toContain("not independent replications"); expect(text).toContain("not an invoice cap");
  });
});
