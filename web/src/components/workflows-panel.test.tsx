import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowLaunchDialog, WorkflowsPanel, type Workflow } from "./workflows-panel";
import type { WorkflowInputProps } from "./workflow-inputs";

const modelState = vi.hoisted(() => ({ availability: "available", billable: true }));
vi.mock("@/components/model-selector", () => ({
  DEFAULT_MODEL: { id: "test/model", name: "Test model" },
  ModelSelector: () => <div>Model picker</div>,
  modelUsesBillableBudget: () => modelState.billable,
}));
vi.mock("@/lib/use-models", () => ({ useModels: () => ({ modelAvailability: () => modelState.availability, models: [] }) }));
vi.mock("@/lib/app-settings", () => ({ useAppDefaults: () => null }));

const workflow: Workflow = {
  id: "analysis", name: "Analyze supplied data", description: "Analyze a study",
  category: "data", icon: "Database", requiresFiles: true,
  prompt: "Analyze the supplied study for {question}.",
  placeholders: [{ key: "question", label: "Research question", required: true }],
};

function setup(props: WorkflowInputProps & { workflow?: Workflow; budgetBlocked?: boolean } = {}) {
  const onLaunch = vi.fn();
  render(<WorkflowLaunchDialog workflow={workflow} open onOpenChange={vi.fn()} onLaunch={onLaunch} {...props} />);
  if (screen.queryByPlaceholderText("Research question")) fireEvent.change(screen.getByPlaceholderText("Research question"), { target: { value: "treatment response" } });
  return onLaunch;
}

beforeEach(() => { modelState.availability = "available"; modelState.billable = true; });

describe("workflow data sources", () => {
  it("launches with existing project files without an upload handler", () => {
    const onLaunch = setup({ availableFiles: ["study/counts.csv", "other/counts.csv"] });
    fireEvent.click(screen.getByText("Choose existing project files"));
    fireEvent.click(screen.getByRole("checkbox", { name: "study/counts.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch).toHaveBeenCalledWith(expect.stringContaining('"study/counts.csv"'), expect.objectContaining({ id: "test/model" }), ["study/counts.csv"]);
    expect(onLaunch.mock.calls[0][0]).not.toContain('"other/counts.csv"');
    expect(onLaunch.mock.calls[0][0]).toContain("Analyze the supplied study for treatment response.");
  });

  it("launches with host, Windows, mounted folder and storage references as prompt data, not attachments", () => {
    const onLaunch = setup();
    fireEvent.click(screen.getByText("Use a host path or data URL"));
    const locations = ['/mnt/study/counts.csv', 'C:\\study data\\counts.csv', 'user_data/study/', 's3://bucket/study/', 'gs://bucket/study/', 'https://example.org/data.csv'];
    fireEvent.change(screen.getByLabelText("Data locations (one per line)"), { target: { value: locations.join("\n") } });
    // Source selection survives editing the task prompt.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editors = screen.getAllByRole("textbox");
    fireEvent.change(editors[editors.length - 1], { target: { value: "Analyze the selected study." } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    const [prompt, , attachments] = onLaunch.mock.calls[0];
    for (const location of locations) expect(prompt).toContain(JSON.stringify(location));
    expect(prompt).toContain("Analyze the selected study.");
    expect(prompt).toContain("verify that the needed files are readable");
    expect(attachments).toEqual([]);
  });

  it("preserves device folder uploads and blocks launching until they finish", async () => {
    let finish!: (paths: string[]) => void;
    const onUploadFiles = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    const onLaunch = setup({ onUploadFiles, availableFiles: ["metadata.csv"] });
    fireEvent.click(screen.getByText("Choose existing project files"));
    fireEvent.click(screen.getByRole("checkbox", { name: "metadata.csv" }));
    const file = new File(["x,y\n1,2"], "counts.csv", { type: "text/csv" });
    Object.defineProperty(file, "webkitRelativePath", { value: "study/counts.csv" });
    const input = screen.getByLabelText("Upload workflow folder");
    expect(input).toHaveAttribute("webkitdirectory");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUploadFiles).toHaveBeenCalledWith([file]);
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch).not.toHaveBeenCalled();
    await act(async () => finish(["user_data/study/counts (1).csv"]));
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual(["metadata.csv", "user_data/study/counts (1).csv"]);
    expect(onLaunch.mock.calls[0][0]).toContain('"user_data/study/counts (1).csv"');
    expect(input).toHaveValue("");
  });

  it.each(["empty", "rejected"])("shows %s upload failures without claiming an attachment", async (kind) => {
    const onUploadFiles = kind === "empty" ? vi.fn().mockResolvedValue([]) : vi.fn().mockRejectedValue(new Error("Server unavailable"));
    const onLaunch = setup({ onUploadFiles });
    fireEvent.change(screen.getByLabelText("Upload workflow files"), { target: { files: [new File(["x"], "counts.csv")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(kind === "empty" ? "not uploaded" : "Server unavailable");
    await waitFor(() => expect(screen.getByRole("button", { name: "Run workflow" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual([]);
  });

  it("deduplicates selections and lets users remove files without deleting them", async () => {
    const onUploadFiles = vi.fn().mockResolvedValue(["counts.csv"]);
    const onLaunch = setup({ availableFiles: ["counts.csv"], onUploadFiles });
    fireEvent.click(screen.getByText("Choose existing project files"));
    fireEvent.click(screen.getByRole("checkbox", { name: "counts.csv" }));
    fireEvent.change(screen.getByLabelText("Upload workflow files"), { target: { files: [new File(["x"], "counts.csv")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run workflow" })).toBeEnabled());
    expect(screen.getAllByRole("button", { name: "Remove counts.csv from workflow" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove counts.csv from workflow" }));
    expect(screen.getByRole("checkbox", { name: "counts.csv" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual([]);
  });

  it("bounds the project picker and searches full paths in a large tree", () => {
    setup({ availableFiles: Array.from({ length: 38_000 }, (_, i) => `study-${i}/counts.csv`) });
    fireEvent.click(screen.getByText("Choose existing project files"));
    expect(screen.getAllByRole("checkbox")).toHaveLength(100);
    fireEvent.change(screen.getByRole("textbox", { name: "Search project files" }), { target: { value: "study-37000/" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "study-37000/counts.csv" })).toBeInTheDocument();
  });

  it("still supports tasks with no files and retains required-field checks", () => {
    const onLaunch = setup({ workflow: { ...workflow, requiresFiles: false } });
    fireEvent.change(screen.getByPlaceholderText("Research question"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Research question"), { target: { value: "literature" } });
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual([]);
  });

  it.each(["checking", "unavailable", "budget"])("blocks a launch with %s model access", (reason) => {
    if (reason !== "budget") modelState.availability = reason;
    setup({ budgetBlocked: reason === "budget" });
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
  });

  it("clears data selections when switching workflows", () => {
    const onLaunch = vi.fn();
    render(<WorkflowsPanel onLaunch={onLaunch} availableFiles={["study.csv"]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Edit \/ Rewrite Manuscript/ }));
    fireEvent.click(screen.getByText("Choose existing project files"));
    fireEvent.click(screen.getByRole("checkbox", { name: "study.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /^Write a Rebuttal/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual([]);
    expect(onLaunch.mock.calls[0][0]).not.toContain("study.csv");
  });
});
