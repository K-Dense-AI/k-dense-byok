import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileTreePanel } from "./sandbox-panel";
import { TooltipProvider } from "./ui/tooltip";
import type { TreeNode } from "@/lib/use-sandbox";

function renderLargeTree(fileCount = 38_000) {
  const tree: TreeNode = {
    name: "sandbox",
    path: "",
    type: "directory",
    children: [
      {
        name: "dataset",
        path: "dataset",
        type: "directory",
        children: Array.from({ length: fileCount }, (_, index) => ({
          name: `image-${index}.dcm`,
          path: `dataset/image-${index}.dcm`,
          type: "file",
        })),
      },
    ],
  };
  const noop = vi.fn();

  render(
    <TooltipProvider>
      <div style={{ height: 700 }}>
        <FileTreePanel
          tree={tree}
          selectedPath={null}
          uploading={false}
          onSelect={noop}
          onDownload={noop}
          onDelete={noop}
          onDownloadDir={noop}
          onDeleteDir={noop}
          onDownloadAll={noop}
          onRefresh={noop}
          onClose={noop}
          onUpload={noop}
          onMove={noop}
          onRename={noop}
          onCreateDir={noop}
        />
      </div>
    </TooltipProvider>,
  );
}

describe("FileTreePanel", () => {
  it("keeps a 38k-file directory collapsed and virtualizes it when opened", () => {
    renderLargeTree();

    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.queryByText("image-0.dcm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("dataset"));

    expect(screen.getByText("image-0.dcm")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(36);
    expect(screen.queryByText("image-1000.dcm")).not.toBeInTheDocument();
  });
});
