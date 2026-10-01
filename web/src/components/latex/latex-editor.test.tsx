import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatexCompileResult } from "@/lib/use-sandbox";
import { LatexEditor } from "./latex-editor";
import { postLatexAssist, readSandboxFile } from "@/lib/latex/api";

vi.mock("@/lib/projects", () => ({ useProjectScopeId: () => "test" }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./latex-pdf-pane", () => ({ LatexPdfPane: () => <div>PDF preview</div> }));
vi.mock("@/lib/latex/api", () => ({
  readSandboxFile: vi.fn().mockResolvedValue(null),
  postLatexAssist: vi.fn(),
  fetchSynctexForward: vi.fn(),
  fetchSynctexInverse: vi.fn(),
  LatexAssistError: class extends Error {},
}));

const source = "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}";
const success: LatexCompileResult = { success: true, pdf_path: "main.pdf", errors: [], log: "Done", synctex: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup(overrides: Partial<Parameters<typeof LatexEditor>[0]> = {}) {
  const props = { path: "main.tex", name: "main.tex", initialContent: source, onSave: vi.fn().mockResolvedValue(true), onCompile: vi.fn().mockResolvedValue(success), onDiscard: vi.fn(), ...overrides };
  const result = render(<LatexEditor {...props} />);
  const view = EditorView.findFromDOM(result.container.querySelector(".cm-editor")!)!;
  const change = (text: string) => act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
  return { ...result, props, view, change };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("kady:latex:spellcheck", "0");
  // CodeMirror measures text positions; jsdom has no layout engine.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.mocked(readSandboxFile).mockResolvedValue(null);
});

describe("LatexEditor", () => {
  it("keeps edits typed during a save dirty and saves them on the next request", async () => {
    const pending = deferred<boolean>();
    const onSave = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const { change } = setup({ onSave });
    change(source + "\nFirst edit");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    change(source + "\nNewer edit");
    await act(async () => pending.resolve(true));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(source + "\nNewer edit"));
  });

  it("pins diagnostics and PDF freshness to the source at compilation start", async () => {
    const pending = deferred<LatexCompileResult>();
    const onCompile = vi.fn().mockReturnValue(pending.promise);
    const { change } = setup({ onCompile });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(onCompile).toHaveBeenCalled());
    change(source + "\nNewer edit");
    await act(async () => pending.resolve({ ...success, log: "./main.tex:3: Undefined control sequence." }));
    expect(screen.getByText("PDF out of date")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log" }));
    expect(screen.getByText(/Source changed since compilation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fix with AI" })).toBeNull();
  });

  it("requires a choice before overwriting concurrent disk edits", async () => {
    const { change, props, rerender } = setup();
    change(source + "\nMy edit");
    rerender(<LatexEditor {...props} initialContent={source + "\nAgent edit"} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Choose Load disk version or Keep mine before saving");
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(source + "\nMy edit"));
  });

  it.each(["before", "after"])("saves retained editor text when undo restores the old baseline %s Keep mine", async (undoWhen) => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onCompile = vi.fn().mockResolvedValue(success);
    const { change, props, rerender } = setup({ onSave, onCompile });
    change(source + "\nMy temporary edit");
    rerender(<LatexEditor {...props} initialContent={source + "\nAgent edit"} />);
    await screen.findByText("This file changed on disk while you were editing");
    if (undoWhen === "before") change(source);
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    if (undoWhen === "after") change(source);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(props.onCompile).toHaveBeenCalled());
    expect(props.onSave).toHaveBeenCalledWith(source);
    expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(onCompile.mock.invocationCallOrder[0]);
  });

  it("shows failed builds while retaining the last successful preview", async () => {
    const onCompile = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, success: false, pdf_path: null, errors: ["bibtex failed"], log: "", synctex: false });
    setup({ onCompile });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await screen.findByText("PDF ready");
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await screen.findByText("Last successful PDF");
    expect(screen.getByText("bibtex failed")).toBeInTheDocument();
    expect(screen.queryByText("PDF ready")).toBeNull();
  });

  it("preserves source across view changes and confirms closing unsaved edits", () => {
    const { change, view, props } = setup();
    change(source + "\nUnsaved");
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(view.state.doc.toString()).toBe(source + "\nUnsaved");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("adds the root preamble for chapter AI edits and requires review before saving", async () => {
    const chapter = "% !TEX root = ../main.tex\nHello world.";
    vi.mocked(readSandboxFile).mockResolvedValue(source);
    vi.mocked(postLatexAssist).mockResolvedValue({ status: "replacement", replacement: "Hello readers.", model: "test", costUsd: 0 });
    const { view } = setup({ path: "chapters/intro.tex", initialContent: chapter });
    act(() => view.dispatch({ selection: { anchor: chapter.indexOf("Hello"), head: chapter.length } }));
    fireEvent.click(screen.getByRole("button", { name: "Edit with AI" }));
    fireEvent.change(screen.getByPlaceholderText(/Edit selection/), { target: { value: "Improve wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByRole("button", { name: "Keep all" });
    expect(postLatexAssist).toHaveBeenCalledWith(expect.objectContaining({ preamble: "\\documentclass{article}", selection: "Hello world." }), expect.any(AbortSignal), "test");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit with AI" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("rejects AI output if source outside the selected range changed during the request", async () => {
    const pending = deferred<Awaited<ReturnType<typeof postLatexAssist>>>();
    vi.mocked(postLatexAssist).mockReturnValue(pending.promise);
    const { view } = setup();
    const from = source.indexOf("Hello");
    act(() => view.dispatch({ selection: { anchor: from, head: from + 5 } }));
    fireEvent.click(screen.getByRole("button", { name: "Edit with AI" }));
    fireEvent.change(screen.getByPlaceholderText(/Edit selection/), { target: { value: "Rewrite" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(postLatexAssist).toHaveBeenCalled());
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nChanged context" } }));
    await act(async () => pending.resolve({ status: "replacement", replacement: "Hi", model: "test", costUsd: 0 }));
    expect(screen.getByText(/Document changed during the AI request/)).toBeInTheDocument();
    expect(view.state.doc.toString()).toContain("Hello world.");
    expect(screen.queryByRole("button", { name: "Keep all" })).toBeNull();
  });
});
