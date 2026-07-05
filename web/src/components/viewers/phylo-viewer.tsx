"use client";
import { useMemo } from "react";
import { parseNewick, type PhyloNode } from "@/lib/newick";
import type { ViewerProps } from "@/lib/viewers/registry";

// Cap the rendered tree so a pathological/huge file doesn't hang the SVG
// layout or the browser — beyond this we show a fallback instead.
const MAX_LEAVES = 500;

const LEAF_SPACING = 20; // px between adjacent leaf rows
const LEFT_MARGIN = 12; // px before the root
const LABEL_GAP = 6; // px between a leaf's branch tip and its label
const TREE_WIDTH = 480; // px reserved for the branch drawing region
const LABEL_WIDTH = 240; // px reserved for leaf labels
const TOP_MARGIN = 12;
const BOTTOM_MARGIN = 12;

function countLeaves(node: PhyloNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

function treeHasLengths(node: PhyloNode): boolean {
  if (node.length != null) return true;
  return node.children.some(treeHasLengths);
}

interface Layout {
  xUnits: Map<PhyloNode, number>;
  yPx: Map<PhyloNode, number>;
  maxXUnits: number;
  leafCount: number;
}

/** Rectangular-cladogram layout: x = cumulative branch length from the root
 *  (or cumulative depth, one unit per level, when the tree carries no branch
 *  lengths at all); leaf y = row order; internal y = mean of children's y. */
function layoutTree(root: PhyloNode): Layout {
  const hasLengths = treeHasLengths(root);
  const xUnits = new Map<PhyloNode, number>();
  const yPx = new Map<PhyloNode, number>();

  xUnits.set(root, 0);
  const assignX = (node: PhyloNode, parentX: number) => {
    for (const child of node.children) {
      const step = hasLengths ? (child.length ?? 0) : 1;
      const x = parentX + step;
      xUnits.set(child, x);
      assignX(child, x);
    }
  };
  assignX(root, 0);

  let leafIndex = 0;
  const assignY = (node: PhyloNode): number => {
    if (node.children.length === 0) {
      const y = leafIndex * LEAF_SPACING + LEAF_SPACING / 2;
      leafIndex += 1;
      yPx.set(node, y);
      return y;
    }
    const childYs = node.children.map(assignY);
    const y = childYs.reduce((a, b) => a + b, 0) / childYs.length;
    yPx.set(node, y);
    return y;
  };
  assignY(root);

  let maxXUnits = 0;
  xUnits.forEach((v) => {
    if (v > maxXUnits) maxXUnits = v;
  });

  return { xUnits, yPx, maxXUnits: maxXUnits || 1, leafCount: leafIndex };
}

interface EdgeSpec {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface LabelSpec {
  key: string;
  x: number;
  y: number;
  text: string;
}

function buildEdgesAndLabels(
  root: PhyloNode,
  layout: Layout,
  scale: number,
): { edges: EdgeSpec[]; labels: LabelSpec[] } {
  const edges: EdgeSpec[] = [];
  const labels: LabelSpec[] = [];
  const px = (units: number) => LEFT_MARGIN + units * scale;

  let counter = 0;
  const walk = (node: PhyloNode, parent: PhyloNode | null) => {
    const id = counter++;
    const x = px(layout.xUnits.get(node) ?? 0);
    const y = layout.yPx.get(node) ?? 0;

    if (parent) {
      const parentX = px(layout.xUnits.get(parent) ?? 0);
      edges.push({ key: `h-${id}`, x1: parentX, y1: y, x2: x, y2: y });
    }

    if (node.children.length > 0) {
      const childYs = node.children.map((c) => layout.yPx.get(c) ?? 0);
      edges.push({
        key: `v-${id}`,
        x1: x,
        y1: Math.min(...childYs),
        x2: x,
        y2: Math.max(...childYs),
      });
      node.children.forEach((c) => walk(c, node));
    } else {
      labels.push({ key: `l-${id}`, x: x + LABEL_GAP, y, text: node.name || "(unnamed)" });
    }
  };
  walk(root, null);
  return { edges, labels };
}

type ParseResult =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; leafCount: number }
  | { status: "ok"; tree: PhyloNode; leafCount: number };

export default function PhyloViewer({ content }: ViewerProps) {
  const result = useMemo<ParseResult>(() => {
    if (content == null) return { status: "loading" };
    try {
      const tree = parseNewick(content);
      const leafCount = countLeaves(tree);
      if (leafCount > MAX_LEAVES) return { status: "too-large", leafCount };
      return { status: "ok", tree, leafCount };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }, [content]);

  if (result.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Couldn&apos;t parse this tree</p>
        <p className="max-w-md text-xs">{result.message}</p>
      </div>
    );
  }

  if (result.status === "too-large") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">Tree too large to render</p>
        <p className="max-w-md text-xs">
          This tree has {result.leafCount.toLocaleString()} leaves, above the {MAX_LEAVES}-leaf
          preview limit.
        </p>
      </div>
    );
  }

  const { tree, leafCount } = result;
  const layout = layoutTree(tree);
  const scale = TREE_WIDTH / layout.maxXUnits;
  const { edges, labels } = buildEdgesAndLabels(tree, layout, scale);
  const width = LEFT_MARGIN + TREE_WIDTH + LABEL_WIDTH;
  const height = Math.max(leafCount * LEAF_SPACING, LEAF_SPACING) + TOP_MARGIN + BOTTOM_MARGIN;

  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-2 text-xs text-muted-foreground">
        {leafCount.toLocaleString()} leaf{leafCount !== 1 ? "s" : ""}
      </p>
      <svg
        role="img"
        aria-label="Phylogenetic tree"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <g transform={`translate(0, ${TOP_MARGIN})`}>
          {edges.map((e) => (
            <line
              key={e.key}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="currentColor"
              strokeWidth={1}
              className="text-muted-foreground"
            />
          ))}
          {labels.map((l) => (
            <text key={l.key} x={l.x} y={l.y} dominantBaseline="middle" fontSize={11} className="fill-current">
              {l.text}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
