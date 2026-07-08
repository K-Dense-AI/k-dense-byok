/**
 * Inline image attachments for POST /sessions/:id/run.
 *
 * The composer sends pasted/attached images as raw base64 + mime type; they
 * ride the user message as Pi image blocks (PromptOptions.images), so the
 * model sees them directly — no sandbox file or read call involved. Caps
 * mirror the interview tool's attachment limits (interview.ts).
 */

export const MAX_RUN_IMAGES = 12;
export const MAX_RUN_IMAGE_BYTES = 5 * 1024 * 1024;

/** Wire shape from the UI; structurally matches Pi's ImageContent. */
export interface RunImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** Formats vision endpoints reliably accept. Everything else (TIFF, CZI, …)
 *  belongs on the sandbox-upload path where analysis code can read it. */
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Approximate decoded size of a base64 payload. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/**
 * Validate the run body's `images` field. Returns the normalized image parts
 * (empty when the field is absent) or an error string for a 400.
 */
export function parseRunImages(raw: unknown): { images: RunImage[] } | { error: string } {
  if (raw === undefined || raw === null) return { images: [] };
  if (!Array.isArray(raw)) return { error: "images must be an array" };
  if (raw.length > MAX_RUN_IMAGES) {
    return { error: `at most ${MAX_RUN_IMAGES} images per message` };
  }
  const images: RunImage[] = [];
  for (const item of raw) {
    const data = (item as { data?: unknown } | null)?.data;
    const mimeType = (item as { mimeType?: unknown } | null)?.mimeType;
    if (typeof data !== "string" || !data || typeof mimeType !== "string") {
      return { error: "each image needs base64 data + mimeType" };
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      return { error: `unsupported image type "${mimeType}" (png, jpeg, webp, or gif)` };
    }
    if (base64Bytes(data) > MAX_RUN_IMAGE_BYTES) {
      return { error: `image exceeds ${MAX_RUN_IMAGE_BYTES / (1024 * 1024)}MB` };
    }
    images.push({ type: "image", data, mimeType });
  }
  return { images };
}
