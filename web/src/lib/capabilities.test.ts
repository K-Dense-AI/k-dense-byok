import { afterEach, describe, expect, it, vi } from "vitest";
import * as projects from "@/lib/projects";
import { getAllSkills, setSkillEnabled } from "@/lib/capabilities";

afterEach(() => vi.restoreAllMocks());

describe("capabilities client", () => {
  it("getAllSkills returns the enabled/disabled partition", async () => {
    vi.spyOn(projects, "apiFetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: [{ id: "a", name: "a", description: "" }], disabled: [] }), {
        status: 200,
      }),
    );
    const listing = await getAllSkills();
    expect(listing.enabled.map((s) => s.name)).toEqual(["a"]);
    expect(listing.disabled).toEqual([]);
  });

  it("setSkillEnabled posts to the enable/disable route and throws detail on error", async () => {
    const spy = vi
      .spyOn(projects, "apiFetch")
      .mockResolvedValue(new Response(JSON.stringify({ detail: "boom" }), { status: 409 }));
    await expect(setSkillEnabled("a", false)).rejects.toThrow("boom");
    expect(spy).toHaveBeenCalledWith("/skills/a/disable", { method: "POST" });
  });
});
