import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SciTimeoutError,
  fetchSciJson,
  fetchSciText,
  isAbortError,
} from "./sci-fetch";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

/** Resolves only when the request's own signal aborts, like a stalled socket. */
function stalled(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

describe("fetchSciJson", () => {
  it("returns the parsed body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "chem", atoms: 12 }), { status: 200 }),
    );
    await expect(fetchSciJson<{ atoms: number }>("/sandbox/sci-summary")).resolves.toEqual({
      kind: "chem",
      atoms: 12,
    });
  });

  it("surfaces the backend's detail rather than a bare status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "RDKit is not installed" }), { status: 503 }),
    );
    await expect(fetchSciJson("/sandbox/sci-summary")).rejects.toThrow(
      "RDKit is not installed",
    );
  });

  it("falls back to the status when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    await expect(fetchSciJson("/sandbox/sci-summary")).rejects.toThrow("HTTP 502");
  });

  it("gives up on a stalled request instead of spinning forever", async () => {
    fetchMock.mockImplementation(stalled());
    const request = fetchSciJson("/sandbox/sci-summary", { timeoutMs: 25 });
    await expect(request).rejects.toBeInstanceOf(SciTimeoutError);
    await expect(request).rejects.toThrow(/timed out/);
  });

  it("propagates an unmount abort as an AbortError, not a timeout", async () => {
    fetchMock.mockImplementation(stalled());
    const external = new AbortController();
    const request = fetchSciText("/sandbox/raw", {
      signal: external.signal,
      timeoutMs: 10_000,
    });
    external.abort();
    // The viewer must stay silent for its own unmount; only real failures show.
    await expect(request.catch((e) => isAbortError(e))).resolves.toBe(true);
  });
});
