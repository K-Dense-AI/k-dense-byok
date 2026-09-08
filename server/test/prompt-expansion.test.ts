/**
 * Slash-command expansion: parity with Pi's argument handling, the skill block
 * Pi's own parser accepts, first-line-only semantics, and passthrough.
 */
import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import {
  expandLeadingCommand,
  hasArgumentPlaceholder,
  parseCommandArgs,
  substituteArgs,
} from "../src/agent/prompt-expansion.ts";

describe("parseCommandArgs / substituteArgs (Pi parity)", () => {
  it("splits on whitespace, groups quotes, removes them", () => {
    expect(parseCommandArgs(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(parseCommandArgs("")).toEqual([]);
  });
  it("substitutes positional, all, default and slice forms", () => {
    const args = ["one", "two", "three"];
    expect(substituteArgs("$1|$2|$3|$4", args)).toBe("one|two|three|");
    expect(substituteArgs("$@ / $ARGUMENTS", args)).toBe("one two three / one two three");
    expect(substituteArgs("${2:-dflt} ${9:-dflt} ${@:-none}", args)).toBe("two dflt one two three");
    expect(substituteArgs("${@:-none}", [])).toBe("none");
    expect(substituteArgs("${@:2} | ${@:1:2} | ${@:0}", args)).toBe("two three | one two | one two three");
    expect(hasArgumentPlaceholder("no placeholders here")).toBe(false);
    expect(hasArgumentPlaceholder("use $1")).toBe(true);
  });
});

const skills = [{ name: "qc-protocol", filePath: "/sb/.pi/skills/qc-protocol/SKILL.md", baseDir: "/sb/.pi/skills/qc-protocol" }];
const templates = [
  { name: "qc", content: "Run QC on `$1` and write derived/qc.md." },
  { name: "review", content: "Review the methods used so far." },
];
const readFile = () => "---\nname: qc-protocol\ndescription: QC\n---\n\n# QC protocol\n\nStep one.\n";

describe("expandLeadingCommand", () => {
  it("expands a skill command to Pi's exact skill block, args after it, composer tail last", () => {
    const text = "/skill:qc-protocol user_data/a.csv\n/path/to/ref.md\n\nMake sure to use the skills: 'x'";
    const out = expandLeadingCommand(text, { skills, templates, readFile });
    expect(out.kind).toBe("skill");
    expect(out.text).toBe(
      `<skill name="qc-protocol" location="/sb/.pi/skills/qc-protocol/SKILL.md">\nReferences are relative to /sb/.pi/skills/qc-protocol.\n\n# QC protocol\n\nStep one.\n</skill>` +
        `\n\nuser_data/a.csv\n\n/path/to/ref.md\n\nMake sure to use the skills: 'x'`,
    );
    // Pi's own parser reads it back.
    const parsed = parseSkillBlock(`<skill name="qc-protocol" location="/sb/.pi/skills/qc-protocol/SKILL.md">\nReferences are relative to /sb/.pi/skills/qc-protocol.\n\n# QC protocol\n\nStep one.\n</skill>\n\nuser_data/a.csv`);
    expect(parsed).toMatchObject({ name: "qc-protocol", userMessage: "user_data/a.csv" });
  });

  it("expands a template with substitution, appends unused args, wraps in a chip block", () => {
    const withArg = expandLeadingCommand("/qc user_data/a.csv", { skills, templates, readFile });
    expect(withArg).toMatchObject({ kind: "template", name: "qc", args: "user_data/a.csv" });
    expect(withArg.text).toBe('<prompt-template name="qc">\nRun QC on `user_data/a.csv` and write derived/qc.md.\n</prompt-template>');

    const noPlaceholder = expandLeadingCommand("/review focus on the batch effect\nextra line", { skills, templates, readFile });
    expect(noPlaceholder.text).toBe(
      '<prompt-template name="review">\nReview the methods used so far.\n\nfocus on the batch effect\n</prompt-template>\n\nextra line',
    );
  });

  it("only treats the first line as a command and passes unknown commands through", () => {
    for (const text of ["/unknown thing", "hello /qc x", "/skill:missing a", "  /qc a", "/", "//qc"]) {
      expect(expandLeadingCommand(text, { skills, templates, readFile })).toEqual({ kind: "none", text });
    }
    const multi = "plain first line\n/qc a.csv";
    expect(expandLeadingCommand(multi, { skills, templates, readFile }).text).toBe(multi);
  });

  it("passes through when the skill file cannot be read", () => {
    const failing = () => {
      throw new Error("gone");
    };
    expect(expandLeadingCommand("/skill:qc-protocol x", { skills, templates, readFile: failing })).toEqual({
      kind: "none",
      text: "/skill:qc-protocol x",
    });
  });
});
