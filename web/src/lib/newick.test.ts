import { describe, it, expect } from "vitest";
import { parseNewick, type PhyloNode } from "./newick";

function findByName(node: PhyloNode, name: string): PhyloNode | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}

function leafNames(node: PhyloNode): string[] {
  if (node.children.length === 0) return [node.name];
  return node.children.flatMap(leafNames);
}

describe("parseNewick", () => {
  it("parses nested parens with names and branch lengths", () => {
    const root = parseNewick("(A:1,(B:2,C:3):4);");
    expect(root.children).toHaveLength(2);
    expect(leafNames(root).sort()).toEqual(["A", "B", "C"]);
    const b = findByName(root, "B");
    expect(b?.length).toBe(2);
  });

  it("parses a simple two-leaf tree without an internal branch length", () => {
    const root = parseNewick("(A,B);");
    expect(root.children).toHaveLength(2);
    expect(root.children.map((c) => c.name)).toEqual(["A", "B"]);
    expect(root.children[0].length).toBeNull();
  });

  it("handles deeper nesting and mixed branch lengths", () => {
    const root = parseNewick("((A:1,B:2):3,(C:4,D:5):6);");
    expect(leafNames(root).sort()).toEqual(["A", "B", "C", "D"]);
    expect(findByName(root, "D")?.length).toBe(5);
  });

  it("handles a lone unparenthesized leaf", () => {
    const root = parseNewick("A;");
    expect(root.name).toBe("A");
    expect(root.children).toEqual([]);
  });

  it("tolerates a missing trailing semicolon", () => {
    const root = parseNewick("(A,B)");
    expect(root.children).toHaveLength(2);
  });

  it("tolerates surrounding/interior whitespace and newlines", () => {
    const root = parseNewick("(\n  A:1,\n  B:2\n);\n");
    expect(leafNames(root).sort()).toEqual(["A", "B"]);
  });

  it("strips NHX-style bracket comments", () => {
    const root = parseNewick("(A:1[&&NHX:S=x],B:2):3;");
    expect(leafNames(root).sort()).toEqual(["A", "B"]);
  });

  it("throws on unbalanced parentheses", () => {
    expect(() => parseNewick("(A,B,(C,D);")).toThrow();
  });

  it("throws on an invalid branch length", () => {
    expect(() => parseNewick("(A:xyz,B:2);")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => parseNewick("")).toThrow();
    expect(() => parseNewick("   ")).toThrow();
  });

  it("throws on trailing garbage after a complete tree", () => {
    expect(() => parseNewick("(A,B);extra")).toThrow();
  });
});
