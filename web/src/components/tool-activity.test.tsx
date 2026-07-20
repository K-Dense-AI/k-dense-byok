import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalJobChip, NotebookEntryChip, ToolActivityList } from "./tool-activity";
import type { ActivityItem } from "@/lib/use-agent";

const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "tc_9",
  label: "Running notebook",
  status: "complete",
  timestamp: 1000,
  ...over,
});

describe("ToolActivityList", () => {
  it("stamps each tool card with its tool-call id", () => {
    const { container } = render(
      <ToolActivityList
        activities={[
          item({ id: "tc_a", toolName: "bash", args: { command: "ls" } }),
          item({ id: "tc_b", toolName: "read", args: { path: "notes.md" } }),
        ]}
      />,
    );
    expect(container.querySelector('[data-tool-call-id="tc_a"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-call-id="tc_b"]')).not.toBeNull();
  });

  it("renders nothing for an empty activity list", () => {
    const { container } = render(<ToolActivityList activities={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the specialist name from a single-task subagent call", () => {
    render(
      <ToolActivityList
        activities={[
          item({
            toolName: "subagent",
            args: {
              tasks: [
                {
                  agent: "statistical-reviewer",
                  task: "Audit the final analysis",
                },
              ],
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText("statistical-reviewer: Audit the final analysis"),
    ).toBeInTheDocument();
    expect(screen.queryByText("subtask")).not.toBeInTheDocument();
  });

  it("shows every specialist name from a parallel subagent call", () => {
    render(
      <ToolActivityList
        activities={[
          item({
            toolName: "subagent",
            args: {
              tasks: [
                { agent: "researcher", task: "Find sources" },
                { agent: "methodology-reviewer", task: "Review methods" },
              ],
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText("researcher + methodology-reviewer"),
    ).toBeInTheDocument();
  });

  it("recovers the specialist name from a completed status result", () => {
    render(
      <ToolActivityList
        activities={[
          item({
            toolName: "subagent",
            args: { action: "status", id: "run-1" },
            result: "Step 1: statistical-reviewer running, active but long-running",
          }),
        ]}
      />,
    );
    expect(screen.getByText("statistical-reviewer")).toBeInTheDocument();
  });
});

describe("NotebookEntryChip", () => {
  it("renders the capitalized entry type and title from the tool args", () => {
    render(
      <NotebookEntryChip
        item={item({ toolName: "notebook", args: { type: "hypothesis", title: "Six cell types" } })}
      />,
    );
    expect(screen.getByText("Notebook · Hypothesis")).toBeInTheDocument();
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
  });

  it("falls back to 'Entry' when the args carry no type", () => {
    render(<NotebookEntryChip item={item({ toolName: "notebook", args: {} })} />);
    expect(screen.getByText("Notebook · Entry")).toBeInTheDocument();
  });

  it("carries the tool-call id on its root element", () => {
    const { container } = render(
      <NotebookEntryChip item={item({ args: { type: "note", title: "x" } })} />,
    );
    expect(container.querySelector('[data-tool-call-id="tc_9"]')).not.toBeNull();
  });

  it("shows 'View in notebook' only when onView is given, and fires it with the entry id", () => {
    const onView = vi.fn();
    const { rerender } = render(
      <NotebookEntryChip item={item({ args: { type: "note", title: "x" } })} />,
    );
    expect(screen.queryByRole("button", { name: /view in notebook/i })).not.toBeInTheDocument();

    rerender(
      <NotebookEntryChip item={item({ args: { type: "note", title: "x" } })} onView={onView} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view in notebook/i }));
    expect(onView).toHaveBeenCalledWith("tc_9");
  });
});

describe("ModalJobChip", () => {
  it("links a durable tool result to its Compute job detail", () => {
    const onView = vi.fn();
    render(
      <ModalJobChip
        item={item({
          toolName: "modal_submit",
          result: JSON.stringify({ jobId: "job-abc123", status: "queued" }),
        })}
        onView={onView}
      />,
    );
    expect(screen.getByText("job-abc123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View job" }));
    expect(onView).toHaveBeenCalledWith("job-abc123");
  });

  it("still opens the Compute panel when a Modal result has no job id", () => {
    const onView = vi.fn();
    render(
      <ModalJobChip
        item={item({ toolName: "modal_run", result: "Compute completed" })}
        onView={onView}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Compute" }));
    expect(onView).toHaveBeenCalledWith(undefined);
  });
});
