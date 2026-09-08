/**
 * Science-aware compaction: the deterministic state preamble and the
 * session_before_compact handler (with an injected summary generator).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
import { appendStep, PROVENANCE_SCHEMA_VERSION } from "../src/provenance/store.ts";
import {
  buildCompactionPreamble,
  makeScientificCompactionExtension,
  PREAMBLE_VERSION,
  SCIENCE_COMPACTION_INSTRUCTIONS,
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

  it("states plainly when nothing is recorded", () => {
    const preamble = buildCompactionPreamble(projectId, "fresh");
    expect(preamble.text).toContain("(no notebook entries, plans or results recorded yet)");
    expect(preamble.resultIds).toEqual([]);
  });
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
    fileOps: { readFiles: [], modifiedFiles: [] },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  },
  customInstructions: "keep the QC thresholds",
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
  ...overrides,
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
      kady: { preambleVersion: PREAMBLE_VERSION, environmentId: "env-abc", resultIds: ["res-1"], reason: "threshold" },
    });
    const args = (generate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(args[1]).toBe(model);
    expect(args[2]).toBe(16_384);
    expect(args[3]).toBe("k");
    expect(args[4]).toEqual({ "x-a": "1" });
    expect(args[6]).toBe(`${SCIENCE_COMPACTION_INSTRUCTIONS}\n\nkeep the QC thresholds`);
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
