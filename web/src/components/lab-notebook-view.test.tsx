import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabNotebookView } from "./lab-notebook-view";
import type { NotebookEntry } from "@/lib/notebook";

vi.mock("@/lib/projects", () => ({
  apiFetch: vi.fn(),
  API_BASE: "http://x",
  getActiveProjectId: () => "default",
  onProjectChange: () => () => {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { apiFetch } = await import("@/lib/projects");
const { toast } = await import("sonner");
const spy = apiFetch as unknown as ReturnType<typeof vi.fn>;

// Radix menus/popovers reach for pointer-capture APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

/** Minimal Response-shaped payloads for the URL-routed apiFetch mock. */
function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => data,
    blob: async () => new Blob(["stub"], { type: "text/markdown" }),
  };
}
function errJson(status: number, data: unknown = {}) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => data,
    blob: async () => new Blob([]),
  };
}

/**
 * Route apiFetch by URL. The view fires several parallel fetches on mount
 * (session notebook + annotations, and project notebook + sessions in project
 * scope), so order-based mockResolvedValueOnce staging would be brittle.
 */
function routeFetch(custom?: (url: string, init?: RequestInit) => unknown) {
  spy.mockImplementation((url: string, init?: RequestInit) => {
    const c = custom?.(url, init);
    if (c !== undefined) return Promise.resolve(c);
    if (url.includes("/notebook/annotations")) {
      return Promise.resolve(okJson({ version: 1, annotations: [] }));
    }
    if (url.endsWith("/notebook")) return Promise.resolve(okJson({ entries: [] }));
    if (url === "/sessions") return Promise.resolve(okJson([]));
    return Promise.resolve(okJson({}));
  });
}

/** Calls that hit a per-session or project notebook (NOT annotations/export). */
const notebookCalls = () =>
  spy.mock.calls.filter(([u]) => typeof u === "string" && (u as string).endsWith("/notebook"));

const e = (over: Partial<NotebookEntry>): NotebookEntry =>
  ({ id: "tc_1", type: "hypothesis", title: "Six cell types", timestamp: 1, ...over });

const baseProps = {
  sessionId: "s1",
  liveEntries: [] as NotebookEntry[],
  streaming: false,
  subagentCompletions: 0,
  onOpenFile: () => {},
};

describe("LabNotebookView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeFetch();
    try {
      localStorage.clear(); // view-mode persistence must not leak across tests
    } catch {
      /* jsdom localStorage can be unavailable */
    }
  });

  it("shows the empty state with no entries", () => {
    render(<LabNotebookView {...baseProps} />);
    expect(screen.getByText(/entries appear here/i)).toBeInTheDocument();
  });

  it("renders live entries with the right type", () => {
    render(<LabNotebookView {...baseProps} liveEntries={[e({})]} streaming />);
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
    expect(screen.getByTestId("nb-entry-tc_1").getAttribute("data-nb-type")).toBe("hypothesis");
  });

  it("fires onOpenFile when an artifact chip is clicked", () => {
    const onOpenFile = vi.fn();
    render(
      <LabNotebookView
        {...baseProps}
        liveEntries={[e({ artifacts: ["figures/fig08.png"] })]}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByTitle("figures/fig08.png"));
    expect(onOpenFile).toHaveBeenCalledWith("figures/fig08.png");
  });

  it("merges fetched entries from the backend on mount", async () => {
    routeFetch((url) => {
      if (url === "/sessions/s1/notebook") {
        return okJson({ entries: [e({ id: "tc_persisted", title: "From disk" })] });
      }
    });
    render(<LabNotebookView {...baseProps} />);
    await waitFor(() => expect(screen.getByText("From disk")).toBeInTheDocument());
  });

  it("renders an entry body through the markdown renderer without throwing", () => {
    render(
      <LabNotebookView
        {...baseProps}
        liveEntries={[e({ id: "tc_body", body: "Some **markdown** body with `code`." })]}
      />,
    );
    expect(screen.getByText(/Some/)).toBeInTheDocument();
  });

  it("offers 'open as file' for code entries with a script artifact", () => {
    const onOpenFile = vi.fn();
    render(
      <LabNotebookView {...baseProps} onOpenFile={onOpenFile}
        liveEntries={[{ id: "m1", type: "method", title: "Ran pipeline", timestamp: 1,
          code: { source: "print(1)", lang: "python" }, artifacts: ["scripts/02_pipeline.py"] }]} />,
    );
    fireEvent.click(screen.getByText(/open as file/i));
    expect(onOpenFile).toHaveBeenCalledWith("scripts/02_pipeline.py");
  });

  it("renders no chips and does not crash when artifacts is an empty array", () => {
    render(
      <LabNotebookView {...baseProps} liveEntries={[e({ id: "tc_empty_artifacts", artifacts: [] })]} />,
    );
    expect(screen.getByTestId("nb-entry-tc_empty_artifacts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\.(png|jpg|csv|py)$/i })).not.toBeInTheDocument();
  });

  it("exports to PDF via a print-styled window when entries are present", () => {
    const fakeWin = {
      document: { write: vi.fn(), close: vi.fn(), readyState: "complete" },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
    render(<LabNotebookView {...baseProps} liveEntries={[e({ artifacts: ["figures/fig08.png"] })]} />);
    fireEvent.click(screen.getByRole("button", { name: /pdf/i }));
    expect(openSpy).toHaveBeenCalled();
    expect(fakeWin.document.write).toHaveBeenCalled();
    expect(String(fakeWin.document.write.mock.calls[0][0])).toContain("Six cell types");
    expect(fakeWin.document.close).toHaveBeenCalled();
    // readyState "complete" → print fires synchronously, no load listener.
    expect(fakeWin.focus).toHaveBeenCalled();
    expect(fakeWin.print).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("toasts (and does not throw) when window.open is blocked", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<LabNotebookView {...baseProps} liveEntries={[e({})]} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: /pdf/i }))).not.toThrow();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/pop-?up/i));
    openSpy.mockRestore();
  });

  it("does not render a PDF button when there are no entries", () => {
    render(<LabNotebookView {...baseProps} />);
    expect(screen.queryByRole("button", { name: /pdf/i })).not.toBeInTheDocument();
  });

  it("groups entries into lanes by role (lead first, then subagents)", () => {
    const entries: NotebookEntry[] = [
      { id: "l1", role: "agent", type: "hypothesis", title: "Lead idea", timestamp: 1 },
      { id: "scout:c1", role: "literature-scout", type: "method", title: "Searched refs", timestamp: 2 },
      { id: "stats:c1", role: "stats-checker", type: "observation", title: "p<0.001", timestamp: 3 },
    ];
    render(<LabNotebookView {...baseProps} liveEntries={entries} />);
    // Lane headers present; lead labeled and first.
    const lead = screen.getByText(/Kady \(lead\)/i);
    const scout = screen.getByText("literature-scout");
    expect(lead).toBeInTheDocument();
    expect(scout).toBeInTheDocument();
    // Lead appears before the subagent lane in DOM order.
    expect(lead.compareDocumentPosition(scout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Entries from each lane render.
    expect(screen.getByText("Lead idea")).toBeInTheDocument();
    expect(screen.getByText("p<0.001")).toBeInTheDocument();
  });

  it("re-fetches the notebook when subagentCompletions increments", async () => {
    const { rerender } = render(<LabNotebookView {...baseProps} />);
    await waitFor(() => expect(notebookCalls()).toHaveLength(1)); // initial (sessionId) fetch
    rerender(<LabNotebookView {...baseProps} subagentCompletions={1} />);
    await waitFor(() => expect(notebookCalls()).toHaveLength(2)); // completion re-fetch
  });

  it("ignores a stale subagent-triggered refetch that resolves after the session has changed", async () => {
    // 1) Initial mount fetch for s1 resolves immediately with no entries. The
    // subagent-triggered refetch (2) is held open, simulating a slow backend
    // response that lands only after the tab has moved to another session.
    let resolveStale: (value: unknown) => void = () => {};
    const stalePromise = new Promise((resolve) => { resolveStale = resolve; });
    let s1Fetches = 0;
    routeFetch((url) => {
      if (url === "/sessions/s1/notebook") {
        s1Fetches++;
        return s1Fetches === 1 ? okJson({ entries: [] }) : stalePromise;
      }
      if (url === "/sessions/s2/notebook") {
        return okJson({ entries: [e({ id: "tc_s2", title: "From s2" })] });
      }
    });
    const { rerender } = render(<LabNotebookView {...baseProps} />);
    await waitFor(() => expect(s1Fetches).toBe(1));

    // 2) subagentCompletions bumps while still on s1 — this fetch hangs.
    rerender(<LabNotebookView {...baseProps} subagentCompletions={1} />);
    await waitFor(() => expect(s1Fetches).toBe(2));

    // 3) The session switches to s2 before the stale fetch above resolves.
    rerender(<LabNotebookView {...baseProps} sessionId="s2" subagentCompletions={1} />);

    // 4) Now resolve the stale s1 fetch. Its data must NOT land in s2's
    // notebook, even though nothing cancelled it.
    resolveStale(okJson({ entries: [e({ id: "tc_s1_stale", title: "From stale s1" })] }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByText("From stale s1")).not.toBeInTheDocument();

    // 5) A later trigger fetches s2's own notebook, which renders fine.
    rerender(<LabNotebookView {...baseProps} sessionId="s2" subagentCompletions={2} />);
    await waitFor(() => expect(screen.getByText("From s2")).toBeInTheDocument());
    expect(screen.queryByText("From stale s1")).not.toBeInTheDocument();
  });

  it("re-fetches the notebook when streaming transitions from true to false", async () => {
    const { rerender } = render(<LabNotebookView {...baseProps} streaming />);
    await waitFor(() => expect(notebookCalls()).toHaveLength(1)); // initial (sessionId) fetch
    rerender(<LabNotebookView {...baseProps} streaming={false} />);
    await waitFor(() => expect(notebookCalls()).toHaveLength(2)); // run-end re-fetch
  });

  it("downloads a Markdown export through the Export menu", async () => {
    const user = userEvent.setup();
    const createURL = vi.fn(() => "blob:x");
    const revokeURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createURL, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeURL, configurable: true, writable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<LabNotebookView {...baseProps} liveEntries={[e({})]} />);
      await user.click(screen.getByRole("button", { name: /export/i }));
      await user.click(await screen.findByRole("menuitem", { name: /markdown/i }));
      await waitFor(() => expect(createURL).toHaveBeenCalled());
      expect(
        spy.mock.calls.some(
          ([u]) => typeof u === "string" && (u as string).includes("/notebook/export?format=md"),
        ),
      ).toBe(true);
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeURL).toHaveBeenCalledWith("blob:x");
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("filters entries by type via the header chips", () => {
    render(
      <LabNotebookView
        {...baseProps}
        liveEntries={[
          e({ id: "h1", type: "hypothesis", title: "Six cell types" }),
          e({ id: "o1", type: "observation", title: "Peak at 42" }),
        ]}
      />,
    );
    expect(screen.getByText("Peak at 42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hypothesis/i }));
    expect(screen.getByText("Six cell types")).toBeInTheDocument();
    expect(screen.queryByText("Peak at 42")).not.toBeInTheDocument();
    // Toggle back off → both visible again.
    fireEvent.click(screen.getByRole("button", { name: /hypothesis/i }));
    expect(screen.getByText("Peak at 42")).toBeInTheDocument();
  });

  it("narrows entries with the search input", () => {
    render(
      <LabNotebookView
        {...baseProps}
        liveEntries={[
          e({ id: "h1", title: "Six cell types" }),
          e({ id: "o1", type: "observation", title: "Peak at 42" }),
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search entries"), { target: { value: "peak" } });
    expect(screen.getByText("Peak at 42")).toBeInTheDocument();
    expect(screen.queryByText("Six cell types")).not.toBeInTheDocument();
  });

  it("adds a user note through the composer, persisting it to the annotations sidecar", async () => {
    render(<LabNotebookView {...baseProps} liveEntries={[e({ role: "agent" })]} />);
    const input = screen.getByLabelText("Add a note");
    fireEvent.change(input, { target: { value: "remember the batch effect" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Optimistic render: a "You" lane with the note body.
    await waitFor(() => expect(screen.getByText("remember the batch effect")).toBeInTheDocument());
    expect(screen.getByText("You")).toBeInTheDocument();
    // Persisted with a PUT of the full annotations doc.
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([u, init]) =>
            typeof u === "string" &&
            (u as string).includes("/notebook/annotations") &&
            (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
  });

  it("switches to project scope, fetching all-chat entries with session dividers", async () => {
    routeFetch((url) => {
      if (url === "/projects/default/notebook") {
        return okJson({
          entries: [
            e({ id: "p1", title: "Alpha entry", sessionId: "sA", timestamp: 1 }),
            e({ id: "p2", title: "Beta entry", sessionId: "sB", timestamp: 2 }),
          ],
        });
      }
      if (url === "/sessions") {
        return okJson([
          { id: "sA", name: "Alpha chat" },
          { id: "sB", firstMessage: "analyze the data" },
        ]);
      }
    });
    render(<LabNotebookView {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /all chats/i }));

    await waitFor(() => expect(screen.getByText("Alpha entry")).toBeInTheDocument());
    expect(screen.getByText("Beta entry")).toBeInTheDocument();
    // Session dividers labeled by name, falling back to the first message.
    expect(screen.getByText("Alpha chat")).toBeInTheDocument();
    expect(screen.getByText("analyze the data")).toBeInTheDocument();
    expect(
      spy.mock.calls.some(([u]) => u === "/projects/default/notebook"),
    ).toBe(true);
  });

  it("runs the methods draft after confirmation and opens the saved file", async () => {
    const user = userEvent.setup();
    routeFetch((url) => {
      if (url.includes("/notebook/methods-draft")) {
        return okJson({ path: "methods_draft_x.md", costUsd: 0.01 });
      }
    });
    const onOpenFile = vi.fn();
    render(<LabNotebookView {...baseProps} liveEntries={[e({})]} onOpenFile={onOpenFile} />);
    await user.click(screen.getByRole("button", { name: /methods draft/i }));
    await user.click(await screen.findByRole("button", { name: /generate/i }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("methods_draft_x.md"));
    expect(toast.success).toHaveBeenCalled();
    expect(
      spy.mock.calls.some(
        ([u, init]) =>
          typeof u === "string" &&
          (u as string).includes("/notebook/methods-draft") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("toasts an error when the methods draft hits the budget limit (402)", async () => {
    const user = userEvent.setup();
    routeFetch((url) => {
      if (url.includes("/notebook/methods-draft")) {
        return errJson(402, { detail: "budget-exceeded" });
      }
    });
    render(<LabNotebookView {...baseProps} liveEntries={[e({})]} />);
    await user.click(screen.getByRole("button", { name: /methods draft/i }));
    await user.click(await screen.findByRole("button", { name: /generate/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("scrolls a focusEntry target into view when it is present", async () => {
    const orig = Element.prototype.scrollIntoView;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      render(
        <LabNotebookView
          {...baseProps}
          liveEntries={[e({})]}
          focusEntry={{ id: "tc_1", token: 1 }}
        />,
      );
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("toasts when a focusEntry target never appears", async () => {
    vi.useFakeTimers();
    try {
      render(
        <LabNotebookView
          {...baseProps}
          liveEntries={[e({})]}
          focusEntry={{ id: "tc_missing", token: 1 }}
        />,
      );
      await act(async () => {
        vi.advanceTimersByTime(4100);
      });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/isn't in this chat/i));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows agent badges in the chronological Timeline view", () => {
    render(
      <LabNotebookView
        {...baseProps}
        liveEntries={[e({ role: "agent" })]}
      />,
    );
    // Single lane in by-agent view → no lane label…
    expect(screen.queryByText("Kady (lead)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /timeline/i }));
    // …but the chrono view badges each entry with its author.
    expect(screen.getByText("Kady (lead)")).toBeInTheDocument();
  });
});
