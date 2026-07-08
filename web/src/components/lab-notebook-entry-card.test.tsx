import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LabNotebookEntryCard } from "./lab-notebook-entry-card";
import type { NotebookEntry } from "@/lib/notebook";
import type { NotebookAnnotation } from "@/lib/notebook-annotations";

const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id: "tc_1",
  type: "hypothesis",
  title: "Six cell types",
  timestamp: 1000,
  ...over,
});

// ConfidenceMeter renders a Radix Tooltip, which needs the app's provider.
const renderCard = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe("LabNotebookEntryCard", () => {
  it("renders with only the minimal props (backward compat)", () => {
    renderCard(<LabNotebookEntryCard entry={entry()} onOpenFile={() => {}} />);
    expect(screen.getByTestId("nb-entry-tc_1")).toBeInTheDocument();
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
    expect(screen.getByText("Hypothesis")).toBeInTheDocument();
  });

  it("renders tags as buttons that fire onTagClick", () => {
    const onTagClick = vi.fn();
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ tags: ["scRNA", "qc"] })}
        onOpenFile={() => {}}
        onTagClick={onTagClick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "#scRNA" }));
    expect(onTagClick).toHaveBeenCalledWith("scRNA");
  });

  it("renders the confidence meter with an accessible label", () => {
    renderCard(
      <LabNotebookEntryCard entry={entry({ confidence: "high" })} onOpenFile={() => {}} />,
    );
    expect(screen.getByLabelText("Confidence: high")).toBeInTheDocument();
  });

  it("reveals the code behind the lang toggle", async () => {
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ code: { source: "alpha_beta_gamma = 42", lang: "python" } })}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByTestId("nb-entry-tc_1").textContent).not.toContain("alpha_beta_gamma");
    fireEvent.click(screen.getByRole("button", { name: "python" }));
    await waitFor(() =>
      expect(screen.getByTestId("nb-entry-tc_1").textContent).toContain("alpha_beta_gamma"),
    );
  });

  it("offers 'Open as file' for code entries with a script artifact", () => {
    const onOpenFile = vi.fn();
    renderCard(
      <LabNotebookEntryCard
        entry={entry({
          type: "method",
          code: { source: "print(1)", lang: "python" },
          artifacts: ["scripts/02_pipeline.py"],
        })}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByText(/open as file/i));
    expect(onOpenFile).toHaveBeenCalledWith("scripts/02_pipeline.py");
  });

  it("shows the relatesTo stance line and jumps to the related entry", () => {
    const onJumpToEntry = vi.fn();
    const related = entry({ id: "tc_h", title: "Original idea" });
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ id: "tc_2", type: "observation", relatesTo: "tc_h", stance: "supports" })}
        onOpenFile={() => {}}
        relatedEntry={related}
        onJumpToEntry={onJumpToEntry}
      />,
    );
    const link = screen.getByRole("button", { name: /supports\s+Original idea/i });
    fireEvent.click(link);
    expect(onJumpToEntry).toHaveBeenCalledWith("tc_h");
  });

  it("labels a refuting link 'refutes' and a stanceless link 're:'", () => {
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ id: "a", type: "observation", relatesTo: "x", stance: "refutes" })}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByText(/refutes/)).toBeInTheDocument();
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ id: "b", type: "observation", relatesTo: "y" })}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByText(/re:/)).toBeInTheDocument();
  });

  it("shows the thread status badge on a hypothesis", () => {
    renderCard(
      <LabNotebookEntryCard
        entry={entry()}
        onOpenFile={() => {}}
        thread={{ status: "refuted" }}
      />,
    );
    expect(screen.getByText("refuted")).toBeInTheDocument();
  });

  it("dims a superseded card and links to its successor", () => {
    const onJumpToEntry = vi.fn();
    renderCard(
      <LabNotebookEntryCard
        entry={entry()}
        onOpenFile={() => {}}
        thread={{ supersededBy: "x" }}
        onJumpToEntry={onJumpToEntry}
      />,
    );
    const card = screen.getByTestId("nb-entry-tc_1").firstElementChild as HTMLElement;
    expect(card.className).toContain("opacity-60");
    fireEvent.click(screen.getByRole("button", { name: /superseded by/i }));
    expect(onJumpToEntry).toHaveBeenCalledWith("x");
  });

  it("toggles the pin via the pin button", () => {
    const onTogglePin = vi.fn();
    const { unmount } = renderCard(
      <LabNotebookEntryCard entry={entry()} onOpenFile={() => {}} onTogglePin={onTogglePin} />,
    );
    fireEvent.click(screen.getByLabelText("Pin entry"));
    expect(onTogglePin).toHaveBeenCalledWith("tc_1");
    unmount();

    renderCard(
      <LabNotebookEntryCard
        entry={entry()}
        onOpenFile={() => {}}
        pinned
        onTogglePin={onTogglePin}
      />,
    );
    fireEvent.click(screen.getByLabelText("Unpin entry"));
    expect(onTogglePin).toHaveBeenCalledTimes(2);
  });

  it("shows existing comments and submits a new one on Enter", () => {
    const onAddComment = vi.fn();
    const comments: NotebookAnnotation[] = [
      { id: "c1", kind: "comment", entryId: "tc_1", body: "check the controls", createdAt: 5 },
    ];
    renderCard(
      <LabNotebookEntryCard
        entry={entry()}
        onOpenFile={() => {}}
        comments={comments}
        onAddComment={onAddComment}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1 comment/i }));
    expect(screen.getByText("check the controls")).toBeInTheDocument();

    const input = screen.getByLabelText("Add a comment");
    fireEvent.change(input, { target: { value: "needs a replicate" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddComment).toHaveBeenCalledWith("tc_1", "needs a replicate");
    expect((input as HTMLInputElement).value).toBe(""); // draft cleared
  });

  it("fires onJumpToChat from the 'View in chat' button", () => {
    const onJumpToChat = vi.fn();
    renderCard(
      <LabNotebookEntryCard entry={entry()} onOpenFile={() => {}} onJumpToChat={onJumpToChat} />,
    );
    fireEvent.click(screen.getByLabelText("View in chat"));
    expect(onJumpToChat).toHaveBeenCalledWith("tc_1");
  });

  it("renders image artifacts inline via the raw endpoint", () => {
    const onOpenFile = vi.fn();
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ artifacts: ["figures/fig08.png"] })}
        onOpenFile={onOpenFile}
      />,
    );
    const img = screen.getByRole("img", { name: "fig08.png" });
    expect(img.getAttribute("src")).toContain("/sandbox/raw");
    fireEvent.click(screen.getByTitle("figures/fig08.png"));
    expect(onOpenFile).toHaveBeenCalledWith("figures/fig08.png");
  });

  it("renders non-image artifacts as chips that open the file", () => {
    const onOpenFile = vi.fn();
    renderCard(
      <LabNotebookEntryCard
        entry={entry({ artifacts: ["data/results.csv"] })}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /results\.csv/ }));
    expect(onOpenFile).toHaveBeenCalledWith("data/results.csv");
  });

  it("shows the agent badge in chronological view", () => {
    renderCard(
      <LabNotebookEntryCard entry={entry({ role: "agent" })} onOpenFile={() => {}} agentBadge="agent" />,
    );
    expect(screen.getByText("Kady (lead)")).toBeInTheDocument();
  });
});
