import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { pdfAnnotationSidecarPath } from "../src/pdf-annotations-store.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("PDF annotation API", () => {
  it("persists validated annotations and returns them with a modification token", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "paper.pdf"), "%PDF-1.4\n");
    const annotation = {
      id: "expert-note",
      type: "note",
      page: 1,
      anchor: { x: 72, y: 700 },
      body: "Check the endpoint definition.",
      author: { kind: "expert", id: "kady", label: "Kady" },
      createdAt: "2026-07-20T00:00:00.000Z",
    };

    const saved = await app.inject({
      method: "PUT",
      url: "/sandbox/annotations?path=paper.pdf",
      headers: { "x-project-id": "default" },
      payload: { version: 1, annotations: [annotation] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ count: 1 });
    expect(saved.headers["last-modified"]).toBeTruthy();

    const loaded = await app.inject({
      method: "GET",
      url: "/sandbox/annotations?path=paper.pdf",
      headers: { "x-project-id": "default" },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().annotations).toEqual([annotation]);
    expect(loaded.headers["cache-control"]).toBe("no-store");
  });

  it("rejects stale writes and non-PDF targets", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "paper.pdf"), "%PDF-1.4\n");
    fs.writeFileSync(path.join(paths.sandbox, "notes.txt"), "text");
    const empty = { version: 1, annotations: [] };
    const first = await app.inject({
      method: "PUT",
      url: "/sandbox/annotations?path=paper.pdf",
      headers: { "x-project-id": "default" },
      payload: empty,
    });
    const stale = first.headers["last-modified"]!;
    const sidecar = pdfAnnotationSidecarPath(paths.sandbox, "paper.pdf");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(sidecar, future, future);

    const conflict = await app.inject({
      method: "PUT",
      url: "/sandbox/annotations?path=paper.pdf",
      headers: {
        "x-project-id": "default",
        "if-unmodified-since": stale,
      },
      payload: empty,
    });
    expect(conflict.statusCode).toBe(412);

    const notPdf = await app.inject({
      method: "GET",
      url: "/sandbox/annotations?path=notes.txt",
      headers: { "x-project-id": "default" },
    });
    expect(notPdf.statusCode).toBe(400);
  });

  it("uses If-Match to catch a write the second-resolution timestamp misses", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "paper.pdf"), "%PDF-1.4\n");
    const note = (id: string) => ({
      id,
      type: "note" as const,
      page: 1,
      anchor: { x: 10, y: 10 },
      body: id,
      author: { kind: "user" as const, id: "u", label: "User" },
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    const put = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "PUT",
        url: "/sandbox/annotations?path=paper.pdf",
        headers: { "x-project-id": "default", ...headers },
        payload: payload as Record<string, unknown>,
      });

    const first = await put({ version: 1, annotations: [note("a")] });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    // Another tab saves within the same second: Last-Modified is unchanged, so
    // only the content hash can reveal that this client's copy is stale.
    const second = await put({ version: 1, annotations: [note("a"), note("b")] });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(etag);

    const conflict = await put({ version: 1, annotations: [note("a")] }, { "if-match": etag });
    expect(conflict.statusCode).toBe(412);
    // The other tab's annotation survives the refused write.
    const loaded = await app.inject({
      method: "GET",
      url: "/sandbox/annotations?path=paper.pdf",
      headers: { "x-project-id": "default" },
    });
    expect(loaded.json().annotations.map((a: { id: string }) => a.id)).toEqual(["a", "b"]);

    const retry = await put(
      { version: 1, annotations: [note("a"), note("b"), note("c")] },
      { "if-match": loaded.headers.etag as string },
    );
    expect(retry.statusCode).toBe(200);
  });
});
