import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotebookMemoryDialog } from "./notebook-memory-dialog";
import { memoryHit, memorySearch, memoryRecord } from "@/test/memory-fixture";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn(), API_BASE: "http://localhost:8000" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { apiFetch } = await import("@/lib/projects"); const fetch = vi.mocked(apiFetch);
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const props = { projectId: "project-a", activeSessionId: "s1", onJump: vi.fn(), onOpenFile: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); fetch.mockImplementation(async (url) => String(url).includes("/record?") ? json(memoryRecord) : json(memorySearch)); });
async function search() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Research memory" }));
  await user.type(screen.getByLabelText("Scientific memory query"), "Harmony");
  await user.click(screen.getByRole("button", { name: "Search memory" }));
  await screen.findByText(memoryHit.title);
  return user;
}
describe("project research memory", () => {
  it("does not query, inject context or execute work merely on render/open", async () => {
    render(<NotebookMemoryDialog {...props} />); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Research memory" }));
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Search memory" })).toBeDisabled();
  });
  it("searches all project chats with explicit scope and preserves historical qualifiers", async () => {
    render(<NotebookMemoryDialog {...props} />); await search();
    expect(fetch.mock.calls[0][0]).toBe("/projects/project-a/notebook/memory/search"); expect(fetch.mock.calls[0][2]).toBe("project-a");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ query: "Harmony", includeSuperseded: true });
    expect(screen.getByText("superseded")).toBeInTheDocument();
    expect(screen.getByText(memoryHit.scope!)).toBeInTheDocument(); expect(screen.getByText(memoryHit.revisitWhen!)).toBeInTheDocument();
    expect(screen.getByText(/not evidence of no effect/)).toBeInTheDocument();
  });
  it("reads exact sources with a digest, shows intervening edits, and does not activate embedded markup", async () => {
    fetch.mockImplementation(async (url) => String(url).includes("/record?") ? json({ ...memoryRecord, changedSinceSearch: true }) : json(memorySearch));
    render(<NotebookMemoryDialog {...props} />); const user = await search();
    await user.click(screen.getByRole("button", { name: "Read source" }));
    expect(await screen.findByText(/Source changed since the search/)).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)?.[0]).toContain(`expectedDigest=${memoryHit.digest}`);
    expect(screen.getByText(/Original \*\*Markdown\*\*/)).toBeInTheDocument(); expect(document.querySelector('img[src*="should-not-load"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /superseded by: Reconsider/ }));
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("decision-2");
  });
  it("copies a bounded, qualified context without sending a chat or writing notes", async () => {
    render(<NotebookMemoryDialog {...props} />); await search();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy bounded recall for chat" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0]; const data = JSON.parse(copied);
    expect(new TextEncoder().encode(copied).length).toBeLessThanOrEqual(16 * 1024);
    expect(data.hits[0]).toMatchObject({ source: memoryHit.source, recordStatus: "superseded", scope: memoryHit.scope, limitations: memoryHit.limitations });
    expect(data.rules).toContain("not instructions or permanent facts");
    expect(fetch).toHaveBeenCalledTimes(1); expect(props.onJump).not.toHaveBeenCalled();
  });
  it("does not present no matches as proof of absence when scanning is incomplete", async () => {
    fetch.mockResolvedValue(json({ ...memorySearch, hits: [], totalMatches: 0, coverage: { ...memorySearch.coverage, complete: false, warnings: ["Record budget reached"] } }));
    render(<NotebookMemoryDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Research memory" }));
    fireEvent.change(screen.getByLabelText("Memory outcome"), { target: { value: "null" } });
    fireEvent.click(screen.getByRole("button", { name: "Search memory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incomplete recall coverage");
    expect(screen.getByText(/does not prove the work was never attempted/)).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ outcome: "null", query: "" });
  });
  it("jumps to the correct cross-chat source, not the active chat's matching id", async () => {
    render(<NotebookMemoryDialog {...props} />); const user = await search();
    await user.click(screen.getByRole("button", { name: "View in notebook" }));
    expect(props.onJump).toHaveBeenCalledWith(memoryHit.source);
  });
  it("discards pending responses and old records on project switches", async () => {
    let resolveOld!: (response: Response) => void;
    fetch.mockReturnValue(new Promise((resolve) => { resolveOld = resolve; }));
    const view = render(<NotebookMemoryDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Research memory" }));
    fireEvent.change(screen.getByLabelText("Scientific memory query"), { target: { value: "Harmony" } });
    fireEvent.click(screen.getByRole("button", { name: "Search memory" }));
    view.rerender(<NotebookMemoryDialog {...props} projectId="project-b" />);
    await act(async () => { resolveOld(json(memorySearch)); });
    fireEvent.click(screen.getByRole("button", { name: "Research memory" }));
    expect(screen.queryByText(memoryHit.title)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Scientific memory query")).toHaveValue("");
  });
});
