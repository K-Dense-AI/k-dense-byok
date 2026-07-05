"use client";

import {
  PdfViewer,
  type PdfSyncClick,
  type PdfSyncHighlight,
} from "@/components/pdf-viewer/pdf-viewer";
import { FileTextIcon } from "lucide-react";
import { memo } from "react";

export const LatexPdfPane = memo(function LatexPdfPane({
  pdfPath,
  reloadToken,
  syncHighlight,
  onSyncClick,
  modKey,
}: {
  pdfPath: string | null;
  reloadToken: number;
  syncHighlight: PdfSyncHighlight | null;
  onSyncClick: (pos: PdfSyncClick) => void;
  modKey: string;
}) {
  if (!pdfPath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/50">
          <FileTextIcon className="size-6 text-muted-foreground/30" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">No PDF yet</p>
          <p className="text-xs text-muted-foreground/60">
            Press{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              {modKey}↵
            </kbd>{" "}
            to compile
          </p>
        </div>
      </div>
    );
  }
  return (
    <PdfViewer
      path={pdfPath}
      reloadToken={reloadToken}
      syncHighlight={syncHighlight}
      onSyncClick={onSyncClick}
      hideAnnotationUi
      className="flex-1 min-h-0"
    />
  );
});
