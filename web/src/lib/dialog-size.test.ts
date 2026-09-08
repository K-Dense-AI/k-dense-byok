import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS_DIALOG_SIZE,
  MIN_DIALOG_SIZE,
  clampDialogSize,
  readStoredDialogSize,
  resizeFromCorner,
  writeStoredDialogSize,
} from "./dialog-size";

const viewport = { width: 1512, height: 900 };

describe("dialog size helpers", () => {
  it("clamps to the minimum and to the viewport minus a margin", () => {
    expect(clampDialogSize({ width: 100, height: 100 }, viewport)).toEqual(MIN_DIALOG_SIZE);
    expect(clampDialogSize({ width: 5000, height: 5000 }, viewport)).toEqual({ width: 1480, height: 868 });
    expect(clampDialogSize(DEFAULT_SETTINGS_DIALOG_SIZE, viewport)).toEqual(DEFAULT_SETTINGS_DIALOG_SIZE);
  });

  it("keeps the dragged corner under the pointer on a centered dialog", () => {
    expect(resizeFromCorner({ width: 1000, height: 700 }, 50, -20, viewport)).toEqual({ width: 1100, height: 660 });
  });

  it("round-trips through storage and ignores garbage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writeStoredDialogSize(storage, "k", { width: 900, height: 600 });
    expect(readStoredDialogSize(storage, "k")).toEqual({ width: 900, height: 600 });
    store.set("k", "{not json");
    expect(readStoredDialogSize(storage, "k")).toBeNull();
    store.set("k", JSON.stringify({ width: "wide" }));
    expect(readStoredDialogSize(storage, "k")).toBeNull();
    expect(readStoredDialogSize(undefined, "k")).toBeNull();
  });
});
