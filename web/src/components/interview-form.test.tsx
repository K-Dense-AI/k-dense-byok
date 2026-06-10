import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InterviewCard, parseInterviewPayload } from "./interview-form";
import type { ActivityItem } from "@/lib/use-agent";

const PAYLOAD = {
  title: "Project setup",
  description: "Review my suggestions.",
  questions: [
    { id: "ctx", type: "info", question: "Context", context: "Found 2 datasets." },
    {
      id: "framework",
      type: "single",
      question: "Which framework?",
      options: ["React", "Vue", { label: "Svelte", content: "Smallest bundle" }],
      recommended: "React",
      conviction: "strong",
      weight: "critical",
    },
    {
      id: "features",
      type: "multi",
      question: "Which features?",
      options: ["SSR", "Edge"],
      recommended: ["SSR"],
      conviction: "slight",
    },
    { id: "notes", type: "text", question: "Anything else?" },
  ],
};

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "tc-1",
    label: "Running interview",
    status: "running",
    timestamp: 1,
    toolName: "interview",
    args: PAYLOAD,
    ...overrides,
  };
}

function mockFetch(status = 200, body: unknown = { ok: true }) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("parseInterviewPayload", () => {
  it("accepts well-formed args and rejects junk", () => {
    expect(parseInterviewPayload(PAYLOAD)?.title).toBe("Project setup");
    expect(parseInterviewPayload(null)).toBeNull();
    expect(parseInterviewPayload({ questions: [] })).toBeNull();
    expect(parseInterviewPayload("text")).toBeNull();
  });
});

describe("InterviewCard", () => {
  it("renders questions, pre-selects strong recommendations only", () => {
    mockFetch();
    render(<InterviewCard item={item()} sessionId="sess" />);
    expect(screen.getByText("Project setup")).toBeInTheDocument();
    expect(screen.getByText("Which framework?")).toBeInTheDocument();
    // strong conviction → React pre-selected
    expect(screen.getByRole("button", { name: /React/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // slight conviction → SSR shown as recommended but NOT pre-selected
    expect(screen.getByRole("button", { name: /SSR/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("submits answers for all non-info questions", async () => {
    const fetchMock = mockFetch();
    const user = userEvent.setup();
    render(<InterviewCard item={item()} sessionId="sess" />);

    await user.click(screen.getByRole("button", { name: /Svelte/ }));
    await user.click(screen.getByRole("button", { name: /SSR/ }));
    await user.type(screen.getByPlaceholderText(/Type your answer/), "ship it");
    await user.click(screen.getByRole("button", { name: /Submit answers/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sessions/sess/interview/tc-1");
    const body = JSON.parse(String(init.body));
    expect(body.responses).toEqual([
      { id: "framework", value: "Svelte" },
      { id: "features", value: ["SSR"] },
      { id: "notes", value: "ship it" },
    ]);
    expect(await screen.findByText(/agent is continuing/)).toBeInTheDocument();
  });

  it("posts a cancellation from Skip", async () => {
    const fetchMock = mockFetch();
    const user = userEvent.setup();
    render(<InterviewCard item={item()} sessionId="sess" />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ cancelled: true });
  });

  it("surfaces a 400 and stays editable for resubmission", async () => {
    const fetchMock = mockFetch(400, { detail: "image exceeds 5MB" });
    const user = userEvent.setup();
    render(<InterviewCard item={item()} sessionId="sess" />);
    await user.click(screen.getByRole("button", { name: /Submit answers/ }));
    expect(await screen.findByText(/image exceeds 5MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit answers/ })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the submitted summary after tool_end", () => {
    mockFetch();
    render(
      <InterviewCard
        item={item({
          status: "complete",
          result: JSON.stringify({
            responses: [{ id: "framework", value: "React" }],
          }),
        })}
        sessionId="sess"
      />,
    );
    expect(screen.getByText("answered")).toBeInTheDocument();
    expect(screen.getByText("Which framework?")).toBeInTheDocument();
    expect(screen.getByText("React")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit answers/ })).toBeNull();
  });

  it("shows an expired state when the tool errored (timeout/abort)", () => {
    mockFetch();
    render(
      <InterviewCard
        item={item({ status: "error", result: "Interview timed out" })}
        sessionId="sess"
      />,
    );
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit answers/ })).toBeNull();
  });
});
