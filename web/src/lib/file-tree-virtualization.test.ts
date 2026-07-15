import { describe, expect, it } from "vitest";

import {
  FILE_TREE_ROW_HEIGHT,
  flattenVisibleTree,
  virtualTreeRange,
} from "./file-tree-virtualization";
import type { TreeNode } from "./use-sandbox";

function largeTree(fileCount: number): TreeNode[] {
  return [
    {
      name: "dataset",
      path: "dataset",
      type: "directory",
      children: Array.from({ length: fileCount }, (_, index) => ({
        name: `image-${index}.dcm`,
        path: `dataset/image-${index}.dcm`,
        type: "file" as const,
      })),
    },
  ];
}

describe("file tree virtualization", () => {
  it("keeps large directory contents out of the visible rows until expanded", () => {
    const nodes = largeTree(38_000);

    expect(flattenVisibleTree(nodes, new Set())).toHaveLength(1);
    expect(flattenVisibleTree(nodes, new Set(["dataset"]))).toHaveLength(38_001);
  });

  it("mounts only a bounded viewport slice from a large expanded tree", () => {
    const rowCount = 38_001;
    const range = virtualTreeRange(
      rowCount,
      20_000 * FILE_TREE_ROW_HEIGHT,
      560,
    );

    expect(range.end - range.start).toBeLessThanOrEqual(36);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(rowCount);
    expect(range.totalHeight).toBe(rowCount * FILE_TREE_ROW_HEIGHT);
  });

  it("inserts create-folder rows only inside visible branches", () => {
    const nodes = largeTree(2);

    expect(flattenVisibleTree(nodes, new Set(), "dataset")).toHaveLength(1);
    expect(flattenVisibleTree(nodes, new Set(["dataset"]), "dataset")).toEqual([
      { kind: "node", node: nodes[0], depth: 0 },
      { kind: "create", parentPath: "dataset", depth: 1 },
      { kind: "node", node: nodes[0].children?.[0], depth: 1 },
      { kind: "node", node: nodes[0].children?.[1], depth: 1 },
    ]);
  });
});
