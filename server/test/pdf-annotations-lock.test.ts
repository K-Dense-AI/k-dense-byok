import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mutatePdfAnnotations,
  pdfAnnotationSidecarPath,
  PdfAnnotationStoreError,
} from "../src/pdf-annotations-store.ts";

// The sidecar lock loop is fully synchronous between iterations. Before the
// fix, a stale lock that could not be cleared (zero-byte file, or a
// stat/unlink error) hit `continue` past both the deadline check and the
// 20ms sleep, so the loop spun forever and blocked the event loop for the
// whole backend. These tests pin the two guarantees that prevent that: a
// stale lock with no readable holder is removable, and a lock that stays
// held ends in LOCK_TIMEOUT rather than a hang.

let sandbox: string;
let lock: string;

function ageLock(lockPath: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, t, t);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kady-annot-lock-"));
  fs.writeFileSync(path.join(sandbox, "paper.pdf"), "%PDF-1.4\n");
  const sidecar = pdfAnnotationSidecarPath(sandbox, "paper.pdf");
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  lock = path.join(path.dirname(sidecar), `.${path.basename(sidecar)}.lock`);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("pdf annotation sidecar lock", () => {
  it("recovers a stale zero-byte lock instead of spinning", async () => {
    fs.writeFileSync(lock, "");
    ageLock(lock, 60_000);

    const { doc } = await mutatePdfAnnotations(sandbox, "paper.pdf", (d) => ({
      doc: d,
      value: null,
    }));
    expect(doc.annotations).toEqual([]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("recovers a stale tokened lock left by a dead holder", async () => {
    fs.writeFileSync(lock, `99999:dead-holder\n${Date.now() - 60_000}\n`);
    ageLock(lock, 60_000);

    await expect(
      mutatePdfAnnotations(sandbox, "paper.pdf", (d) => ({ doc: d, value: 1 })),
    ).resolves.toMatchObject({ value: 1 });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("times out on a live lock rather than hanging", async () => {
    fs.writeFileSync(lock, `${process.pid}:live-holder\n${Date.now()}\n`);

    const started = Date.now();
    await expect(
      mutatePdfAnnotations(sandbox, "paper.pdf", (d) => ({ doc: d, value: 1 })),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" } satisfies Partial<PdfAnnotationStoreError>);
    // Waited out LOCK_TIMEOUT_MS (5s), and the live lock was left alone.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(fs.existsSync(lock)).toBe(true);
  }, 15_000);
});
