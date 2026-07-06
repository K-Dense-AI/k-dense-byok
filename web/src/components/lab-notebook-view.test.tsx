import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LabNotebookView } from "./lab-notebook-view";
import type { NotebookEntry } from "@/lib/notebook";

vi.mock("@/lib/projects", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })),
  API_BASE: "http://x",
  getActiveProjectId: () => "default",
}));

const e = (over: Partial<NotebookEntry>): NotebookEntry =>
  ({ id: "tc_1", type: "hypothesis", title: "Six cell types", timestamp: 1, ...over });

describe("LabNotebookView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the empty state with no entries", () => {
    render(<LabNotebookView sessionId="s1" liveEntries={[]} streaming={false} onOpenFile={() => {}} />);
    expect(screen.getByText(/entries appear here/i)).toBeInTheDocument();
  });

  it("renders live entries with the right type", () => {
    render(<LabNotebookView sessionId="s1" liveEntries={[e({})]} streaming onOpenFile={() => {}} />);
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
    expect(screen.getByTestId("nb-entry-tc_1").getAttribute("data-nb-type")).toBe("hypothesis");
  });

  it("fires onOpenFile when an artifact chip is clicked", () => {
    const onOpenFile = vi.fn();
    render(
      <LabNotebookView
        sessionId="s1"
        liveEntries={[e({ artifacts: ["figures/fig08.png"] })]}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByTitle("figures/fig08.png"));
    expect(onOpenFile).toHaveBeenCalledWith("figures/fig08.png");
  });

  it("merges fetched entries from the backend on mount", async () => {
    const { apiFetch } = await import("@/lib/projects");
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [e({ id: "tc_persisted", title: "From disk" })] }),
    });
    render(<LabNotebookView sessionId="s1" liveEntries={[]} streaming={false} onOpenFile={() => {}} />);
    await waitFor(() => expect(screen.getByText("From disk")).toBeInTheDocument());
  });

  it("renders an entry body through the markdown renderer without throwing", () => {
    render(
      <LabNotebookView
        sessionId="s1"
        liveEntries={[e({ id: "tc_body", body: "Some **markdown** body with `code`." })]}
        streaming={false}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByText(/Some/)).toBeInTheDocument();
  });

  it("offers 'open as file' for code entries with a script artifact", () => {
    const onOpenFile = vi.fn();
    render(
      <LabNotebookView sessionId="s1" streaming={false} onOpenFile={onOpenFile}
        liveEntries={[{ id: "m1", type: "method", title: "Ran pipeline", timestamp: 1,
          code: { source: "print(1)", lang: "python" }, artifacts: ["scripts/02_pipeline.py"] }]} />,
    );
    fireEvent.click(screen.getByText(/open as file/i));
    expect(onOpenFile).toHaveBeenCalledWith("scripts/02_pipeline.py");
  });

  it("renders no chips and does not crash when artifacts is an empty array", () => {
    render(
      <LabNotebookView
        sessionId="s1"
        liveEntries={[e({ id: "tc_empty_artifacts", artifacts: [] })]}
        streaming={false}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByTestId("nb-entry-tc_empty_artifacts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\.(png|jpg|csv|py)$/i })).not.toBeInTheDocument();
  });
});
