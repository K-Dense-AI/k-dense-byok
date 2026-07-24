import { describe, expect, it } from "vitest";

import { normalizeMarkdown } from "./markdown-text";

describe("normalizeMarkdown", () => {
  it("keeps currency amounts literal", () => {
    expect(normalizeMarkdown("limit reached ($0.07 / $0.05).")).toBe(
      "limit reached (\\$0.07 / \\$0.05).",
    );
    expect(normalizeMarkdown("that run cost $0.42")).toBe("that run cost \\$0.42");
  });

  it("keeps currency literal even when real math follows", () => {
    expect(
      normalizeMarkdown("cost $0.07 of the $0.05 cap, and $x$ is math."),
    ).toBe("cost \\$0.07 of the \\$0.05 cap, and $x$ is math.");
  });

  it("leaves inline math alone", () => {
    expect(normalizeMarkdown("the term $E = mc^2$ holds")).toBe(
      "the term $E = mc^2$ holds",
    );
    expect(normalizeMarkdown("$a$ and $b$")).toBe("$a$ and $b$");
  });

  it("leaves display math alone", () => {
    expect(normalizeMarkdown("$$\n\\sum_i x_i\n$$")).toBe("$$\n\\sum_i x_i\n$$");
  });

  it("does not touch dollars inside code", () => {
    expect(normalizeMarkdown("run `echo $HOME` first")).toBe("run `echo $HOME` first");
    expect(normalizeMarkdown("```\ncost=$5 and $6\n```")).toBe(
      "```\ncost=$5 and $6\n```",
    );
  });

  it("escapes an opener whose partner is a paragraph away", () => {
    expect(normalizeMarkdown("costs $5\n\nand $6 more")).toBe(
      "costs \\$5\n\nand \\$6 more",
    );
  });

  it("keeps an already-escaped dollar single", () => {
    expect(normalizeMarkdown("\\$5 flat")).toBe("\\$5 flat");
  });

  it("separates a heading glued to the previous line", () => {
    expect(normalizeMarkdown("…by condition:## Results")).toBe(
      "…by condition:\n\n## Results",
    );
  });
});
