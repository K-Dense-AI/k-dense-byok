import { describe, it, expect } from "vitest";
import {
  EMPTY_FILTERS,
  isFiltering,
  filterEntries,
  countByType,
  agentAccent,
  roleLabel,
} from "./notebook-filters";
import type { NotebookEntry, NotebookEntryType } from "./notebook";

const e = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id,
  type: "note",
  title: id,
  timestamp: 0,
  ...over,
});

const none = new Set<string>();

describe("isFiltering", () => {
  it("is false for the empty filter state", () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
  });

  it("is false for a whitespace-only query", () => {
    expect(isFiltering({ ...EMPTY_FILTERS, query: "   " })).toBe(false);
  });

  it("is true when a type, query, or pinnedOnly is set", () => {
    expect(isFiltering({ ...EMPTY_FILTERS, types: new Set<NotebookEntryType>(["note"]) })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, query: "x" })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, pinnedOnly: true })).toBe(true);
  });
});

describe("filterEntries", () => {
  const entries = [
    e("h1", { type: "hypothesis", title: "Six cell types", tags: ["scRNA"] }),
    e("o1", { type: "observation", title: "Peak at 42", body: "Clear UMAP separation" }),
    e("n1", { type: "note", title: "Reminder" }),
  ];

  it("passes everything through with empty filters", () => {
    expect(filterEntries(entries, EMPTY_FILTERS, none)).toEqual(entries);
  });

  it("treats an empty types set as all types, and filters when non-empty", () => {
    const out = filterEntries(
      entries,
      { ...EMPTY_FILTERS, types: new Set<NotebookEntryType>(["hypothesis", "note"]) },
      none,
    );
    expect(out.map((x) => x.id)).toEqual(["h1", "n1"]);
  });

  it("matches the query case-insensitively over title, body, and tags", () => {
    expect(
      filterEntries(entries, { ...EMPTY_FILTERS, query: "SIX CELL" }, none).map((x) => x.id),
    ).toEqual(["h1"]);
    expect(
      filterEntries(entries, { ...EMPTY_FILTERS, query: "umap" }, none).map((x) => x.id),
    ).toEqual(["o1"]);
    expect(
      filterEntries(entries, { ...EMPTY_FILTERS, query: "scrna" }, none).map((x) => x.id),
    ).toEqual(["h1"]);
    expect(filterEntries(entries, { ...EMPTY_FILTERS, query: "nothing" }, none)).toEqual([]);
  });

  it("keeps only pinned entries when pinnedOnly is set", () => {
    const out = filterEntries(entries, { ...EMPTY_FILTERS, pinnedOnly: true }, new Set(["o1"]));
    expect(out.map((x) => x.id)).toEqual(["o1"]);
  });

  it("combines type, query, and pinned filters", () => {
    const out = filterEntries(
      entries,
      { types: new Set<NotebookEntryType>(["hypothesis"]), query: "six", pinnedOnly: true },
      new Set(["h1"]),
    );
    expect(out.map((x) => x.id)).toEqual(["h1"]);
  });
});

describe("countByType", () => {
  it("returns zero for every type on an empty list", () => {
    expect(countByType([])).toEqual({
      hypothesis: 0,
      method: 0,
      observation: 0,
      decision: 0,
      note: 0,
    });
  });

  it("counts entries per type", () => {
    const counts = countByType([
      e("a", { type: "hypothesis" }),
      e("b", { type: "hypothesis" }),
      e("c", { type: "observation" }),
    ]);
    expect(counts.hypothesis).toBe(2);
    expect(counts.observation).toBe(1);
    expect(counts.note).toBe(0);
  });
});

describe("agentAccent", () => {
  it("is deterministic for the same role", () => {
    expect(agentAccent("literature-scout")).toEqual(agentAccent("literature-scout"));
  });

  it("reserves a fixed slot for the lead agent", () => {
    expect(agentAccent("agent")).toEqual(agentAccent("agent"));
    // Subagents hash into the remaining slots, never the lead's.
    for (const name of ["literature-scout", "stats-checker", "a", "zz", "kady"]) {
      expect(agentAccent(name)).not.toEqual(agentAccent("agent"));
    }
  });

  it("gives 'you' the reserved amber slot, distinct from the lead", () => {
    const you = agentAccent("you");
    expect(you.dot).toContain("amber");
    expect(you).not.toEqual(agentAccent("agent"));
  });
});

describe("roleLabel", () => {
  it("maps the lead role and the user role to display names", () => {
    expect(roleLabel("agent")).toBe("Kady (lead)");
    expect(roleLabel("you")).toBe("You");
  });

  it("passes subagent names through unchanged", () => {
    expect(roleLabel("literature-scout")).toBe("literature-scout");
  });
});
