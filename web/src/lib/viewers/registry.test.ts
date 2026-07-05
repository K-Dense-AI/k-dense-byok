import { describe, it, expect } from "vitest";
import { getViewerDef, VIEWER_REGISTRY } from "./registry";

describe("viewer registry", () => {
  it("returns undefined for an unregistered category", () => {
    expect(getViewerDef("text")).toBeUndefined();
  });

  it("returns the registered def for a registered category", () => {
    // seed a fake entry to prove lookup works independent of real viewers
    VIEWER_REGISTRY.text = {
      loadMode: "text",
      Viewer: () => null,
      canEditSource: true,
      managesOwnScroll: false,
    };
    const def = getViewerDef("text");
    expect(def?.loadMode).toBe("text");
    expect(def?.canEditSource).toBe(true);
    delete VIEWER_REGISTRY.text; // don't leak into other tests
  });
});
