import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NotebookResultLinks } from "./notebook-result-links";
vi.mock("@/lib/projects", async (original) => ({ ...await original<typeof import("@/lib/projects")>(), apiFetch: vi.fn() }));
const { apiFetch } = await import("@/lib/projects");
const fetch = vi.mocked(apiFetch);
const reference = { sessionId: "source", toolCallId: "result-1", status: "available", sha256: "abc" };
const card = { schemaVersion: 1, kind: "table", title: "Saved measurements", columns: [{ key: "n", label: "Sample count" }], rows: [[100]] };
const props = { entry: { id: "o1", type: "observation" as const, title: "Finding", timestamp: 1, results: [{ toolCallId: "result-1", sessionId: "source" }] }, sessionId: "owner", projectId: "project-a", onOpenFile: vi.fn() };
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
beforeEach(() => { vi.clearAllMocks(); });

describe("saved scientific-result links", () => {
  it("loads canonical values lazily using the owning notebook's scoped reference", async () => {
    fetch.mockResolvedValue(response({ reference, status: "available", card, reason: "Matches the cited persisted result." }));
    render(<NotebookResultLinks {...props} />); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View saved result 1" }));
    expect(await screen.findByText("Saved measurements")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toBe("/sessions/owner/notebook/o1/results/0");
    expect(fetch.mock.calls[0][2]).toBe("project-a");
    expect(screen.getByText(/not independently verified/)).toBeInTheDocument();
  });
  it("does not render replacement measurements when the saved identity changed", async () => {
    fetch.mockResolvedValue(response({ reference, status: "changed", reason: "Saved result no longer matches its citation." }));
    render(<NotebookResultLinks {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View saved result 1" }));
    expect(await screen.findByText(/no longer matches/)).toBeInTheDocument();
    expect(screen.queryByText("Saved measurements")).not.toBeInTheDocument();
  });
  it("labels currently saved but unpinned results as unverified", async () => {
    fetch.mockResolvedValue(response({ reference: { ...reference, sha256: undefined }, status: "unverified", card, reason: "Citation-time identity was not pinned." }));
    render(<NotebookResultLinks {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View saved result 1" }));
    expect(await screen.findByText(/unverified: Citation-time/)).toBeInTheDocument();
    expect(screen.getByText("Saved measurements")).toBeInTheDocument();
  });
  it("exposes invalid result payloads as errors rather than crashing the notebook", async () => {
    fetch.mockResolvedValue(response({ reference, status: "available", card: { ...card, kind: "unknown" } }));
    render(<NotebookResultLinks {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View saved result 1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be validated");
  });
});
