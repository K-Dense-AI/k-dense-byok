import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OfficeWorkspace } from "./office-workspace";
let fetcher: ReturnType<typeof vi.fn>;
const revision = "a".repeat(64);
const documentResponse = () => new Response(new Uint8Array([80, 75]), { headers: { "X-Content-SHA256": revision } });
beforeEach(() => { fetcher = vi.fn(async () => documentResponse()); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function message(cmd: string, data = {}, origin = window.location.origin, source = (screen.getByTitle("Office editing workspace") as HTMLIFrameElement).contentWindow) {
  fireEvent(window, new MessageEvent("message", { origin, source, data: { source: "kady-office", cmd, ...data } }));
}
async function open() {
  render(<OfficeWorkspace path="folder/report.docx" projectId="office-project" />);
  const send = vi.spyOn((screen.getByTitle("Office editing workspace") as HTMLIFrameElement).contentWindow!, "postMessage");
  message("ready"); await waitFor(() => expect(send).toHaveBeenCalled()); message("opened"); return send;
}
it("loads scoped bytes, rejects unrelated window messages, and saves with the original revision", async () => {
  const send = await open();
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Project-Id")).toBe("office-project");
  message("modified", {}, "https://untrusted.example"); expect(screen.getByRole("status")).toHaveTextContent("Ready");
  message("modified", {}, window.location.origin, window); expect(screen.getByRole("status")).toHaveTextContent("Ready");
  message("modified"); fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  const job = send.mock.calls.at(-1)![0]; expect(job.cmd).toBe("export");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ revision: "b".repeat(64) })));
  const bytes = new ArrayBuffer(10); message("exported", { id: job.id, bytes });
  await screen.findByText("Saved to project");
  const init = fetcher.mock.calls.at(-1)![1]; expect(init.method).toBe("PUT"); expect(new Headers(init.headers).get("If-Match")).toBe(revision); expect(init.body).toBe(bytes);
});
it("retains newer changes made during export and warns before leaving", async () => {
  const send = await open(); message("modified"); fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  const job = send.mock.calls.at(-1)![0]; message("modified");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ revision: "b".repeat(64) })));
  message("exported", { id: job.id, bytes: new ArrayBuffer(10) }); await screen.findByText("Newer changes are not saved yet");
  const leave = new Event("beforeunload", { cancelable: true }); fireEvent(window, leave); expect(leave.defaultPrevented).toBe(true);
});
it("preserves the editor on conflicts and offers an export copy", async () => {
  const send = await open(); message("modified"); fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "File changed outside this editor" }), { status: 409 }));
  message("exported", { id: send.mock.calls.at(-1)![0].id, bytes: new ArrayBuffer(10) });
  expect(await screen.findByRole("alert")).toHaveTextContent("File changed"); expect(screen.getByRole("button", { name: "Download copy" })).toBeEnabled();
  vi.spyOn(window, "confirm").mockReturnValue(false); fireEvent.click(screen.getByTitle("Reload project file")); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not export before the engine has opened a document or overwrite read-only files", async () => {
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([80, 75]), { headers: { "X-Content-SHA256": revision, "X-Office-Read-Only": "true" } }));
  render(<OfficeWorkspace path="report.docx" projectId="office-project" />);
  fireEvent.keyDown(window, { key: "s", ctrlKey: true }); expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  await act(async () => { message("ready"); }); message("opened");
  expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled(); expect(screen.getByRole("button", { name: "Download copy" })).toBeEnabled();
});
it("connects the Kady formatting controls to the existing document without remounting it", async () => {
  const send = await open(); const frame = screen.getByTitle("Office editing workspace");
  message("command-state", { command: ".uno:Bold", enabled: true, value: true });
  expect(screen.getByRole("button", { name: /^Bold$/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /^Bold$/ }));
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ cmd: "command", command: ".uno:Bold" });
  fireEvent.change(screen.getByRole("combobox", { name: "Font size" }), { target: { value: "14" } });
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ cmd: "command", command: ".uno:FontHeight", args: { "FontHeight.Height": 14 } });
  fireEvent.click(screen.getByRole("button", { name: "All tools" }));
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ cmd: "chrome", advanced: true });
  expect(screen.getByTitle("Office editing workspace")).toBe(frame);
});
it("commits the Kady formula bar before a keyboard save and preserves edits made after export starts", async () => {
  render(<OfficeWorkspace path="workbook.xlsx" projectId="office-project" />);
  const send = vi.spyOn((screen.getByTitle("Office editing workspace") as HTMLIFrameElement).contentWindow!, "postMessage");
  message("ready"); await waitFor(() => expect(send).toHaveBeenCalled()); message("opened");
  message("selection", { cell: "B2", formula: "12" });
  fireEvent.change(screen.getByRole("textbox", { name: "Cell value or formula" }), { target: { value: "=SUM(A1:A3)" } });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  const calls = send.mock.calls.map(c => c[0]);
  expect(calls.at(-2)).toMatchObject({ cmd: "command", command: ".uno:EnterString", args: { StringName: "=SUM(A1:A3)" } });
  const job = calls.at(-1); expect(job.cmd).toBe("export");
  message("modified"); message("export-started", { id: job.id }); message("modified");
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ revision: "b".repeat(64) })));
  message("exported", { id: job.id, bytes: new ArrayBuffer(10) });
  await screen.findByText("Newer changes are not saved yet");
});

it("commits a formula draft before toolbar formatting can refresh the selected cell", async () => {
  render(<OfficeWorkspace path="workbook.xlsx" projectId="office-project" />);
  const send = vi.spyOn((screen.getByTitle("Office editing workspace") as HTMLIFrameElement).contentWindow!, "postMessage");
  message("ready"); await waitFor(() => expect(send).toHaveBeenCalled()); message("opened");
  message("selection", { cell: "B2", formula: "12" });
  const formula = screen.getByRole("textbox", { name: "Cell value or formula" });
  fireEvent.change(formula, { target: { value: "=SUM(A1:A3)" } });
  send.mockClear();
  // Toolbar mousedown deliberately retains the current editing focus, so
  // clicking Bold does not trigger the formula field's onBlur commit.
  fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }));
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(send.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ cmd: "command", command: ".uno:EnterString", args: { StringName: "=SUM(A1:A3)" } }),
    expect.objectContaining({ cmd: "command", command: ".uno:Bold" }),
  ]);
  // Both commands refresh the selection; their model value must now include
  // the draft instead of restoring the cell's previous value of 12.
  message("selection", { cell: "B2", formula: "=SUM(A1:A3)" });
  expect(formula).toHaveValue("=SUM(A1:A3)");
});
