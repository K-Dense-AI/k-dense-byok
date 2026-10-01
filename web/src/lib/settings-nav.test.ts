import { describe, expect, it, vi } from "vitest";
import {
  normalizeSettingsTab,
  onOpenSettings,
  openSettings,
  readLastSettingsTab,
  writeLastSettingsTab,
} from "@/lib/settings-nav";

describe("settings-nav", () => {
  it("accepts current tab ids and maps the pre-grouping ones", () => {
    expect(normalizeSettingsTab("project")).toBe("project");
    expect(normalizeSettingsTab("model-providers")).toBe("providers");
    expect(normalizeSettingsTab("api-keys")).toBe("services");
    expect(normalizeSettingsTab("nope")).toBeNull();
    expect(normalizeSettingsTab(undefined)).toBeNull();
  });

  it("delivers open requests to listeners with a normalized tab", () => {
    const handler = vi.fn();
    const stop = onOpenSettings(handler);
    openSettings({ tab: "project", projectId: "p2", section: "budget" });
    openSettings({ tab: "model-providers" as never });
    stop();
    openSettings({ tab: "skills" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { tab: "project", projectId: "p2", section: "budget" });
    expect(handler).toHaveBeenNthCalledWith(2, { tab: "providers" });
  });

  it("round-trips the last tab and ignores junk", () => {
    writeLastSettingsTab("connectors");
    expect(readLastSettingsTab()).toBe("connectors");
    window.localStorage.setItem("kady:settings:lastTab", "gone");
    expect(readLastSettingsTab()).toBeNull();
  });
});
