import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotebookRobustnessDialog, RobustnessResults } from "./notebook-robustness-dialog";
import { robustnessDraft as draft, robustnessPreview as preview, robustnessWorkflow as workflow } from "@/test/robustness-fixture";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
const { apiFetch } = await import("@/lib/projects");
const fetch = vi.mocked(apiFetch);
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const props = { entry: { id: "h1", type: "hypothesis" as const, title: "Question", timestamp: 1, robustness: draft }, sessionId: "s1", projectId: "project-a", onOpenFile: vi.fn() };
function routes(opts: { noPlan?: boolean; configured?: boolean; warnings?: boolean; active?: boolean } = {}) {
  fetch.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/plans")) return json({ head: "head-1", events: opts.noPlan ? [] : [{ kind: "freeze", id: "plan-1", revision: 1 }] });
    if (url === "/modal/instances") return json({ instances: [{ id: "cpu-2", label: "CPU 2", pricePerHour: 0.1 }] });
    if (url.endsWith("/preview")) return json({ ...preview, warnings: opts.warnings ? ["Original plan dataset was unverified"] : [] });
    if (url.endsWith("/approve")) return json(workflow);
    if (url.endsWith("/cancel")) return json({ ...workflow, cancelled: true, attempts: workflow.attempts.map((a) => ({ ...a, state: "cancelled", result: undefined })) });
    return json({ workflows: opts.active ? [{ ...workflow, attempts: workflow.attempts.map((a) => ({ ...a, state: "running", result: undefined })) }] : [], errors: [], configured: opts.configured !== false });
  });
}
async function review() {
  const user = userEvent.setup(); render(<NotebookRobustnessDialog {...props} />);
  await user.click(screen.getByRole("button", { name: "Stress-test finding" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare robustness workflow" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Prepare robustness workflow" }));
  await user.click(screen.getByRole("button", { name: "Prepare snapshot and quote" }));
  await screen.findByText(/Review exact snapshot and all 2 specifications/);
  return user;
}
async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /I reviewed this exact script/ }));
  await user.click(screen.getByRole("checkbox", { name: /I authorize uploading/ }));
  await user.click(screen.getByRole("checkbox", { name: /I approve the estimated commitment/ }));
}
beforeEach(() => { vi.clearAllMocks(); routes(); });

describe("robustness approval UI", () => {
  it("does not fetch or execute merely by rendering a proposal", () => {
    render(<NotebookRobustnessDialog {...props} />); expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a frozen plan", async () => {
    routes({ noPlan: true }); const user = userEvent.setup(); render(<NotebookRobustnessDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Stress-test finding" }));
    expect(await screen.findByText(/Freeze an analysis plan first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare robustness workflow" })).toBeDisabled();
  });
  it("requires exact-script, remote-upload and cost approvals plus a sufficient maximum", async () => {
    const user = await review();
    const submit = screen.getByRole("button", { name: "Approve and submit batch" }); expect(submit).toBeDisabled();
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/approve"))).toBe(false);
    await acknowledge(user);
    fireEvent.change(screen.getByLabelText("Approved maximum estimated USD"), { target: { value: "0.01" } }); expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Approved maximum estimated USD"), { target: { value: "0.1" } });
    await user.click(submit);
    await screen.findByText(/2\/2 comparable QC-pass outputs/);
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/approve"))!;
    expect(call[2]).toBe("project-a");
    expect(JSON.parse(String(call[1]?.body))).toEqual({ digest: preview.digest, approveRemote: true, reviewedScript: true, acknowledgeEstimates: true, acknowledgeUnverifiedPlanData: false, maxEstimatedUsd: 0.1 });
  });
  it("requires acknowledgment of unverified original plan identities", async () => {
    routes({ warnings: true }); const user = await review(); await acknowledge(user);
    expect(screen.getByRole("button", { name: "Approve and submit batch" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /some original plan dataset identities/ }));
    expect(screen.getByRole("button", { name: "Approve and submit batch" })).toBeEnabled();
  });
  it("cannot submit without configured Modal credentials", async () => {
    routes({ configured: false }); const user = await review(); await acknowledge(user);
    expect(screen.getByRole("button", { name: "Approve and submit batch" })).toBeDisabled();
  });
  it("requires a new review after stale-input rejection rather than replaying a changed command", async () => {
    const user = await review(); await acknowledge(user);
    fetch.mockResolvedValueOnce(json({ detail: "Input changed after preview" }, 409));
    await user.click(screen.getByRole("button", { name: "Approve and submit batch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Input changed");
    expect(screen.queryByRole("button", { name: "Approve and submit batch" })).not.toBeInTheDocument();
  });
  it("can cancel remaining jobs without retrying or erasing attempts", async () => {
    routes({ active: true }); const user = userEvent.setup(); render(<NotebookRobustnessDialog {...props} />);
    await user.click(screen.getByRole("button", { name: "Stress-test finding" }));
    await user.click(await screen.findByRole("button", { name: "Cancel remaining jobs" }));
    expect(await screen.findByText(/Cancellation requested/)).toBeInTheDocument();
    expect(screen.getAllByText("cancelled")).toHaveLength(2);
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/approve"))).toBe(false);
  });
});
describe("robustness result presentation", () => {
  it("keeps failed attempts visible but excludes them from the effect summary", () => {
    render(<RobustnessResults workflow={{ ...workflow, attempts: [workflow.attempts[0], { ...workflow.attempts[1], state: "failed" }] }} />);
    expect(screen.getByText("failed")).toBeInTheDocument(); expect(screen.getByText(/1\/2 comparable/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Specification estimates/ })).toBeInTheDocument();
    expect(screen.getByText(/not a significance vote/)).toBeInTheDocument();
  });
  it("never invents an estimate for missing/invalid/QC-failed outputs", () => {
    render(<RobustnessResults workflow={{ ...workflow, attempts: workflow.attempts.map((a) => ({ ...a, state: "failed", result: undefined, resultStatus: "missing" })) }} />);
    expect(screen.getAllByText("No estimate inferred")).toHaveLength(2);
    expect(screen.getByText(/0\/2 comparable/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
