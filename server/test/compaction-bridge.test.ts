/**
 * Science-aware compaction: the deterministic state preamble and the
 * session_before_compact handler (with an injected summary generator).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { modalJobFiles } from "../src/modal/store.ts";

import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
import { appendStep, PROVENANCE_SCHEMA_VERSION } from "../src/provenance/store.ts";
import {
  buildCompactionPreamble,
  makeScientificCompactionExtension,
  PREAMBLE_VERSION,
  SCIENCE_COMPACTION_INSTRUCTIONS,
  TURN_PREFIX_FOCUS,
  childWorkSummary,
  clipToolResultsForSummary,
  compactionFileLists,
  previousNarrative,
  type SummaryGenerator,
} from "../src/agent/compaction-bridge.ts";

let projectId: string;
const sessionId = "cmp-1";

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  projectId = createProject({ name: "Compaction" }).id;
});

const usage = (cost: number) => ({
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

function seedStores(): void {
  appendNotebookEntry(
    sessionId,
    { id: "n1", type: "hypothesis", title: "Treatment raises expression of GENE1", timestamp: 1, role: "agent" },
    projectId,
  );
  appendNotebookEntry(
    sessionId,
    { id: "n2", type: "observation", title: "log2FC = 1.8 (padj 0.003)", timestamp: 2, role: "agent", outcome: "supported" as never },
    projectId,
  );
  appendStep(
    {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      id: "call-1",
      sessionId,
      timestamp: 3,
      toolName: "bash",
      role: "agent",
      inputs: [],
      outputs: [],
      environmentId: "env-abc",
    },
    projectId,
  );
  appendStep(
    {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      id: "res-1",
      sessionId,
      timestamp: 4,
      toolName: "scientific_result",
      role: "agent",
      inputs: [],
      outputs: [],
    },
    projectId,
  );
  appendStep(
    {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      id: "res-err",
      sessionId,
      timestamp: 5,
      toolName: "scientific_result",
      role: "agent",
      isError: true,
      inputs: [],
      outputs: [],
    },
    projectId,
  );
}

describe("buildCompactionPreamble", () => {
  it("retains only pending Modal jobs belonging to this session", () => {
    for (const job of [
      { id: "pending-job", owner: { sessionId }, state: "running" },
      { id: "finished-job", owner: { sessionId }, state: "succeeded" },
      { id: "foreign-job", owner: { sessionId: "other-session" }, state: "queued" },
    ]) {
      const file = modalJobFiles(projectId, job.id).job;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...job, projectId, createdAt: 1, updatedAt: 2 }));
    }
    const text = buildCompactionPreamble(projectId, sessionId).text;
    expect(text).toContain("job pending-job: running");
    expect(text).not.toContain("finished-job");
    expect(text).not.toContain("foreign-job");
  });
  it("retains corrections, execution uncertainty and conflicting evidence", () => {
    appendNotebookEntry(sessionId, { id: "old", type: "method", title: "Earlier result", timestamp: 1, role: "agent", execution: { status: "completed" } }, projectId);
    appendNotebookEntry(sessionId, { id: "fix", type: "observation", title: "Correction", timestamp: 2, role: "agent", supersedes: "old", outcome: "technical-failure", execution: { status: "attempted", evidence: "exit 1; run.log" }, limitations: ["Partial output"] }, projectId);
    const text = buildCompactionPreamble(projectId, sessionId).text;
    expect(text).toContain("SUPERSEDED by fix");
    expect(text).toContain("Execution: unverified");
    expect(text).toContain("Execution: attempted");
    expect(text).toContain("exit 1; run.log");
    expect(text).toContain("outcome: technical-failure");
    expect(text).toContain("Partial output");
  });
  it("derives entries, result ids and the environment id from Kady's stores", () => {
    seedStores();
    const preamble = buildCompactionPreamble(projectId, sessionId);
    expect(preamble.entryCount).toBe(2);
    expect(preamble.resultIds).toEqual(["res-1"]);
    expect(preamble.environmentId).toBe("env-abc");
    expect(preamble.text).toContain("[hypothesis] n1: Treatment raises expression of GENE1");
    expect(preamble.text).toContain("[observation] n2: log2FC = 1.8 (padj 0.003) (outcome: supported)");
    expect(preamble.text).toContain("1 scientific_result cards");
    expect(preamble.text).toContain("- res-1");
    expect(preamble.text).toContain("Environment snapshot env-abc");
    expect(preamble.planRevision).toBeUndefined();
  });

  it("keeps hypotheses older than the recent window unless superseded", () => {
    appendNotebookEntry(sessionId, { id: "h-old", type: "hypothesis", title: "Dose drives response", timestamp: 1, role: "agent" }, projectId);
    appendNotebookEntry(sessionId, { id: "h-gone", type: "hypothesis", title: "Batch explains variance", timestamp: 2, role: "agent" }, projectId);
    appendNotebookEntry(sessionId, { id: "h-new", type: "hypothesis", title: "Batch is minor", timestamp: 3, role: "agent", supersedes: "h-gone" }, projectId);
    for (let i = 0; i < 20; i++) {
      appendNotebookEntry(sessionId, { id: `o${i}`, type: "observation", title: `obs ${i}`, timestamp: 10 + i, role: "agent" }, projectId);
    }
    const text = buildCompactionPreamble(projectId, sessionId).text;
    expect(text).toContain("### Earlier hypotheses (2 before the recent window, not superseded)");
    expect(text).toContain("- h-old: Dose drives response");
    expect(text).toContain("- h-new: Batch is minor");
    expect(text).not.toContain("h-gone: Batch explains variance");
  });

  it("states plainly when nothing is recorded", () => {
    const preamble = buildCompactionPreamble(projectId, "fresh");
    expect(preamble.text).toContain("(no notebook entries, plans or results recorded yet)");
    expect(preamble.resultIds).toEqual([]);
  });
});

it("preserves canonical controls for pending specialists without inventing targets from display order", () => {
  const text = childWorkSummary({ asyncSnapshot: { runs: [
    { id: "run-1", state: "running", children: [{ id: "step-x", state: "paused", control: { runId: "run-1", index: 7, childId: "child-x" } }] },
    { id: "finished", state: "complete" },
  ] } });
  expect(text).toContain('"runId":"run-1","index":7,"childId":"child-x"');
  expect(text).toContain("step-x: paused");
  expect(text).not.toContain("finished");
  expect(childWorkSummary(undefined)).toContain("status unavailable");
  const omitted = childWorkSummary({ asyncSnapshot: { runs: [], omitted: { runs: 1, children: 0, byteLimitExceeded: false } } });
  expect(omitted).toContain("Snapshot truncated");
  expect(omitted).not.toContain("No pending children");
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function install(generate: SummaryGenerator, log = { warn: vi.fn() }) {
  const handlers = new Map<string, Handler>();
  const factory = makeScientificCompactionExtension(projectId, () => sessionId, { generate, log });
  factory({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
  return { handler: handlers.get("session_before_compact")!, failed: handlers.get("session_compact_failed")!, log };
}

const model = { provider: "openrouter", id: "m" };
const ctx = (auth: unknown = { ok: true, apiKey: "k", headers: { "x-a": "1" }, env: { E: "1" } }) => ({
  model,
  thinkingLevel: "high",
  modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => auth) },
});
const event = (overrides: Record<string, unknown> = {}) => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: "e9",
    messagesToSummarize: [{ role: "user", content: "old" }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 90_000,
    previousSummary: "earlier summary",
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  },
  customInstructions: "keep the QC thresholds",
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
  ...overrides,
});

describe("previousNarrative / compactionFileLists", () => {
  it("drops Kady records and file tags, keeps Pi summaries, and unions file lists", () => {
    expect(previousNarrative("## Kady scientific state\n- x\n\n## Current turn so far\nT.")).toBe("## Current turn so far\nT.");
    expect(previousNarrative("## Kady scientific state\n- only records")).toBeUndefined();
    expect(previousNarrative("## Goal\nG.\n\n<modified-files>\na\n</modified-files>")).toBe("## Goal\nG.");
    expect(previousNarrative(undefined)).toBeUndefined();
    expect(compactionFileLists(undefined, "<read-files>\na\nb\n</read-files>\n\n<modified-files>\nb\n</modified-files>")).toEqual({
      readFiles: ["a"],
      modifiedFiles: ["b"],
    });
  });
});

describe("makeScientificCompactionExtension", () => {
  it("returns preamble + narrative with usage and details, under science instructions", async () => {
    seedStores();
    const generate = vi.fn(async () => ({ text: "The narrative.", usage: usage(0.01) })) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    const result = (await handler(event(), ctx())) as { compaction: Record<string, unknown> };
    expect(result.compaction.firstKeptEntryId).toBe("e9");
    expect(result.compaction.tokensBefore).toBe(90_000);
    expect(result.compaction.usage).toEqual(usage(0.01));
    const summary = result.compaction.summary as string;
    expect(summary.startsWith("## Kady scientific state")).toBe(true);
    expect(summary).toContain("[hypothesis] n1");
    expect(summary).toContain("## Conversation summary\nThe narrative.");
    expect(result.compaction.details).toEqual({
      readFiles: [],
      modifiedFiles: [],
      kady: { preambleVersion: PREAMBLE_VERSION, environmentId: "env-abc", resultIds: ["res-1"], reason: "threshold" },
    });
    const args = (generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(args[1]).toBe(model);
    expect(args[2]).toBe(16_384);
    expect(args[3]).toBe("k");
    expect(args[4]).toEqual({ "x-a": "1" });
    const instructions = args[6] as string;
    expect(instructions.startsWith(SCIENCE_COMPACTION_INSTRUCTIONS)).toBe(true);
    // The model sees the records it is summarized under, then the user's instructions last.
    expect(instructions).toContain("<kady-records>\n## Kady scientific state");
    expect(instructions).toContain("[hypothesis] n1");
    expect(instructions.endsWith("(they take precedence):\nkeep the QC thresholds")).toBe(true);
    expect(args[7]).toBe("earlier summary");
    expect(args[8]).toBe("high");
    expect(args[10]).toEqual({ E: "1" });
  });

  it("summarizes a split turn's prefix separately and sums the usage", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "History.", usage: usage(0.01) })
      .mockResolvedValueOnce({ text: "Turn so far.", usage: usage(0.005) }) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    const result = (await handler(
      event({ preparation: { ...event().preparation, isSplitTurn: true, turnPrefixMessages: [{ role: "assistant", content: "x" }] } }),
      ctx(),
    )) as { compaction: { summary: string; usage: { cost: { total: number }; totalTokens: number } } };
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.compaction.summary).toContain("## Conversation summary\nHistory.");
    expect(result.compaction.summary).toContain("## Current turn so far\nTurn so far.");
    expect(result.compaction.usage.cost.total).toBeCloseTo(0.015);
    expect(result.compaction.usage.totalTokens).toBe(240);
  });

  it("skips the history summary when the cut point leaves nothing before the split turn", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "Turn so far.", usage: usage(0.005) }) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    const result = (await handler(
      event({
        preparation: {
          ...event().preparation,
          messagesToSummarize: [],
          isSplitTurn: true,
          turnPrefixMessages: [{ role: "assistant", content: "x" }],
        },
      }),
      ctx(),
    )) as { compaction: { summary: string; usage: { cost: { total: number } } } };
    // One call: the prefix only. Pi's generator would otherwise be asked to
    // summarize an empty conversation and answer "no messages provided".
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toEqual([{ role: "assistant", content: "x" }]);
    // The earlier summary is carried forward verbatim instead of regenerated.
    expect(result.compaction.summary).toContain("## Conversation summary\nearlier summary");
    expect(result.compaction.summary).toContain("## Current turn so far\nTurn so far.");
    expect(result.compaction.usage.cost.total).toBeCloseTo(0.005);
  });

  it("reuses only the narrative of an earlier Kady summary, never its stale records", async () => {
    const earlier = [
      "## Kady scientific state (derived from the lab notebook, plan journal and provenance log)",
      "- job stale-job: running; last recorded update 1",
      "",
      "### Specialist work (snapshot at compaction; recheck live status before acting)",
      "- run-old: running",
      "",
      "## Conversation summary",
      "## Goal",
      "Find DE genes.",
      "",
      "<read-files>\nuser_data/counts.csv\n</read-files>",
    ].join("\n");
    const generate = vi.fn(async () => ({ text: "New narrative.", usage: usage(0.01) })) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    await handler(event({ preparation: { ...event().preparation, previousSummary: earlier } }), ctx());
    expect((generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][7]).toBe("## Goal\nFind DE genes.");

    // With nothing new before a split turn, the carried narrative is not nested inside a second preamble.
    const prefixOnly = vi.fn(async () => ({ text: "Turn so far.", usage: usage(0) })) as unknown as SummaryGenerator;
    const second = install(prefixOnly);
    const result = (await second.handler(
      event({
        preparation: {
          ...event().preparation,
          previousSummary: earlier,
          messagesToSummarize: [],
          isSplitTurn: true,
          turnPrefixMessages: [{ role: "assistant", content: "x" }],
        },
      }),
      ctx(),
    )) as { compaction: { summary: string } };
    const summary = result.compaction.summary;
    expect(summary.split("## Kady scientific state").length).toBe(2);
    expect(summary).not.toContain("stale-job");
    expect(summary).not.toContain("run-old");
    expect(summary).toContain("## Conversation summary\n## Goal\nFind DE genes.");
    // The read-file list survives, once, at the end.
    expect(summary.endsWith("<read-files>\nuser_data/counts.csv\n</read-files>")).toBe(true);
    expect(summary.split("<read-files>").length).toBe(2);
  });

  it("gives a split turn's prefix the turn-prefix focus without the records block", async () => {
    const generate = vi.fn(async () => ({ text: "x", usage: usage(0) })) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    await handler(
      event({ preparation: { ...event().preparation, isSplitTurn: true, turnPrefixMessages: [{ role: "assistant", content: "x" }] } }),
      ctx(),
    );
    const prefixInstructions = (generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][6] as string;
    expect(prefixInstructions.startsWith(TURN_PREFIX_FOCUS)).toBe(true);
    expect(prefixInstructions).toContain(SCIENCE_COMPACTION_INSTRUCTIONS);
    expect(prefixInstructions).not.toContain("<kady-records>");
    expect(prefixInstructions).toContain("keep the QC thresholds");
  });

  it("appends Pi's file lists, unioned with the ones the previous summary carried", async () => {
    const generate = vi.fn(async () => ({ text: "N.", usage: usage(0) })) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    const result = (await handler(
      event({
        preparation: {
          ...event().preparation,
          previousSummary: "Pi summary.\n\n<read-files>\na.csv\nfig.py\n</read-files>\n\n<modified-files>\nold.py\n</modified-files>",
          fileOps: { read: new Set(["b.csv"]), written: new Set(["fig.py"]), edited: new Set<string>() },
        },
      }),
      ctx(),
    )) as { compaction: { summary: string; details: { readFiles: string[]; modifiedFiles: string[] } } };
    expect(result.compaction.details.readFiles).toEqual(["a.csv", "b.csv"]);
    expect(result.compaction.details.modifiedFiles).toEqual(["fig.py", "old.py"]);
    expect(result.compaction.summary.endsWith(
      "## Conversation summary\nN.\n\n<read-files>\na.csv\nb.csv\n</read-files>\n\n<modified-files>\nfig.py\nold.py\n</modified-files>",
    )).toBe(true);
    // The model is not asked to restate lists that are re-appended anyway.
    expect((generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][7]).toBe("Pi summary.");
  });

  it("clips long tool results to head and tail before Pi keeps only the head", async () => {
    const long = `${"h".repeat(1500)}MIDDLE${"t".repeat(1500)}FINAL: p = 0.003`;
    const original = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: long }], isError: false };
    const short = { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false };
    const [clipped, untouched] = clipToolResultsForSummary([original, short] as never) as unknown as Array<typeof original>;
    const text = clipped.content[0].text;
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text.startsWith("hhh")).toBe(true);
    expect(text.endsWith("FINAL: p = 0.003")).toBe(true);
    expect(text).toContain("characters omitted");
    expect(text).not.toContain("MIDDLE");
    expect(original.content[0].text).toBe(long);
    expect(untouched).toBe(short);

    const generate = vi.fn(async () => ({ text: "x", usage: usage(0) })) as unknown as SummaryGenerator;
    const { handler } = install(generate);
    await handler(event({ preparation: { ...event().preparation, messagesToSummarize: [original] } }), ctx());
    const sent = (generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Array<typeof original>;
    expect(sent[0].content[0].text.endsWith("FINAL: p = 0.003")).toBe(true);
  });

  it("falls back to Pi's default (undefined) on generator errors, missing credentials or no model", async () => {
    const failing = vi.fn(async () => {
      throw new Error("provider down");
    }) as unknown as SummaryGenerator;
    const { handler, log } = install(failing);
    expect(await handler(event(), ctx())).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();

    const ok = vi.fn(async () => ({ text: "x", usage: usage(0) })) as unknown as SummaryGenerator;
    const noAuth = install(ok);
    expect(await noAuth.handler(event(), ctx({ ok: false, error: "no key" }))).toBeUndefined();
    expect(ok).not.toHaveBeenCalled();

    const noModel = install(ok);
    expect(await noModel.handler(event(), { ...ctx(), model: undefined })).toBeUndefined();
  });

  it("logs non-aborted compaction failures", () => {
    const { failed, log } = install(vi.fn() as unknown as SummaryGenerator);
    void failed({ type: "session_compact_failed", reason: "threshold", aborted: false, errorMessage: "boom", willRetry: false, fromExtension: true }, {});
    expect(log.warn).toHaveBeenCalledWith({ reason: "threshold", error: "boom" }, "context compaction failed");
    log.warn.mockClear();
    void failed({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }, {});
    expect(log.warn).not.toHaveBeenCalled();
  });
});
