/**
 * Inline image attachments for the chat composer.
 *
 * Pasted, dropped, or picked images are sent in the run body as raw base64 +
 * mime type and ride the user message as image blocks (Pi PromptOptions.images)
 * — the model sees them directly, without a sandbox file or a read call.
 * Oversized photos are downscaled client-side so the wire body and the model's
 * token bill stay sane; screenshots and plots pass through untouched.
 */
import type { FileUIPart } from "ai";

export interface PromptImage {
  data: string;
  mimeType: string;
}

/** Formats vision models reliably accept (mirrors the server allowlist in
 *  agent/prompt-images.ts); everything else (TIFF, CZI, …) stays on the
 *  sandbox-upload path where analysis code can read it. */
export const INLINE_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const INLINE_IMAGE_ACCEPT = INLINE_IMAGE_MIMES.join(",");
/** Mirrors the server's MAX_RUN_IMAGES cap. */
export const MAX_PROMPT_IMAGES = 12;

/** Images above this decoded byte size are canvas-downscaled before sending. */
const DOWNSCALE_BYTES = 3 * 1024 * 1024;
/** Longest edge after downscaling. */
const DOWNSCALE_EDGE = 2048;
const JPEG_QUALITY = 0.85;

export function isInlineImage(mediaType: string | undefined): boolean {
  return !!mediaType && INLINE_IMAGE_MIMES.includes(mediaType);
}

/** Parse a base64 data: URL into raw base64 + mime type; null for anything else. */
export function parseDataUrl(url: string): PromptImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/** Approximate decoded size of a base64 payload. */
export function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

export function needsDownscale(byteLength: number): boolean {
  return byteLength > DOWNSCALE_BYTES;
}

/** Draw the image onto a canvas capped at DOWNSCALE_EDGE per edge and
 *  re-encode as JPEG. Transparency flattens to white (JPEG has no alpha).
 *  Falls back to the original on any decode/encode failure. */
async function downscale(image: PromptImage): Promise<PromptImage> {
  try {
    const img = new Image();
    img.src = `data:${image.mimeType};base64,${image.data}`;
    await img.decode();
    const scale = Math.min(
      1,
      DOWNSCALE_EDGE / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return image;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const parsed = parseDataUrl(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    // Keep the original if re-encoding somehow grew it.
    return parsed && parsed.data.length < image.data.length ? parsed : image;
  } catch {
    return image;
  }
}

/**
 * Convert the composer's attachment parts (data: URLs by submit time — the
 * PromptInput converts blob URLs before calling onSubmit) into the run-body
 * payload. Non-image parts and unparseable URLs are dropped.
 */
export async function promptImagesFromParts(
  files: FileUIPart[],
): Promise<PromptImage[]> {
  const out: PromptImage[] = [];
  for (const f of files.slice(0, MAX_PROMPT_IMAGES)) {
    if (!isInlineImage(f.mediaType)) continue;
    const parsed = f.url ? parseDataUrl(f.url) : null;
    if (!parsed) continue;
    out.push(needsDownscale(base64Bytes(parsed.data)) ? await downscale(parsed) : parsed);
  }
  return out;
}
