import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotebookPlanDialog } from "./notebook-plan-dialog";
import type { AnalysisPlanInput, AnalysisPlanHistory, FrozenPlanEvent } from "@/lib/notebook-plans";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
const { apiFetch } = await import("@/lib/projects");
const fetch = vi.mocked(apiFetch);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
const plan: AnalysisPlanInput = { hypothesis: "Treatment effect", primaryOutcome: "Mean score", exclusions: "QC only", model: "Linear model", multiplicity: "One test", qc: "No missingness", stopping: "100 samples", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
const source = { sessionId: "s1", entryId: "h1" };
const history: AnalysisPlanHistory = { source, head: null, events: [] };
const frozen: FrozenPlanEvent = { version: 1, kind: "freeze", id: "plan-1", sequence: 1, previousDigest: null, digest: "digest-1", source, actor: "user", recordedAt: 1000, revision: 1, previewId: "preview-1", plan, datasets: [{ path: "data.csv", capturedAt: 1000, sha256: "a".repeat(64) }], revisionReason: "", acknowledgedUnverified: false, sourceDigest: "source" };
const json = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as Response;
function setup(unknown = false, frozenHistory = false) {
  fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/preview")) return json({ id: "preview-1", source, expectedHead: null, plan: JSON.parse(String(init?.body)).plan, datasets: [{ path: "data.csv", capturedAt: 1000, ...(unknown ? { reason: "missing" } : { sha256: "a".repeat(64) }) }], createdAt: 1000, expiresAt: Date.now() + 60000, revisionReason: "" });
    if (String(url).endsWith("/freeze")) return json({ source, head: frozen.digest, events: [frozen] });
    return json(frozenHistory ? { source, head: frozen.digest, events: [frozen] } : history);
  });
  return render(<NotebookPlanDialog entry={{ id: "h1", type: "hypothesis", title: "Claim", timestamp: 1, analysisPlan: plan }} sessionId="s1" projectId="project-a" />);
}
async function openPreview() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review proposed analysis plan" }));
  await user.click(await screen.findByRole("button", { name: "Prepare plan" }));
  await user.click(screen.getByRole("button", { name: "Review freeze preview" }));
  await screen.findByText("Review exactly what will be frozen");
  return user;
}
beforeEach(() => { vi.clearAllMocks(); });

describe("local analysis-plan approval", () => {
  it("never fetches or approves merely by rendering a proposed plan", () => {
    setup(); expect(fetch).not.toHaveBeenCalled(); expect(screen.getByText("Review proposed analysis plan")).toBeInTheDocument();
  });
  it("requires explicit confirmation and sends only the reviewed preview token", async () => {
    setup(); const user = await openPreview();
    expect(screen.getByRole("button", { name: "Approve and freeze locally" })).toBeDisabled();
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/freeze"))).toBe(false);
    await user.click(screen.getByRole("checkbox", { name: /I approve this local plan record/ }));
    await user.click(screen.getByRole("button", { name: "Approve and freeze locally" }));
    await screen.findByText(/Frozen revision 1/);
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/freeze"))!;
    expect(call[2]).toBe("project-a");
    expect(JSON.parse(String(call[1]?.body))).toEqual({ previewId: "preview-1", acknowledgeLocalFreeze: true, acknowledgeUnverified: false });
    expect(screen.getByText(/not external preregistration/)).toBeInTheDocument();
  });
  it("requires a second acknowledgment when dataset identities are unverified", async () => {
    setup(true); const user = await openPreview();
    await user.click(screen.getByRole("checkbox", { name: /I approve this local plan record/ }));
    expect(screen.getByRole("button", { name: "Approve and freeze locally" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /some dataset identities are unverified/ }));
    expect(screen.getByRole("button", { name: "Approve and freeze locally" })).toBeEnabled();
  });
  it("discards a stale preview on conflict and requires a reload instead of silent reapproval", async () => {
    setup(); const user = await openPreview();
    fetch.mockResolvedValueOnce(json({ detail: "Plan history changed. Reload and review again." }, false, 409));
    await user.click(screen.getByRole("checkbox", { name: /I approve this local plan record/ }));
    await user.click(screen.getByRole("button", { name: "Approve and freeze locally" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("history changed");
    expect(screen.queryByRole("button", { name: "Approve and freeze locally" })).not.toBeInTheDocument();
  });
  it("records deviations with a head precondition and no caller-supplied planned value", async () => {
    setup(false, true); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review proposed analysis plan" }));
    await user.click(await screen.findByRole("button", { name: "Record deviation" }));
    expect(screen.getByText("Planned: Linear model")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What was actually done"), { target: { value: "Huber regression" } });
    fireEvent.change(screen.getByLabelText("Reason for deviation"), { target: { value: "Outliers" } });
    await user.selectOptions(screen.getByLabelText("Decision timing"), "after-results");
    await user.click(screen.getByRole("button", { name: "Save deviation" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/deviations"))).toBe(true));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/deviations"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ expectedHead: "digest-1", planId: "plan-1", field: "model", actual: "Huber regression", reason: "Outliers", timing: "after-results" });
  });
  it("updates a closed plan control from a newer project refresh without fetching", async () => {
    const entry = { id: "h1", type: "hypothesis" as const, title: "Claim", timestamp: 1 };
    const view = render(<NotebookPlanDialog entry={entry} sessionId="s1" projectId="project-a" />);
    view.rerender(<NotebookPlanDialog entry={{ ...entry, planHistory: { source, head: frozen.digest, events: [frozen] } }} sessionId="s1" projectId="project-a" />);
    expect(await screen.findByRole("button", { name: "Analysis plan · revision 1" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("disables approval controls for provisional notebook entries", () => {
    render(<NotebookPlanDialog entry={{ id: "h", type: "hypothesis", title: "Draft", timestamp: 1, provisional: true }} sessionId="s" projectId="p" />);
    expect(screen.getByRole("button", { name: "Analysis plan" })).toBeDisabled();
  });
});
