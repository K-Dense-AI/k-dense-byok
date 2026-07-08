import { describe, expect, it } from "vitest";
import {
  MAX_RUN_IMAGES,
  MAX_RUN_IMAGE_BYTES,
  parseRunImages,
} from "../src/agent/prompt-images.ts";

const png = (data = "aGVsbG8=") => ({ data, mimeType: "image/png" });

describe("parseRunImages", () => {
  it("returns an empty list when the field is absent", () => {
    expect(parseRunImages(undefined)).toEqual({ images: [] });
    expect(parseRunImages(null)).toEqual({ images: [] });
  });

  it("normalizes valid entries to Pi image parts", () => {
    const result = parseRunImages([png(), { data: "d29ybGQ=", mimeType: "image/jpeg" }]);
    expect(result).toEqual({
      images: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
      ],
    });
  });

  it("rejects non-array bodies", () => {
    expect(parseRunImages("nope")).toHaveProperty("error");
    expect(parseRunImages({ data: "x", mimeType: "image/png" })).toHaveProperty("error");
  });

  it("rejects entries without base64 data + mimeType", () => {
    expect(parseRunImages([{ mimeType: "image/png" }])).toHaveProperty("error");
    expect(parseRunImages([{ data: "", mimeType: "image/png" }])).toHaveProperty("error");
    expect(parseRunImages([null])).toHaveProperty("error");
  });

  it("rejects mime types outside the vision allowlist", () => {
    const tiff = parseRunImages([{ data: "aGVsbG8=", mimeType: "image/tiff" }]);
    expect(tiff).toHaveProperty("error");
    expect((tiff as { error: string }).error).toContain("image/tiff");
  });

  it("enforces the per-image size cap", () => {
    // Base64 length for just over MAX_RUN_IMAGE_BYTES decoded bytes.
    const oversized = "A".repeat(Math.ceil(((MAX_RUN_IMAGE_BYTES + 4) * 4) / 3));
    expect(parseRunImages([png(oversized)])).toHaveProperty("error");
  });

  it("enforces the per-message image count cap", () => {
    const many = Array.from({ length: MAX_RUN_IMAGES + 1 }, () => png());
    expect(parseRunImages(many)).toHaveProperty("error");
    const exactly = Array.from({ length: MAX_RUN_IMAGES }, () => png());
    expect(parseRunImages(exactly)).toMatchObject({ images: expect.any(Array) });
  });
});
