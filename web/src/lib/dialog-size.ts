/**
 * Persisted, viewport-clamped size for resizable dialogs (Settings).
 * Pure helpers so the arithmetic is testable without a DOM.
 */
export interface DialogSize {
  width: number;
  height: number;
}

export const SETTINGS_DIALOG_SIZE_KEY = "kady-settings-dialog-size";
export const DEFAULT_SETTINGS_DIALOG_SIZE: DialogSize = { width: 1040, height: 720 };
export const MIN_DIALOG_SIZE: DialogSize = { width: 640, height: 420 };
/** Gap kept between the dialog and the viewport edges. */
export const DIALOG_VIEWPORT_MARGIN = 32;

export function clampDialogSize(size: DialogSize, viewport: DialogSize, min: DialogSize = MIN_DIALOG_SIZE): DialogSize {
  const maxWidth = Math.max(min.width, viewport.width - DIALOG_VIEWPORT_MARGIN);
  const maxHeight = Math.max(min.height, viewport.height - DIALOG_VIEWPORT_MARGIN);
  return {
    width: Math.round(Math.min(Math.max(size.width, min.width), maxWidth)),
    height: Math.round(Math.min(Math.max(size.height, min.height), maxHeight)),
  };
}

export function readStoredDialogSize(storage: Pick<Storage, "getItem"> | undefined, key: string): DialogSize | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DialogSize>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

export function writeStoredDialogSize(storage: Pick<Storage, "setItem"> | undefined, key: string, size: DialogSize): void {
  try {
    storage?.setItem(key, JSON.stringify(size));
  } catch {
    /* private mode / quota: the size simply is not remembered */
  }
}

/**
 * Size after dragging the bottom-right corner by (dx, dy). The dialog is
 * centered, so the box grows on both sides: double the delta keeps the corner
 * under the pointer.
 */
export function resizeFromCorner(start: DialogSize, dx: number, dy: number, viewport: DialogSize): DialogSize {
  return clampDialogSize({ width: start.width + dx * 2, height: start.height + dy * 2 }, viewport);
}
