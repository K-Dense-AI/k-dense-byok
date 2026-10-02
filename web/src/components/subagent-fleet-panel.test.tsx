import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/subagent-fleet";
import { SubagentFleetPanel } from "./subagent-fleet-panel";
vi.mock("@/lib/subagent-fleet", () => ({ fleetSessions: vi.fn(), getFleet: vi.fn(), controlSpecialist: vi.fn() }));
const snapshot: api.FleetSnapshot = {
  text: "", fleet: { totalActive: 1, omitted: 0, entries: [{ key: "opaque", agent: "reviewer", model: "local/model", tokens: { input: 10, output: 5, total: 15 } }] },
  asyncSnapshot: { runs: [{ id: "run", kind: "workflow", label: "Review", state: "running", children: [{ id: "stage-b", kind: "step", label: "Check units", state: "running", control: { runId: "run", index: 7, childId: "stage-b" } }] }] },
};
beforeEach(() => {
  vi.mocked(api.fleetSessions).mockResolvedValue({ sessions: [{ id: "chat", name: "Research" }] });
  vi.mocked(api.getFleet).mockResolvedValue(snapshot);
  vi.mocked(api.controlSpecialist).mockResolvedValue({ text: "Transcript and receipt" });
});
afterEach(() => { vi.clearAllMocks(); });
async function renderFleet() {
  let view!: ReturnType<typeof render>;
  // Settle the mocked chats -> fleet promise chain before querying controls.
  // Busy native CI runners can exceed findByRole's default one-second window.
  await act(async () => { view = render(<SubagentFleetPanel projectId="p1" />); });
  return view;
}
it("inspects the canonical child, sends guidance, and confirms a child stop", async () => {
  const user = userEvent.setup(); await renderFleet();
  await user.click(await screen.findByRole("button", { name: "Inspect Check units" }));
  expect(await screen.findByLabelText("Specialist transcript")).toHaveTextContent("Transcript and receipt");
  expect(api.controlSpecialist).toHaveBeenCalledWith("p1", "chat", "transcript", "run", undefined, 7);
  await user.type(screen.getByLabelText("Instructions for this specialist"), "Check units again");
  await user.click(screen.getByRole("button", { name: "Send guidance" }));
  await waitFor(() => expect(api.controlSpecialist).toHaveBeenCalledWith("p1", "chat", "steer", "run", "Check units again", 7));
  await user.click(screen.getByRole("button", { name: "Stop specialist" }));
  expect(api.controlSpecialist).not.toHaveBeenCalledWith("p1", "chat", "stop", "run", expect.anything(), 7);
  await user.click(screen.getByRole("button", { name: "Confirm stop" }));
  await waitFor(() => expect(api.controlSpecialist).toHaveBeenCalledWith("p1", "chat", "stop", "run", "", 7));
});
it("offers resume for a terminal run", async () => {
  vi.mocked(api.getFleet).mockResolvedValue({ ...snapshot, asyncSnapshot: { runs: [{ id: "run", kind: "subagent", label: "Review", state: "paused" }] } });
  const user = userEvent.setup(); await renderFleet();
  await user.click(await screen.findByRole("button", { name: "Transcript & controls" }));
  await user.type(screen.getByLabelText("Instructions for this specialist"), "Continue analysis");
  await user.click(screen.getByRole("button", { name: "Resume with instructions" }));
  await waitFor(() => expect(api.controlSpecialist).toHaveBeenCalledWith("p1", "chat", "resume", "run", "Continue analysis", undefined));
});
it("discards a transcript that arrives after switching project", async () => {
  let resolve!: (value: { text: string }) => void;
  vi.mocked(api.controlSpecialist).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); const { rerender } = await renderFleet();
  await user.click(await screen.findByRole("button", { name: "Inspect Check units" }));
  rerender(<SubagentFleetPanel projectId="p2" />);
  await act(async () => { resolve({ text: "Stale private transcript" }); });
  expect(screen.queryByText("Stale private transcript")).not.toBeInTheDocument();
});
