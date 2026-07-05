import { describe, expect, it, vi } from "vitest";
import type { ProseToken } from "./prose";
import { SpellWorkerClient, buildSpellDiagnostics } from "./spellcheck";

function tok(word: string, from: number): ProseToken {
  return { word, from, to: from + word.length };
}

describe("buildSpellDiagnostics", () => {
  it("marks only misspelled, non-ignored tokens", () => {
    const tokens = [tok("helo", 0), tok("world", 5), tok("kady", 11)];
    const diags = buildSpellDiagnostics(
      tokens,
      new Set(["helo", "kady"]),
      new Set(["kady"]),
      () => [],
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ from: 0, to: 4, severity: "hint" });
    expect(diags[0].message).toContain("helo");
  });
  it("is case-insensitive on the ignore list", () => {
    const diags = buildSpellDiagnostics(
      [tok("Kady", 0)], new Set(["Kady"]), new Set(["kady"]), () => [],
    );
    expect(diags).toHaveLength(0);
  });
});

describe("SpellWorkerClient", () => {
  it("round-trips check requests by id", async () => {
    const listeners: ((e: MessageEvent) => void)[] = [];
    const fakeWorker = {
      postMessage: vi.fn((msg: { id: number; words: string[] }) => {
        queueMicrotask(() => {
          for (const l of listeners) {
            l({ data: { id: msg.id, misspelled: ["helo"] } } as MessageEvent);
          }
        });
      }),
      addEventListener: (_: string, cb: (e: MessageEvent) => void) => listeners.push(cb),
      terminate: vi.fn(),
    } as unknown as Worker;

    const client = new SpellWorkerClient(fakeWorker);
    const misspelled = await client.check(["helo", "world"]);
    expect(misspelled).toEqual(["helo"]);
    client.dispose();
    expect((fakeWorker as unknown as { terminate: ReturnType<typeof vi.fn> }).terminate).toHaveBeenCalled();
  });

  it("settles in-flight requests on dispose instead of hanging", async () => {
    const fakeWorker = {
      postMessage: vi.fn(),                       // never replies
      addEventListener: () => {},
      terminate: vi.fn(),
    } as unknown as Worker;
    const client = new SpellWorkerClient(fakeWorker);
    const pending = client.check(["anything"]);   // will never get a reply
    client.dispose();
    await expect(pending).resolves.toEqual([]);    // settled, not hung
  });
});
