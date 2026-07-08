import { describe, expect, it } from "vitest";

import { skillNameFromRead } from "./skill-invocation";

describe("skillNameFromRead", () => {
  it("names a project skill read by its directory", () => {
    expect(skillNameFromRead("read", { path: ".pi/skills/scrnaseq-qc/SKILL.md" })).toBe(
      "scrnaseq-qc",
    );
  });

  it("uses the innermost directory for nested skills", () => {
    expect(
      skillNameFromRead("read", { path: ".pi/skills/genomics/variant-calling/SKILL.md" }),
    ).toBe("variant-calling");
  });

  it("recognizes SKILL.md outside the .pi tree (e.g. .agents/skills, absolute)", () => {
    expect(skillNameFromRead("read", { path: ".agents/skills/foo/SKILL.md" })).toBe("foo");
    expect(
      skillNameFromRead("read", { path: "/Users/x/.pi/agent/skills/bar/SKILL.md" }),
    ).toBe("bar");
  });

  it("recognizes single-file skills directly under a skills root", () => {
    expect(skillNameFromRead("read", { path: ".pi/skills/quick-notes.md" })).toBe(
      "quick-notes",
    );
    expect(
      skillNameFromRead("read", { path: "/Users/x/.pi/agent/skills/quick-notes.md" }),
    ).toBe("quick-notes");
  });

  it("normalizes Windows separators", () => {
    expect(skillNameFromRead("read", { path: ".pi\\skills\\foo\\SKILL.md" })).toBe("foo");
  });

  it("ignores ordinary reads and other tools", () => {
    expect(skillNameFromRead("read", { path: "analysis/results.md" })).toBeNull();
    expect(skillNameFromRead("read", { path: ".pi/skills/foo/references/api.md" })).toBeNull();
    expect(skillNameFromRead("bash", { command: "cat .pi/skills/foo/SKILL.md" })).toBeNull();
    expect(skillNameFromRead("read", {})).toBeNull();
    expect(skillNameFromRead(undefined, { path: "x/SKILL.md" })).toBeNull();
  });

  it("does not treat a bare root SKILL.md as a skill", () => {
    expect(skillNameFromRead("read", { path: "SKILL.md" })).toBeNull();
    expect(skillNameFromRead("read", { path: "./SKILL.md" })).toBeNull();
  });
});
