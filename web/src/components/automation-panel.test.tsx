import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lib from "@/lib/automation";
import { AutomationPanel } from "./automation-panel";

afterEach(() => vi.restoreAllMocks());

const schedule = (overrides: Partial<lib.ScheduleView> = {}): lib.ScheduleView => ({
  id: "nightly-qc",
  name: "Nightly QC",
  trigger: { kind: "interval", every: "6h", everyMs: 21_600_000, anchorAt: "2026-09-08T00:00:00.000Z", nextRunAt: "2026-09-08T06:00:00.000Z" },
  workflowScript: 'return runs.run("main", { agent: "data-validator", task: "Re-check" })',
  paused: false,
  heldByBudget: false,
  catchUp: "latest",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  runs: [{ id: "r1", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "timer", state: "completed" }],
  lastRun: { id: "r1", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "timer", state: "completed" },
  spendUsd: 0.42,
  ...overrides,
});

describe("AutomationPanel", () => {
  it("lists schedules with hold state and spend, expands the script, and pauses through the API", async () => {
    vi.spyOn(lib, "getSchedules").mockResolvedValue({
      schedules: [schedule(), schedule({ id: "held", name: "Held one", heldByBudget: true })],
      heldByBudget: ["held"],
      schedulerSessionId: "host",
    });
    vi.spyOn(lib, "getMissions").mockResolvedValue([
      { id: "m1", title: "Ship QC", objective: "Validate uploads", status: "needs_decision", createdAt: "", updatedAt: "2026-09-08T01:00:00.000Z", runs: [], decisions: [{ id: "d", status: "open", title: "?" }], receipts: [] },
    ]);
    const pause = vi.spyOn(lib, "scheduleAction").mockResolvedValue([schedule({ paused: true })]);
    render(<AutomationPanel projectId="p1" />);
    expect(await screen.findByText("Nightly QC")).toBeInTheDocument();
    expect(screen.getByText("Held: spend limit")).toBeInTheDocument();
    expect(screen.getByText(/1 schedule is held/)).toBeInTheDocument();
    expect(screen.getAllByText(/\$0\.420 spent/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ship QC")).toBeInTheDocument();
    expect(screen.getByText(/1 open decision/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand Nightly QC" }));
    expect(screen.getByText(/runs\.run\("main"/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause Nightly QC" }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("nightly-qc", "pause", "p1"));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("shows the empty states", async () => {
    vi.spyOn(lib, "getSchedules").mockResolvedValue({ schedules: [], heldByBudget: [], schedulerSessionId: null });
    vi.spyOn(lib, "getMissions").mockResolvedValue([]);
    render(<AutomationPanel projectId="p1" />);
    expect(await screen.findByText(/No schedules yet/)).toBeInTheDocument();
    expect(screen.getByText(/No missions recorded/)).toBeInTheDocument();
  });
});
