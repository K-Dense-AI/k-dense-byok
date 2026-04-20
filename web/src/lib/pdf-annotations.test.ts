import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  colorForAuthor,
  EMPTY_DOC,
  fetchAnnotations,
  newAnnotationId,
  saveAnnotations,
  USER_AUTHOR,
  USER_COLOR,
  type Author,
} from "./pdf-annotations";

describe("colorForAuthor", () => {
  it("returns the user color for user authors", () => {
    expect(colorForAuthor(USER_AUTHOR)).toBe(USER_COLOR);
  });

  it("is deterministic for expert authors", () => {
    const expert: Author = { kind: "expert", id: "gemini-pro", label: "Gemini" };
    const c1 = colorForAuthor(expert);
    const c2 = colorForAuthor(expert);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("newAnnotationId", () => {
  it("returns a non-empty string", () => {
    const id = newAnnotationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("produces unique ids on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(newAnnotationId());
    expect(ids.size).toBe(10);
  });
});

describe("fetchAnnotations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns EMPTY_DOC when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 }))
    );
    const { doc, lastModified } = await fetchAnnotations("foo.pdf");
    expect(doc).toEqual(EMPTY_DOC);
    expect(lastModified).toBeNull();
  });

  it("extracts Last-Modified header and normalises annotations", async () => {
    const body = { version: 1, annotations: null };
    const headers = new Headers({ "Last-Modified": "Wed, 21 Oct 2024 07:28:00 GMT" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers }))
    );
    const { doc, lastModified } = await fetchAnnotations("foo.pdf");
    expect(doc.annotations).toEqual([]);
    expect(lastModified).toBe("Wed, 21 Oct 2024 07:28:00 GMT");
  });
});

describe("saveAnnotations", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns conflict:true on 412 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 412 }))
    );
    const res = await saveAnnotations(
      "foo.pdf",
      EMPTY_DOC,
      "Wed, 21 Oct 2024 07:28:00 GMT"
    );
    expect(res).toEqual({ ok: false, conflict: true, lastModified: null });
  });

  it("forwards If-Unmodified-Since header when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Last-Modified": "now" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await saveAnnotations("foo.pdf", EMPTY_DOC, "yesterday");
    const headers = new Headers(
      (fetchMock.mock.calls[0][1] as RequestInit).headers
    );
    expect(headers.get("If-Unmodified-Since")).toBe("yesterday");
  });

  it("returns ok:true on successful save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ saved: "foo.pdf" }), {
          status: 200,
          headers: { "Last-Modified": "now" },
        })
      )
    );
    const res = await saveAnnotations("foo.pdf", EMPTY_DOC, null);
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe(false);
    expect(res.lastModified).toBe("now");
  });
});
