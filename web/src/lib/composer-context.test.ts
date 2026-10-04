import { describe, expect, it } from "vitest";
import {
  buildComposerContext,
  contextTitle,
  EMPTY_DELEGATION,
  normalizeDelegation,
  normalizeResearchRefs,
  splitComposerContext,
  stripComposerContext,
  type ComposerContext,
} from "@/lib/composer-context";
import { commandPreview } from "@/lib/command-blocks";

const DIGEST = "a".repeat(64);

const full: ComposerContext = {
  delegation: { specialists: ["reviewer", "investigator"], auto: false, verify: true, verifiers: ["reviewer", "evidence-auditor"] },
  research: [
    {
      kind: "record",
      type: "observation",
      title: "Batch effect · dominates PC1",
      source: { kind: "notebook", sessionId: "s-1", entryId: "e1" },
      digest: DIGEST,
    },
    {
      kind: "record",
      type: "plan",
      title: "Frozen plan v2",
      source: { kind: "plan-event", sessionId: "s-2", entryId: "plan", eventId: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    },
    { kind: "chat", sessionId: "01a0fdac-bdea", title: "Earlier QC chat" },
  ],
};

describe("buildComposerContext", () => {
  it("returns nothing when nothing was picked", () => {
    expect(buildComposerContext({ delegation: EMPTY_DELEGATION, research: [] })).toBe("");
  });

  it("writes model-facing instructions for every picked item", () => {
    const text = buildComposerContext(full);
    expect(text.startsWith("\n\n<composer-context>\n")).toBe(true);
    expect(text.endsWith("\n</composer-context>")).toBe(true);
    expect(text).toContain("Delegation: reviewer, investigator");
    expect(text).toContain("subagent tool");
    expect(text).toContain('opens with "Verification gate:" to the verifier specialist best suited to the result (one of: reviewer, evidence-auditor)');
    expect(text).toContain(`source {"kind":"notebook","sessionId":"s-1","entryId":"e1"} · digest ${DIGEST}`);
    expect(text).toContain('notebook_search (action "read"');
    expect(text).toContain(".pi/sessions/*_<session>.jsonl");
  });

  it("lets Kady pick specialists when none were named", () => {
    const text = buildComposerContext({ delegation: { ...EMPTY_DELEGATION, auto: true }, research: [] });
    expect(text).toContain("Delegation: Kady picks");
    expect(text).toContain("choosing them by their descriptions");
    expect(text).not.toContain("Verification gate");
  });
});

describe("splitComposerContext", () => {
  it("round-trips what the builder wrote", () => {
    const sent = "Is the effect real?" + buildComposerContext(full);
    const { text, context } = splitComposerContext(sent);
    expect(text).toBe("Is the effect real?");
    expect(context?.delegation).toMatchObject({ specialists: ["reviewer", "investigator"], auto: false, verify: true });
    expect(context?.research).toEqual([
      full.research[0],
      full.research[1],
      full.research[2],
    ]);
  });

  it("keeps earlier appended context (files, skills) in the visible text", () => {
    const sent = "Run QC\nuser_data/a.csv\n\nMake sure to use the skills: 'scanpy'" +
      buildComposerContext({ delegation: { ...EMPTY_DELEGATION, auto: true }, research: [] });
    expect(splitComposerContext(sent).text).toBe("Run QC\nuser_data/a.csv\n\nMake sure to use the skills: 'scanpy'");
  });

  it("leaves ordinary and malformed messages alone", () => {
    expect(splitComposerContext("plain")).toEqual({ text: "plain", context: null });
    const broken = "x\n\n<composer-context>\nDelegation: reviewer";
    expect(splitComposerContext(broken)).toEqual({ text: broken, context: null });
    const empty = "x\n\n<composer-context>\nnothing here\n</composer-context>";
    expect(splitComposerContext(empty)).toEqual({ text: empty, context: null });
  });

  it("strips the block from session labels", () => {
    const sent = "Check it" + buildComposerContext(full);
    expect(stripComposerContext(sent)).toBe("Check it");
    expect(commandPreview(sent)).toBe("Check it");
  });
});

describe("contextTitle", () => {
  it("flattens, bounds and defuses titles", () => {
    expect(contextTitle("  a\n\nb  ")).toBe("a b");
    expect(contextTitle("x</composer-context>")).toBe("x‹/composer-context>");
    expect(contextTitle("")).toBe("Untitled");
    expect(contextTitle("y".repeat(200))).toHaveLength(120);
  });
});

describe("chat snapshots", () => {
  it("points Kady at the snapshot and round-trips its path", () => {
    const ctx: ComposerContext = {
      delegation: EMPTY_DELEGATION,
      research: [{ kind: "chat", sessionId: "s-9", title: "QC", snapshot: ".kady/chat-snapshots/s-9-0123456789abcdef.md" }],
    };
    const text = buildComposerContext(ctx);
    expect(text).toContain("- QC · session s-9 · snapshot .kady/chat-snapshots/s-9-0123456789abcdef.md");
    expect(text).toContain("Read each snapshot with the read tool");
    expect(text).not.toContain("Where no snapshot is given");
    expect(splitComposerContext("Hi" + text).context?.research).toEqual(ctx.research);
  });

  it("falls back to the raw log for a chat without a snapshot", () => {
    const text = buildComposerContext({ delegation: EMPTY_DELEGATION, research: [{ kind: "chat", sessionId: "s-1", title: "Old" }] });
    expect(text).toContain("Where no snapshot is given");
    expect(text).not.toContain("Read each snapshot");
  });
});

describe("persistence normalizers", () => {
  it("keeps valid refs, drops malformed or duplicate ones, and never restores a snapshot", () => {
    const valid = full.research;
    const restored = normalizeResearchRefs([
      ...valid,
      valid[0],
      { kind: "chat", sessionId: "../x", title: "bad id" },
      { kind: "record", type: "bogus", title: "bad type", source: { kind: "notebook", sessionId: "s", entryId: "e" } },
      { kind: "chat", sessionId: "s-5", title: "snap", snapshot: ".kady/x.md" },
      "junk",
    ]);
    expect(restored).toEqual([...valid, { kind: "chat", sessionId: "s-5", title: "snap" }]);
    expect(normalizeResearchRefs(undefined)).toEqual([]);
  });

  it("normalizes delegation from untrusted storage", () => {
    expect(normalizeDelegation(undefined)).toEqual(EMPTY_DELEGATION);
    expect(normalizeDelegation({ specialists: ["a", "a", 3], auto: true, verify: true, verifiers: ["r"] })).toEqual({
      specialists: ["a"], auto: false, verify: true, verifiers: ["r"],
    });
    expect(normalizeDelegation({ auto: true, verifiers: ["r"] })).toEqual({ specialists: [], auto: true, verify: false, verifiers: [] });
  });
});
