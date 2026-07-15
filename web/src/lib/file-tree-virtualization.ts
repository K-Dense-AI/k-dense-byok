import type { TreeNode } from "@/lib/use-sandbox";

export const FILE_TREE_ROW_HEIGHT = 28;
export const FILE_TREE_OVERSCAN = 8;

export type VisibleTreeRow =
  | {
      kind: "node";
      node: TreeNode;
      depth: number;
    }
  | {
      kind: "create";
      parentPath: string;
      depth: number;
    };

/**
 * Flatten only expanded branches. The server keeps returning the complete tree
 * so file mentions and open-tab reconciliation still work, while the browser
 * renders a small, virtualized list of visible rows.
 */
export function flattenVisibleTree(
  nodes: TreeNode[],
  expandedPaths: ReadonlySet<string>,
  creatingDirIn: string | null = null,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  if (creatingDirIn === "") {
    rows.push({ kind: "create", parentPath: "", depth: 0 });
  }

  const visit = (siblings: TreeNode[], depth: number) => {
    for (const node of siblings) {
      rows.push({ kind: "node", node, depth });
      if (node.type !== "directory" || !expandedPaths.has(node.path)) continue;
      if (creatingDirIn === node.path) {
        rows.push({ kind: "create", parentPath: node.path, depth: depth + 1 });
      }
      visit(node.children ?? [], depth + 1);
    }
  };

  visit(nodes, 0);
  return rows;
}

export interface VirtualTreeRange {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function virtualTreeRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = FILE_TREE_ROW_HEIGHT,
  overscan = FILE_TREE_OVERSCAN,
): VirtualTreeRange {
  const safeHeight = Math.max(rowHeight, viewportHeight);
  const visibleCount = Math.ceil(safeHeight / rowHeight);
  const requestedStart = Math.max(
    0,
    Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan,
  );
  const start = Math.min(requestedStart, Math.max(0, rowCount - visibleCount));
  const end = Math.min(rowCount, start + visibleCount + overscan * 2);

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: rowCount * rowHeight,
  };
}
