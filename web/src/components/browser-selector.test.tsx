import { describe, it, expect } from "vitest";
import { profileLabel } from "./browser-selector";
import type { ChromeProfile } from "@/lib/use-settings";

const PROFILES: ChromeProfile[] = [
  { id: "Default", name: "Work", email: "a@b.com", path: "/x" },
  { id: "Profile 1", name: "Personal", email: null, path: "/y" },
];

describe("profileLabel", () => {
  it("returns null when no profile id is given", () => {
    expect(profileLabel(null, PROFILES)).toBeNull();
  });

  it("returns the human name for a known profile", () => {
    expect(profileLabel("Default", PROFILES)).toBe("Work");
  });

  it("falls back to the id when unknown", () => {
    expect(profileLabel("Ghost", PROFILES)).toBe("Ghost");
  });
});
