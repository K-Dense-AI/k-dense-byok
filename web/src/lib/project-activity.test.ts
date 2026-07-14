import { describe, expect, it } from "vitest";

import { summarizeProjectActivity } from "./project-activity";

describe("summarizeProjectActivity", () => {
  it("separates active runs waiting for input from ordinary running tabs", () => {
    expect(
      summarizeProjectActivity(
        [
          { isStreaming: true, runState: "running", needsInput: true },
          { isStreaming: true, runState: "running", needsInput: false },
        ],
        false,
      ),
    ).toEqual({
      running: 1,
      needsInput: 1,
      errors: 0,
      blocked: 0,
      done: 0,
    });
  });

  it("keeps errors and completed tabs visible across concurrent sessions", () => {
    expect(
      summarizeProjectActivity(
        [
          { isStreaming: false, runState: "error", needsInput: false },
          { isStreaming: false, runState: "done", needsInput: false },
          { isStreaming: false, runState: "blocked", needsInput: false },
        ],
        true,
      ),
    ).toEqual({
      running: 0,
      needsInput: 0,
      errors: 1,
      blocked: 1,
      done: 1,
    });
  });
});
