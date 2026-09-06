import { describe, expect, it, vi } from "vitest";
import { PreviewCache } from "../src/preview-cache.ts";

const options = { concurrency: 2, maxBytes: 10, maxEntries: 2, ttlMs: 100, size: (v: string) => v.length, cacheable: (v: string) => v !== "error" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shared preview cache", () => {
  it("deduplicates work and caches successes only", async () => {
    const cache = new PreviewCache(options);
    const work = deferred<string>();
    const load = vi.fn(() => work.promise);
    const a = cache.get("one", load);
    const b = cache.get("one", load);
    work.resolve("ok");
    expect(await Promise.all([a, b])).toEqual(["ok", "ok"]);
    expect(await cache.get("one", load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(1);
    const fail = vi.fn(async () => "error");
    await cache.get("bad", fail);
    await cache.get("bad", fail); // Can retry immediately, before prior finally.
    expect(fail).toHaveBeenCalledTimes(2);
  });
  it("keeps a shared job alive until the last consumer aborts", async () => {
    const cache = new PreviewCache(options);
    const a = new AbortController();
    const b = new AbortController();
    let signal!: AbortSignal;
    const work = deferred<string>();
    const load = (s: AbortSignal) => { signal = s; return work.promise; };
    const one = cache.get("key", load, a.signal).catch((e) => e.name);
    const two = cache.get("key", load, b.signal).catch((e) => e.name);
    await tick();
    a.abort();
    expect(await one).toBe("AbortError");
    expect(signal.aborted).toBe(false);
    b.abort();
    expect(await two).toBe("AbortError");
    expect(signal.aborted).toBe(true);
    work.resolve("abandoned");
    await tick();
    expect(await cache.get("key", async () => "fresh")).toBe("fresh");
  });
  it("bounds concurrency and removes abandoned queued work", async () => {
    const cache = new PreviewCache({ ...options, concurrency: 1 });
    const work = deferred<string>();
    const one = cache.get("a", () => work.promise);
    const controller = new AbortController();
    const abandoned = vi.fn(async () => "unused");
    const two = cache.get("b", abandoned, controller.signal).catch((e) => e.name);
    const last = vi.fn(async () => "last");
    const three = cache.get("c", last);
    await tick();
    expect(last).not.toHaveBeenCalled();
    controller.abort();
    expect(await two).toBe("AbortError");
    work.resolve("first");
    expect(await one).toBe("first");
    expect(await three).toBe("last");
    expect(abandoned).not.toHaveBeenCalled();
  });
  it("evicts by bytes/LRU and expires old entries", async () => {
    const cache = new PreviewCache(options);
    const a = vi.fn(async () => "123456");
    await cache.get("a", a);
    await cache.get("b", async () => "abcdef");
    await cache.get("a", a);
    expect(a).toHaveBeenCalledTimes(2);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    try { await cache.get("a", a); expect(a).toHaveBeenCalledTimes(3); }
    finally { now.mockRestore(); }
  });
});
