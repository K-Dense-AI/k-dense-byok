import { describe, it, expect } from "vitest";
import { boundedMapSet, boundedSetAdd } from "../src/bounded.ts";

describe("boundedSetAdd", () => {
  it("evicts the oldest insertion instead of clearing the cache", () => {
    const set = new Set<string>();
    for (const id of ["a", "b", "c", "d"]) boundedSetAdd(set, id, 3);
    // Clearing at the limit would have re-admitted everything the set was
    // suppressing (re-ledgering costs, re-harvesting notebook entries).
    expect([...set]).toEqual(["b", "c", "d"]);
  });

  it("refreshes recency on re-add so a hot key survives", () => {
    const set = new Set<string>();
    boundedSetAdd(set, "a", 2);
    boundedSetAdd(set, "b", 2);
    boundedSetAdd(set, "a", 2);
    boundedSetAdd(set, "c", 2);
    expect([...set]).toEqual(["a", "c"]);
  });

  it("treats a non-positive max as 'hold nothing'", () => {
    const set = new Set<string>();
    boundedSetAdd(set, "a", 0);
    expect(set.size).toBe(0);
  });
});

describe("boundedMapSet", () => {
  it("keeps the newest entries up to max", () => {
    const map = new Map<string, number>();
    boundedMapSet(map, "a", 1, 2);
    boundedMapSet(map, "b", 2, 2);
    boundedMapSet(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);
    expect(map.get("c")).toBe(3);
  });

  it("overwrites in place without growing", () => {
    const map = new Map<string, number>();
    boundedMapSet(map, "a", 1, 2);
    boundedMapSet(map, "a", 9, 2);
    expect(map.size).toBe(1);
    expect(map.get("a")).toBe(9);
  });
});
