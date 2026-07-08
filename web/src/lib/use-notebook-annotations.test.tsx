import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useNotebookAnnotations } from "./use-notebook-annotations";
import type { AnnotationsDoc } from "./notebook-annotations";

vi.mock("@/lib/projects", () => ({ apiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { apiFetch } = await import("@/lib/projects");
const { toast } = await import("sonner");
const spy = apiFetch as unknown as ReturnType<typeof vi.fn>;

/** Minimal Response-shaped object. */
function res(opts: {
  ok?: boolean;
  status?: number;
  data?: unknown;
  lastModified?: string | null;
} = {}) {
  const ok = opts.ok ?? true;
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "last-modified" ? (opts.lastModified ?? null) : null,
    },
    json: async () => opts.data ?? { version: 1, annotations: [] },
  };
}

const URL_S1 = "/sessions/s1/notebook/annotations";

/** Route apiFetch by URL + method. `onPut` decides each PUT's response in order. */
function route(opts: {
  get?: () => unknown;
  puts?: Array<(body: AnnotationsDoc, headers: Record<string, string>) => unknown>;
} = {}) {
  const putCalls: Array<{ body: AnnotationsDoc; headers: Record<string, string> }> = [];
  let putIndex = 0;
  spy.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== URL_S1) throw new Error(`unexpected url: ${url}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as AnnotationsDoc;
      const headers = (init.headers ?? {}) as Record<string, string>;
      putCalls.push({ body, headers });
      const handler = opts.puts?.[Math.min(putIndex, (opts.puts?.length ?? 1) - 1)];
      putIndex++;
      return Promise.resolve(handler ? handler(body, headers) : res({ lastModified: "lm-put" }));
    }
    return Promise.resolve(opts.get ? opts.get() : res());
  });
  return putCalls;
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("useNotebookAnnotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the sidecar on mount when enabled with a session", async () => {
    route({
      get: () =>
        res({
          data: { version: 1, annotations: [{ id: "p1", kind: "pin", entryId: "e1", createdAt: 1 }] },
          lastModified: "lm-1",
        }),
    });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await waitFor(() => expect(result.current.pinnedIds.has("e1")).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(URL_S1);
  });

  it("does not fetch when disabled or when there is no session", async () => {
    renderHook(() => useNotebookAnnotations("s1", false));
    renderHook(() => useNotebookAnnotations(null, true));
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("togglePin adds a pin optimistically and PUTs the full doc with If-Unmodified-Since", async () => {
    const puts = route({ get: () => res({ lastModified: "lm-initial" }) });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush(); // initial GET captures Last-Modified

    act(() => result.current.togglePin("e1"));
    // Optimistic: pinned before the save round-trips.
    expect(result.current.pinnedIds.has("e1")).toBe(true);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].headers["If-Unmodified-Since"]).toBe("lm-initial");
    expect(puts[0].body.annotations).toHaveLength(1);
    expect(puts[0].body.annotations[0]).toMatchObject({ kind: "pin", entryId: "e1" });
    expect(typeof puts[0].body.annotations[0].id).toBe("string");
  });

  it("togglePin removes the existing pin for an already-pinned entry", async () => {
    const puts = route({
      get: () =>
        res({
          data: { version: 1, annotations: [{ id: "p1", kind: "pin", entryId: "e1", createdAt: 1 }] },
          lastModified: "lm-1",
        }),
    });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await waitFor(() => expect(result.current.pinnedIds.has("e1")).toBe(true));

    act(() => result.current.togglePin("e1"));
    expect(result.current.pinnedIds.has("e1")).toBe(false);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.annotations).toHaveLength(0);
  });

  it("addComment stores a trimmed comment; blank bodies are dropped without a save", async () => {
    const puts = route({});
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush();

    act(() => result.current.addComment("e1", "  looks off  "));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.annotations[0]).toMatchObject({
      kind: "comment",
      entryId: "e1",
      body: "looks off",
    });
    expect(result.current.commentsByEntry.get("e1")).toHaveLength(1);

    act(() => result.current.addComment("e1", "   "));
    await flush();
    expect(puts).toHaveLength(1); // no extra PUT
  });

  it("addNote stores a note with optional title", async () => {
    const puts = route({});
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush();

    act(() => result.current.addNote("remember the batch effect", "  QC  "));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.annotations[0]).toMatchObject({
      kind: "note",
      body: "remember the batch effect",
      title: "QC",
    });
    expect(result.current.notes).toHaveLength(1);
  });

  it("rebases the op onto the fresh doc and retries once after a 412", async () => {
    const serverPin = { id: "srv", kind: "pin", entryId: "e-server", createdAt: 1 };
    let getCount = 0;
    const puts = route({
      get: () => {
        getCount++;
        return getCount === 1
          ? res({ lastModified: "lm-1" }) // initial mount GET: empty doc
          : res({ data: { version: 1, annotations: [serverPin] }, lastModified: "lm-2" });
      },
      puts: [
        () => res({ ok: false, status: 412 }),
        () => res({ lastModified: "lm-3" }),
      ],
    });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush();

    act(() => result.current.togglePin("e1"));
    await waitFor(() => expect(puts).toHaveLength(2));

    // Second PUT carries the rebased doc: the concurrent server pin + our op.
    expect(puts[1].body.annotations.map((a) => a.entryId).sort()).toEqual(["e-server", "e1"]);
    // The retry used the fresh Last-Modified from the re-GET.
    expect(puts[1].headers["If-Unmodified-Since"]).toBe("lm-2");
    await waitFor(() => expect(result.current.pinnedIds.has("e-server")).toBe(true));
    expect(result.current.pinnedIds.has("e1")).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts and reverts to the server copy when the save fails", async () => {
    const serverDoc = {
      version: 1,
      annotations: [{ id: "srv", kind: "pin", entryId: "e-server", createdAt: 1 }],
    };
    let getCount = 0;
    route({
      get: () => {
        getCount++;
        return getCount === 1
          ? res({ lastModified: "lm-1" })
          : res({ data: serverDoc, lastModified: "lm-2" });
      },
      puts: [() => res({ ok: false, status: 500 })],
    });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush();

    act(() => result.current.togglePin("e1"));
    expect(result.current.pinnedIds.has("e1")).toBe(true); // optimistic

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pinnedIds.has("e1")).toBe(false)); // reverted
    expect(result.current.pinnedIds.has("e-server")).toBe(true);
  });

  it("toasts and reverts on a network error too", async () => {
    let getCount = 0;
    spy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.reject(new Error("offline"));
      getCount++;
      return Promise.resolve(res({ lastModified: `lm-${getCount}` }));
    });
    const { result } = renderHook(() => useNotebookAnnotations("s1", true));
    await flush();

    act(() => result.current.addNote("will fail"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(result.current.notes).toHaveLength(0));
  });
});
