import { describe, expect, it, vi } from "vitest";

import { readCapped } from "./structure-viewer";

/** A streaming Response whose body arrives in fixed-size chunks. */
function streamed(totalBytes: number, chunkBytes: number, headers: HeadersInit = {}) {
  const chunk = new Uint8Array(chunkBytes).fill(65);
  let sent = 0;
  const cancel = vi.fn();
  const body = {
    getReader: () => ({
      read: async () => {
        if (sent >= totalBytes) return { done: true, value: undefined };
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        return { done: false, value: size === chunkBytes ? chunk : chunk.slice(0, size) };
      },
      cancel,
    }),
  };
  return { res: { body, headers: new Headers(headers) } as unknown as Response, cancel };
}

describe("readCapped", () => {
  it("returns the body when it stays under the limit", async () => {
    const { res } = streamed(300, 100);
    const out = await readCapped(res, 1_000);
    expect(out).toEqual({ text: "A".repeat(300) });
  });

  it("stops reading a chunked response that has no content-length", async () => {
    const { res, cancel } = streamed(10_000, 100);
    const out = await readCapped(res, 250);
    // The guard used to trust content-length alone, so a chunked 45MB
    // structure reached the parser and froze the tab.
    expect(out).toEqual({ overBytes: 300 });
    expect(cancel).toHaveBeenCalled();
  });

  it("reports the declared size when the header is present", async () => {
    const { res } = streamed(10_000, 1_000, { "content-length": "10000" });
    expect(await readCapped(res, 2_500)).toEqual({ overBytes: 10_000 });
  });
});
