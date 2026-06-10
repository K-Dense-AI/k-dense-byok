import { describe, expect, it } from "vitest";
import {
  MAX_IMAGES,
  makeInterviewTool,
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewParamsT,
} from "../src/agent/interview.ts";

const QUESTIONS: InterviewParamsT = {
  title: "Analysis setup",
  description: "Confirm before I start.",
  questions: [
    { id: "ctx", type: "info", question: "Context", context: "Two datasets found." },
    {
      id: "dataset",
      type: "single",
      question: "Which dataset?",
      options: ["raw.h5ad", "filtered.h5ad"],
      recommended: "filtered.h5ad",
      conviction: "strong",
    },
    { id: "notes", type: "text", question: "Anything else?" },
  ],
};

function tool(projectId = "proj", sessionId = "sess") {
  return makeInterviewTool(projectId, () => sessionId);
}

// execute's trailing onUpdate/ctx params are unused by the interview tool.
const noCtx = undefined as never;

describe("interview tool", () => {
  it("blocks until resolveInterview supplies answers, then returns them", async () => {
    const t = tool();
    const run = t.execute("call-1", QUESTIONS, undefined, undefined, noCtx);

    // The interview is registered and discoverable while pending.
    expect(pendingInterviewFor("proj", "sess")?.toolCallId).toBe("call-1");

    const ok = resolveInterview("proj", "sess", "call-1", {
      responses: [
        { id: "dataset", value: "filtered.h5ad" },
        { id: "notes", value: "go ahead" },
      ],
    });
    expect(ok).toBe(true);

    const result = await run;
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text).responses).toEqual([
      { id: "dataset", value: "filtered.h5ad" },
      { id: "notes", value: "go ahead" },
    ]);
    expect(pendingInterviewFor("proj", "sess")).toBeNull();
  });

  it("returns uploaded images as image content blocks", async () => {
    const t = tool();
    const run = t.execute("call-img", QUESTIONS, undefined, undefined, noCtx);
    resolveInterview("proj", "sess", "call-img", {
      responses: [
        {
          id: "notes",
          value: "see screenshot",
          attachments: [{ data: "aGVsbG8=", mimeType: "image/png" }],
        },
      ],
    });
    const result = await run;
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(summary.responses[0].images).toBe(1);
  });

  it("returns a graceful dismissal message when cancelled", async () => {
    const t = tool();
    const run = t.execute("call-2", QUESTIONS, undefined, undefined, noCtx);
    resolveInterview("proj", "sess", "call-2", { cancelled: true });
    const result = await run;
    expect((result.content[0] as { text: string }).text).toContain("dismissed");
    expect(result.details).toEqual({ cancelled: true });
  });

  it("rejects when the run is aborted", async () => {
    const t = tool();
    const ac = new AbortController();
    const run = t.execute("call-3", QUESTIONS, ac.signal, undefined, noCtx);
    ac.abort();
    await expect(run).rejects.toThrow(/aborted/i);
    expect(pendingInterviewFor("proj", "sess")).toBeNull();
  });

  it("times out with an actionable error", async () => {
    const t = tool();
    const run = t.execute(
      "call-4",
      { ...QUESTIONS, timeout: 1 },
      undefined,
      undefined,
      noCtx,
    );
    await expect(run).rejects.toThrow(/timed out/);
    expect(pendingInterviewFor("proj", "sess")).toBeNull();
  }, 5000);

  it("validates question shape up front", async () => {
    const t = tool();
    const dup: InterviewParamsT = {
      title: "x",
      questions: [
        { id: "a", type: "text", question: "q1" },
        { id: "a", type: "text", question: "q2" },
      ],
    };
    await expect(t.execute("c", dup, undefined, undefined, noCtx)).rejects.toThrow(
      /Duplicate/,
    );
    const noOptions: InterviewParamsT = {
      title: "x",
      questions: [{ id: "a", type: "single", question: "pick" }],
    };
    await expect(
      t.execute("c2", noOptions, undefined, undefined, noCtx),
    ).rejects.toThrow(/no options/);
  });

  it("refuses answers from the wrong project or session", async () => {
    const t = tool();
    const run = t.execute("call-5", QUESTIONS, undefined, undefined, noCtx);
    expect(
      resolveInterview("other", "sess", "call-5", { responses: [] }),
    ).toBe(false);
    expect(
      resolveInterview("proj", "other", "call-5", { responses: [] }),
    ).toBe(false);
    expect(resolveInterview("proj", "sess", "nope", { responses: [] })).toBe(false);
    expect(resolveInterview("proj", "sess", "call-5", { responses: [] })).toBe(true);
    await run;
  });
});

describe("validateAnswer", () => {
  it("accepts well-formed answers and cancellations", () => {
    expect(validateAnswer({ cancelled: true })).toBeNull();
    expect(
      validateAnswer({ responses: [{ id: "a", value: ["x", "y"] }] }),
    ).toBeNull();
  });

  it("rejects malformed responses", () => {
    expect(validateAnswer({ responses: "no" as never })).toMatch(/array/);
    expect(
      validateAnswer({ responses: [{ id: 1 as never, value: "x" }] }),
    ).toMatch(/string id/);
    expect(
      validateAnswer({ responses: [{ id: "a", value: 5 as never }] }),
    ).toMatch(/value/);
  });

  it("enforces image limits", () => {
    expect(
      validateAnswer({
        responses: [
          {
            id: "a",
            value: "x",
            attachments: [{ data: "abc", mimeType: "text/plain" }],
          },
        ],
      }),
    ).toMatch(/only image/);
    const big = "A".repeat(7 * 1024 * 1024); // ~5.25MB decoded
    expect(
      validateAnswer({
        responses: [
          { id: "a", value: "x", attachments: [{ data: big, mimeType: "image/png" }] },
        ],
      }),
    ).toMatch(/exceeds/);
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => ({
      data: "aGVsbG8=",
      mimeType: "image/png",
    }));
    expect(
      validateAnswer({ responses: [{ id: "a", value: "x", attachments: many }] }),
    ).toMatch(/at most/);
  });
});
