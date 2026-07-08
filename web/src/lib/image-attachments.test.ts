import { describe, expect, it } from "vitest";
import type { FileUIPart } from "ai";
import {
  base64Bytes,
  isInlineImage,
  MAX_PROMPT_IMAGES,
  needsDownscale,
  parseDataUrl,
  promptImagesFromParts,
} from "./image-attachments";

const part = (mediaType: string, url: string): FileUIPart => ({
  type: "file",
  mediaType,
  url,
});

describe("parseDataUrl", () => {
  it("extracts base64 data + mime type from a data URL", () => {
    expect(parseDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
  });

  it("returns null for blob URLs and non-base64 data URLs", () => {
    expect(parseDataUrl("blob:http://localhost/abc")).toBeNull();
    expect(parseDataUrl("data:text/plain,hello")).toBeNull();
    expect(parseDataUrl("https://example.com/x.png")).toBeNull();
  });
});

describe("isInlineImage", () => {
  it("accepts the vision-safe formats and nothing else", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/jpeg")).toBe(true);
    expect(isInlineImage("image/webp")).toBe(true);
    expect(isInlineImage("image/gif")).toBe(true);
    // TIFF and friends belong on the sandbox-upload path.
    expect(isInlineImage("image/tiff")).toBe(false);
    expect(isInlineImage("application/pdf")).toBe(false);
    expect(isInlineImage(undefined)).toBe(false);
  });
});

describe("needsDownscale", () => {
  it("triggers only above the 3MB threshold", () => {
    expect(needsDownscale(3 * 1024 * 1024)).toBe(false);
    expect(needsDownscale(3 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe("promptImagesFromParts", () => {
  it("keeps inline images and drops everything else", async () => {
    const result = await promptImagesFromParts([
      part("image/png", "data:image/png;base64,aGVsbG8="),
      part("image/tiff", "data:image/tiff;base64,bm9wZQ=="),
      part("image/jpeg", "blob:http://localhost/unconverted"),
      part("image/webp", "data:image/webp;base64,d29ybGQ="),
    ]);
    expect(result).toEqual([
      { mimeType: "image/png", data: "aGVsbG8=" },
      { mimeType: "image/webp", data: "d29ybGQ=" },
    ]);
  });

  it("caps the number of images at the server limit", async () => {
    const many = Array.from({ length: MAX_PROMPT_IMAGES + 3 }, () =>
      part("image/png", "data:image/png;base64,aGVsbG8="),
    );
    const result = await promptImagesFromParts(many);
    expect(result).toHaveLength(MAX_PROMPT_IMAGES);
  });
});

describe("base64Bytes", () => {
  it("approximates the decoded size", () => {
    // "aGVsbG8=" decodes to "hello" (5 bytes); floor(8 * 3 / 4) = 6 is close
    // enough for cap checks (the server applies the same arithmetic).
    expect(base64Bytes("aGVsbG8=")).toBe(6);
  });
});
