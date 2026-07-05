import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projects from "@/lib/projects";
import { buildRunBody, useAgent } from "@/lib/use-agent";

/** Build an SSE response body streaming one `data: <json>\n\n` frame per entry. */
function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

describe("buildRunBody", () => {
  it("includes thinkingLevel when provided — including an explicit 'off'", () => {
    expect(
      buildRunBody({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" }),
    ).toEqual({ message: "hi", model: "openrouter/openai/gpt-5.5", thinkingLevel: "high" });
    // Pi sessions remember the level across runs; "off" must reach the wire to reset it.
    expect(buildRunBody({ message: "hi", thinkingLevel: "off" })).toEqual({
      message: "hi",
      thinkingLevel: "off",
    });
  });

  it("omits thinkingLevel when absent", () => {
    expect(buildRunBody({ message: "hi" })).toEqual({ message: "hi" });
  });

  it("keeps computeTarget behavior: sent when set, omitted for 'local'", () => {
    expect(buildRunBody({ message: "hi", computeTarget: "h100" })).toEqual({
      message: "hi",
      computeTarget: "h100",
    });
    expect(buildRunBody({ message: "hi", computeTarget: "local" })).toEqual({ message: "hi" });
  });

  it("includes fusionConfig when provided", () => {
    const fusionConfig = { plugins: [] };
    expect(buildRunBody({ message: "hi", model: "fusion/x", fusionConfig })).toEqual({
      message: "hi",
      model: "fusion/x",
      fusionConfig,
    });
  });
});

describe("useAgent notebook accumulation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accumulates notebook entries from tool_start frames", async () => {
    vi.spyOn(projects, "apiFetch").mockImplementation(async (path: string) => {
      if (path === "/sessions") {
        return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
      }
      if (path === "/sessions/s1/run") {
        return new Response(
          sseStream([
            {
              type: "tool_start",
              toolName: "notebook",
              toolCallId: "tc_1",
              args: { type: "hypothesis", title: "Six types" },
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected apiFetch path: ${path}`);
    });

    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.notebookEntries.map((e) => e.id)).toEqual(["tc_1"]);
  });
});
