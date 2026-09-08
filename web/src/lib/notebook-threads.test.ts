import { describe, it, expect } from "vitest";
import { deriveThreads } from "./notebook-threads";
import { notebookEntryKey, type NotebookEntry } from "./notebook";
const e = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry => ({ id, type: "note", title: id, timestamp: 0, ...over });
const h = e("h", { type: "hypothesis", timestamp: 1 });
const support = e("s", { type: "observation", timestamp: 2, relatesTo: "h", stance: "supports" });
const challenge = e("c", { type: "observation", timestamp: 3, relatesTo: "h", stance: "refutes" });

describe("evidence-aware threads", () => {
  it("handles empty and untested notebooks", () => {
    expect(deriveThreads([]).size).toBe(0);
    expect(deriveThreads([h]).get("h")?.status).toBe("open");
  });
  it("retains contradictory evidence rather than choosing the last author", () => {
    for (const order of [[h, support, challenge], [challenge, h, support]]) {
      expect(deriveThreads(order).get("h")?.status).toBe("mixed");
      expect(deriveThreads(order).get("h")?.activeEvidence).toHaveLength(2);
    }
  });
  it("does not change conflict status on timestamp ties", () => {
    expect(deriveThreads([h, support, { ...challenge, timestamp: 2 }]).get("h")?.status).toBe("mixed");
  });
  it("keeps support/challenge as authored evidence, not a final truth verdict", () => {
    expect(deriveThreads([h, support]).get("h")?.status).toBe("supported");
    expect(deriveThreads([h, challenge]).get("h")?.status).toBe("refuted");
  });
  it("supports multiple typed links and deduplicates legacy equivalents", () => {
    const h2 = e("h2", { type: "hypothesis" });
    const s = { ...support, evidence: [
      { entryId: "h", relation: "supports" as const },
      { entryId: "h2", relation: "inconclusive" as const },
      { entryId: "h", relation: "supports" as const },
    ] };
    const threads = deriveThreads([h, h2, s]);
    expect(threads.get("h")?.activeEvidence).toHaveLength(1);
    expect(threads.get("h2")?.status).toBe("inconclusive");
  });
  it("technical failures never become negative scientific evidence", () => {
    expect(deriveThreads([h, { ...challenge, outcome: "technical-failure" }]).get("h")?.status).toBe("open");
    expect(deriveThreads([h, { ...challenge, outcome: "inconclusive" }]).get("h")?.status).toBe("inconclusive");
    expect(deriveThreads([h, e("null", { outcome: "null", relatesTo: "h" })]).get("h")?.status).toBe("open");
  });
  it("superseded observations retire, without silently inheriting their links", () => {
    const correction = e("fix", { timestamp: 4, supersedes: "c" });
    const threads = deriveThreads([h, support, challenge, correction]);
    expect(threads.get("c")?.supersededBy).toBe("fix");
    expect(threads.get("h")?.incoming).toHaveLength(2);
    expect(threads.get("h")?.activeEvidence).toHaveLength(1);
    expect(threads.get("h")?.status).toBe("supported");
  });
  it("uses append order, not tool-id alphabetization, for same-millisecond amendments", () => {
    const old = { ...support, id: "zzz", timestamp: 2 };
    const amendment = e("aaa", { timestamp: 2, supersedes: "zzz" });
    expect(deriveThreads([h, old, amendment]).get("h")?.status).toBe("open");
  });

  it("never counts provisional evidence or lets unsaved amendments retire recorded findings", () => {
    const pending = { ...challenge, provisional: true };
    const amendment = e("pending-fix", { timestamp: 4, supersedes: "s", provisional: true });
    const threads = deriveThreads([h, support, pending, amendment]);
    expect(threads.get("h")).toMatchObject({ status: "supported", pendingEvidence: 1 });
    expect(threads.get("s")?.supersededBy).toBeUndefined();
    expect(deriveThreads([h, pending]).get("h")?.status).toBe("open");
  });

  it("amendment chains do not resurrect older evidence", () => {
    const a = e("a", { timestamp: 4, supersedes: "s" });
    const b = e("b", { timestamp: 5, supersedes: "a" });
    expect(deriveThreads([h, support, a, b]).get("h")?.status).toBe("open");
  });
  it("rejects self, dangling and backward supersession links without loops", () => {
    const threads = deriveThreads([h, { ...support, supersedes: "c" }, { ...challenge, supersedes: "s" }, e("self", { relatesTo: "self", supersedes: "self" }), e("dangling", { relatesTo: "gone" })]);
    expect(threads.get("c")?.supersededBy).toBeUndefined();
    expect(threads.get("s")?.supersededBy).toBe("c");
    expect(threads.get("self")?.unresolvedLinks).toBe(2);
    expect(threads.get("gone")).toBeUndefined();
  });
  it("isolates duplicate raw ids across project chats, with explicit cross-chat links", () => {
    const a = { ...h, sessionId: "a" };
    const b = { ...h, sessionId: "b" };
    const local = { ...support, sessionId: "a" };
    const cross = e("x", { sessionId: "b", evidence: [{ entryId: "h", sessionId: "a", relation: "challenges" }] });
    const threads = deriveThreads([a, b, local, cross]);
    expect(threads.get(notebookEntryKey(a))?.status).toBe("mixed");
    expect(threads.get(notebookEntryKey(b))?.status).toBe("open");
  });
  it("propagates direct evidence warnings without changing the scientific status", () => {
    const stale = { ...support, artifactHealth: [{ path: "fig.png", status: "changed" as const, checkedAt: 4 }] };
    const threads = deriveThreads([h, stale]);
    expect(threads.get("h")).toMatchObject({ status: "supported", reviewRequired: true });
    expect(deriveThreads([h, stale, e("fix", { timestamp: 5, supersedes: "s" })]).get("h")?.reviewRequired).toBe(false);
  });
  it("counts unknown checks but never promotes them to unchanged", () => {
    expect(deriveThreads([h, { ...support, artifactHealth: [{ path: "fig.png", status: "unverified", checkedAt: 4 }] }]).get("h")).toMatchObject({ status: "supported", reviewRequired: false, unverifiedArtifacts: 1 });
  });
  it("only assigns scientific status to hypotheses", () => {
    expect(deriveThreads([support]).get("s")?.status).toBeUndefined();
  });
});
