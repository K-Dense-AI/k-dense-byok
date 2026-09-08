import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextExperimentsDialog } from "./next-experiments-dialog";
import { experimentSource as source, experimentView } from "@/test/next-experiments-fixture";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
const { apiFetch } = await import("@/lib/projects"); const fetch = vi.mocked(apiFetch);
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
const response = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as Response;
const entry = { id: source.entryId, type: "hypothesis" as const, title: "Treatment lowers marker X", timestamp: 1 };
function setup(changed = false) {
  const view = structuredClone(experimentView); if (changed) view.proposals[0].contextStatus = "changed";
  fetch.mockImplementation(async (_url, options) => options?.method === "POST" ? response({ saved: true }) : response(view));
  const onSaved = vi.fn(); const rendered = render(<NextExperimentsDialog entry={entry} sessionId={source.sessionId} projectId="project-a" model="openrouter/test/model" onSaved={onSaved} />);
  return { onSaved, rendered, view };
}
async function open() { const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "What next?" })); await user.click(await screen.findByText("Generate a source-linked proposal")); return user; }
beforeEach(() => vi.clearAllMocks());
describe("next-investigation planning review", () => {
  it("does not fetch or generate merely by rendering; opening is read-only", async () => {
    setup(); expect(fetch).not.toHaveBeenCalled(); await open(); expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.method).not.toBe("POST");
    expect(screen.getByRole("button", { name: "Generate proposals" })).toBeDisabled(); expect(screen.getAllByText(/Predicted outcome — not observed evidence/)).toHaveLength(2);
    expect(screen.getByText(/Why new data are necessary/)).toBeInTheDocument(); expect(screen.getAllByRole("link", { name: /Read source/ })[0].getAttribute("href")).toContain(`expectedDigest=${"a".repeat(64)}`); expect(screen.getByText(/Current decision constraints/)).toBeInTheDocument();
  });
  it("requires explicit model-call approval, sends the reviewed context and resets consent afterward", async () => {
    const { onSaved } = setup(); const user = await open();
    await user.click(screen.getByRole("checkbox", { name: /I approve one planning-model call/ })); await user.click(screen.getByRole("button", { name: "Generate proposals" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith("/generate"))!;
    expect(call[2]).toBe("project-a"); expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: "openrouter/test/model", approveModelCall: true, expectedContextDigest: experimentView.context.digest });
    expect(screen.getByRole("checkbox", { name: /I approve one planning-model call/ })).not.toBeChecked();
    expect(fetch.mock.calls.filter(([, o]) => o?.method === "POST").every(([u]) => String(u).endsWith("/generate"))).toBe(true);
  });
  it("resets consent when constraints or the selected model change", async () => {
    const { rendered } = setup(); const user = await open(); await user.click(screen.getByRole("checkbox", { name: /I approve one planning-model call/ }));
    fireEvent.change(screen.getByLabelText("Decision constraints"), { target: { value: "Avoid collecting new data" } }); expect(screen.getByRole("button", { name: "Generate proposals" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I approve one planning-model call/ }));
    rendered.rerender(<NextExperimentsDialog entry={entry} sessionId={source.sessionId} projectId="project-a" model="openrouter/other/model" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate proposals" })).toBeDisabled());
  });
  it("records a reasoned preference but never submits execution or reuses a source approval", async () => {
    setup(); const user = await open(); await user.click(screen.getAllByRole("button", { name: "Record planning preference" })[0]);
    expect(screen.getByRole("button", { name: "Save preference (no execution)" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Planning preference reason"), { target: { value: "Resolve overlap before recruitment" } }); await user.selectOptions(screen.getByLabelText("Planning preference"), "defer");
    await user.click(screen.getByRole("button", { name: "Save preference (no execution)" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/decision"))).toBe(true));
    const body = JSON.parse(String(fetch.mock.calls.find(([u]) => String(u).endsWith("/decision"))![1]?.body));
    expect(body).toMatchObject({ disposition: "defer", reason: "Resolve overlap before recruitment", candidateId: "adjust_batch", expectedProposalDigest: "b".repeat(64), expectedContextDigest: "c".repeat(64), proposal: { sessionId: "chat-a", entryId: "proposal-a" } });
    expect(body.execute).toBeUndefined(); expect(body.approveModelCall).toBeUndefined();
  });
  it("requires acknowledgement of changed/unverified context before a preference", async () => {
    setup(true); const user = await open(); expect(screen.getByText(/Source context is changed/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Record planning preference" })[0]); fireEvent.change(screen.getByLabelText("Planning preference reason"), { target: { value: "Recheck sources" } });
    expect(screen.getByRole("button", { name: "Save preference (no execution)" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the changed\/unverified source context/ })); expect(screen.getByRole("button", { name: "Save preference (no execution)" })).toBeEnabled();
  });
  it("preserves cost/error notices and checks uncertain request status without retrying generation", async () => {
    setup(); const user = await open(); fetch.mockImplementation(async (u, o) => o?.method === "POST" ? response({ detail: "Invalid proposal; no automatic retry", modelCallRecorded: true, costUsd: 0.003 }, false, 422) : String(u).includes("/requests/") ? response({ state: "failed" }) : response(experimentView));
    await user.click(screen.getByRole("checkbox", { name: /I approve one planning-model call/ })); await user.click(screen.getByRole("button", { name: "Generate proposals" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("model usage recorded: $0.003000");
    await user.click(screen.getByRole("button", { name: "Check request status (no retry)" })); await screen.findByText(/Checking status does not retry a model call/);
    expect(fetch.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
  });
  it("shows read failures with an explicit refresh and no generated fallback", async () => {
    setup(); fetch.mockResolvedValue(response({ detail: "Source is unavailable" }, false, 404)); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "What next?" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable"); expect(screen.queryByRole("button", { name: "Generate proposals" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh sources and proposals" })).toBeEnabled();
  });
  it("discards a late response from another project and validates returned scope", async () => {
    let finish!: (r: Response) => void; fetch.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const rendered = render(<NextExperimentsDialog entry={entry} sessionId={source.sessionId} projectId="project-a" />); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "What next?" }));
    const other = structuredClone(experimentView); other.context.projectId = "project-b"; other.proposals[0].plan.question = "OTHER PROJECT QUESTION";
    fetch.mockResolvedValue(response(other)); rendered.rerender(<NextExperimentsDialog entry={entry} sessionId={source.sessionId} projectId="project-b" />); await user.click(screen.getByRole("button", { name: "What next?" })); await screen.findAllByText(/OTHER PROJECT QUESTION/);
    finish(response(experimentView)); await waitFor(() => expect(screen.queryByText(experimentView.proposals[0].plan.question)).not.toBeInTheDocument());
  });
  it("does not treat preferences against an older proposal version as the latest current preference", async () => {
    const { view } = setup(); view.proposals[0].decisions = [{ id: "d", timestamp: 1000, choice: { proposal: { ...view.proposals[0].source, digest: "a".repeat(64) }, candidateId: "adjust_batch", disposition: "prioritize", reason: "Old assumptions", contextDigest: "d".repeat(64), proposalContextStatus: "current", requestDigest: "f".repeat(64) } }]; fetch.mockResolvedValue(response(view)); await open();
    expect(screen.queryByText(/Latest user preference/)).not.toBeInTheDocument(); expect(screen.getByText(/earlier proposal version/)).toBeInTheDocument();
  });
});
