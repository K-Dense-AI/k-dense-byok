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
  it("opens on sandbox files and folders before device uploads", () => {
    setup({ availableFiles: ["results/counts.csv"], availableFolders: ["results"], onUploadFiles: vi.fn() });
    const picker = screen.getByRole("group", { name: "Project sandbox" });
    expect(within(picker).getByRole("checkbox", { name: "results/counts.csv" })).toBeVisible();
    expect(within(picker).getByRole("checkbox", { name: "results/" })).toBeVisible();
    expect(picker.compareDocumentPosition(screen.getByRole("button", { name: "Upload files from this device" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("launches with a sandbox folder reference without attaching every file", () => {
    const onUploadFiles = vi.fn();
    const onLaunch = setup({ availableFiles: ["study/counts.csv", "metadata.csv"], availableFolders: ["study"], onUploadFiles });
    fireEvent.click(screen.getByRole("checkbox", { name: "study/" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "metadata.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][0]).toContain('"study"');
    expect(onLaunch.mock.calls[0][0]).toContain("Selected project folders (paths relative to the project sandbox)");
    expect(onLaunch.mock.calls[0][2]).toEqual(["metadata.csv"]);
    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it("removes a folder selection without removing its separately selected file", () => {
    const onLaunch = setup({ availableFiles: ["study/counts.csv"], availableFolders: ["study"] });
    fireEvent.click(screen.getByRole("checkbox", { name: "study/" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "study/counts.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove study/ from workflow" }));
    expect(screen.getByRole("checkbox", { name: "study/" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "study/counts.csv" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][0]).not.toContain("Selected project folders");
    expect(onLaunch.mock.calls[0][2]).toEqual(["study/counts.csv"]);
  });

  it("launches with existing project files without an upload handler", () => {
    const onLaunch = setup({ availableFiles: ["study/counts.csv", "other/counts.csv"] });
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
    setup({ availableFiles: Array.from({ length: 38_000 }, (_, i) => `study-${i}/counts.csv`), availableFolders: ["study-37000", "empty"] });
    expect(screen.getAllByRole("checkbox")).toHaveLength(100);
    fireEvent.change(screen.getByRole("textbox", { name: "Search sandbox files and folders" }), { target: { value: "study-37000/" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "study-37000/counts.csv" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search sandbox files and folders" }), { target: { value: "empty" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "empty/" })).toBeVisible();
  });

  it.each([true, false])("keeps alternative sources available when the sandbox is empty or unavailable (ready=%s)", (filesReady) => {
    setup({ filesReady, onUploadFiles: vi.fn() });
    expect(screen.getByText(filesReady ? /No project files or folders yet/ : /Project file list is not available yet/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload files from this device" })).toBeEnabled();
    fireEvent.click(screen.getByText("Use a host path or data URL"));
    expect(screen.getByRole("textbox", { name: "Data locations (one per line)" })).toBeVisible();
  });

  it("refreshes sandbox choices without clearing selected files or folders", async () => {
    const onRefreshFiles = vi.fn().mockResolvedValue(undefined);
    const props = { workflow, open: true, onOpenChange: vi.fn(), onLaunch: vi.fn(), onRefreshFiles };
    const { rerender } = render(<WorkflowLaunchDialog {...props} availableFiles={["study/counts.csv"]} availableFolders={["study"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "study/" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "study/counts.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh sandbox files and folders" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh sandbox files and folders" })).toBeEnabled());
    expect(onRefreshFiles).toHaveBeenCalledOnce();
    rerender(<WorkflowLaunchDialog {...props} availableFiles={["study/counts.csv", "results/summary.csv"]} availableFolders={["study", "results"]} />);
    expect(screen.getByRole("checkbox", { name: "results/" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "results/summary.csv" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "study/" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "study/counts.csv" })).toBeChecked();
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
    render(<WorkflowsPanel onLaunch={onLaunch} availableFiles={["study.csv"]} availableFolders={["results"]} />);
    // Exercise the real picker without repeatedly computing accessible names
    // for the entire catalogue (particularly expensive in jsdom on CI).
    fireEvent.change(screen.getByPlaceholderText("Search workflows..."), { target: { value: "Edit / Rewrite Manuscript" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit \/ Rewrite Manuscript/ }));
    const firstDialog = within(screen.getByRole("dialog"));
    fireEvent.click(firstDialog.getByRole("checkbox", { name: "study.csv" }));
    fireEvent.click(firstDialog.getByRole("checkbox", { name: "results/" }));
    fireEvent.click(firstDialog.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByPlaceholderText("Search workflows..."), { target: { value: "Write a Rebuttal" } });
    fireEvent.click(screen.getByRole("button", { name: /^Write a Rebuttal/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Run workflow" }));
    expect(onLaunch.mock.calls[0][2]).toEqual([]);
    expect(onLaunch.mock.calls[0][0]).not.toContain("study.csv");
    expect(onLaunch.mock.calls[0][0]).not.toContain("Selected project folders");
  });
});
