import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommandBlockChip } from "./command-block-chip";

describe("CommandBlockChip", () => {
  it("shows the command as a chip, the body on demand, and the user's tail", () => {
    render(<CommandBlockChip block={{ kind: "template", name: "qc", body: "Run QC on a.csv.", tail: "and be quick" }} />);
    expect(screen.getByText("Prompt: /qc")).toBeInTheDocument();
    expect(screen.getByText("and be quick")).toBeInTheDocument();
    expect(screen.queryByText("Run QC on a.csv.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Prompt: \/qc/ }));
    expect(screen.getByText("Run QC on a.csv.")).toBeInTheDocument();
  });
  it("labels skills", () => {
    render(<CommandBlockChip block={{ kind: "skill", name: "lab-protocol", body: "steps", tail: "" }} />);
    expect(screen.getByText("Skill: lab-protocol")).toBeInTheDocument();
  });
});
