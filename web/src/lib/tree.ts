import type { TreeNode } from "@/lib/use-sandbox";

export function flattenFiles(node: TreeNode | null): string[] {
  if (!node) return [];
  const paths: string[] = [];
  function walk(current: TreeNode) {
    if (current.type === "file") paths.push(current.path);
    for (const child of current.children ?? []) walk(child);
  }
  walk(node);
  return paths;
}
