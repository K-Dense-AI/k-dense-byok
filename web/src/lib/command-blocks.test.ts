import { describe, expect, it } from "vitest";
import { parseCommandBlock, slashMenuItems } from "@/lib/command-blocks";

describe("parseCommandBlock", () => {
  it("recognizes Pi's skill block with a trailing user message", () => {
    const text = `<skill name="qc-protocol" location="/sb/.pi/skills/qc-protocol/SKILL.md">\nReferences are relative to /sb/.pi/skills/qc-protocol.\n\n# QC\n</skill>\n\nuser_data/a.csv`;
    expect(parseCommandBlock(text)).toEqual({
      kind: "skill",
      name: "qc-protocol",
      body: "References are relative to /sb/.pi/skills/qc-protocol.\n\n# QC",
      tail: "user_data/a.csv",
    });
  });
  it("recognizes Kady's template block and passes plain text through", () => {
    expect(parseCommandBlock('<prompt-template name="qc">\nRun QC on a.csv.\n</prompt-template>')).toEqual({
      kind: "template",
      name: "qc",
      body: "Run QC on a.csv.",
      tail: "",
    });
    expect(parseCommandBlock("just a message")).toBeNull();
    expect(parseCommandBlock("<skill name=\"x\">broken")).toBeNull();
  });
});

describe("slashMenuItems", () => {
  const templates = [
    { name: "qc", description: "Quality control", argumentHint: "<file>" },
    { name: "stats-check", description: "Audit statistics" },
  ];
  const skills = [{ name: "lab-protocol", description: "Wet-lab protocol" }];
  it("lists templates then skills, prefix matches first", () => {
    expect(slashMenuItems("", templates, skills).map((i) => i.command)).toEqual(["/qc", "/stats-check", "/skill:lab-protocol"]);
    expect(slashMenuItems("s", templates, skills).map((i) => i.command)).toEqual(["/stats-check", "/skill:lab-protocol"]);
    expect(slashMenuItems("protocol", templates, skills).map((i) => i.command)).toEqual(["/skill:lab-protocol"]);
    expect(slashMenuItems("zzz", templates, skills)).toEqual([]);
    expect(slashMenuItems("qc", templates, skills)[0]).toMatchObject({ argumentHint: "<file>", kind: "template" });
  });
});
