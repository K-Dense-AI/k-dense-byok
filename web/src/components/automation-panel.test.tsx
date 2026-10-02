import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lib from "@/lib/automation";
import { AutomationPanel } from "./automation-panel";
vi.mock("./subagent-fleet-panel", () => ({ SubagentFleetPanel: () => null }));

afterEach(() => vi.restoreAllMocks());

const schedule = (overrides: Partial<lib.ScheduleView> = {}): lib.ScheduleView => ({
  id: "nightly-qc",
  name: "Nightly QC",
  trigger: { kind: "interval", every: "6h", everyMs: 21_600_000, anchorAt: "2026-09-08T00:00:00.000Z", nextRunAt: "2026-09-08T06:00:00.000Z" },
  workflowScript: 'return runs.run("main", { agent: "data-validator", task: "Re-check" })',
  quiet: false,
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
    const pause = vi.spyOn(lib, "scheduleAction").mockResolvedValue({ schedules: [schedule({ paused: true })], message: "Paused." });
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
    // A paused schedule's stored next slot will not fire.
    expect(screen.getByText(/^every 6h/).textContent).not.toMatch(/next/);
  });

  it("keeps Run now off while held, shows fire results and the pinned model, and names redacted missions", async () => {
    vi.spyOn(lib, "getSchedules").mockResolvedValue({
      schedules: [schedule({
        heldByBudget: true, paused: true, quiet: true, model: "openrouter/openai/gpt-6-astra",
        runs: [
          { id: "r2", plannedAt: "2026-09-08T06:00:00.000Z", dueReason: "manual", state: "failed_run", error: "Project spend limit reached before the first model request in this long explanation" },
          { id: "r1", plannedAt: "2026-09-08T00:00:00.000Z", dueReason: "timer", state: "completed", summary: "delegate:\n30 data rows (header excluded)." },
        ],
      })],
      heldByBudget: ["nightly-qc"],
      schedulerSessionId: "host",
    });
    vi.spyOn(lib, "getMissions").mockResolvedValue([
      { id: "m1", title: "[prompt redacted]", objective: "[prompt redacted]", status: "active", createdAt: "", updatedAt: "2026-09-08T01:00:00.000Z", runs: [{ runId: "r", mode: "workflow", agent: "worker" }], decisions: [], receipts: [] },
    ]);
    render(<AutomationPanel projectId="p1" />);
    expect(await screen.findByRole("button", { name: "Run Nightly QC now" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Expand Nightly QC" }));
    expect(screen.getByText(/30 data rows/)).toBeInTheDocument();
    expect(screen.getByText(/model: openrouter\/openai\/gpt-6-astra/)).toBeInTheDocument();
    expect(screen.getByText(/quiet/)).toBeInTheDocument();
    expect(screen.getByText(/long explanation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close mission worker run" }));
    expect(await screen.findByText('Close mission "worker run"?')).toBeInTheDocument();
  });

  it("reports what a manual fire did", async () => {
    vi.spyOn(lib, "getSchedules").mockResolvedValue({ schedules: [schedule()], heldByBudget: [], schedulerSessionId: "host" });
    vi.spyOn(lib, "getMissions").mockResolvedValue([]);
    vi.spyOn(lib, "scheduleAction").mockResolvedValue({ schedules: [schedule({ activeRunId: "a" })], message: "Started schedule nightly-qc run r3.\nAsync: a" });
    render(<AutomationPanel projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Run Nightly QC now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Started schedule nightly-qc run r3.");
  });

  it("shows the empty states", async () => {
    vi.spyOn(lib, "getSchedules").mockResolvedValue({ schedules: [], heldByBudget: [], schedulerSessionId: null });
    vi.spyOn(lib, "getMissions").mockResolvedValue([]);
    render(<AutomationPanel projectId="p1" />);
    expect(await screen.findByText(/No schedules yet/)).toBeInTheDocument();
    expect(screen.getByText(/No missions recorded/)).toBeInTheDocument();
  });
});
