"use client";

import type { OutlineItem } from "@/lib/latex/outline";
import { cn } from "@/lib/utils";
import { HashIcon, ImageIcon, TableIcon } from "lucide-react";
import { memo, useMemo } from "react";

function iconFor(kind: OutlineItem["kind"]) {
  if (kind === "figure") return <ImageIcon className="size-3 shrink-0" />;
  if (kind === "table") return <TableIcon className="size-3 shrink-0" />;
  return <HashIcon className="size-3 shrink-0" />;
}

export const OutlinePanel = memo(function OutlinePanel({
  items,
  currentLine,
  onJump,
}: {
  items: OutlineItem[];
  currentLine: number;
  onJump: (line: number) => void;
}) {
  // The "current" item is the last one at or before the cursor line.
  const currentIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].line <= currentLine) idx = i;
      else break;
    }
    return idx;
  }, [items, currentLine]);

  return (
    <div className="flex w-48 shrink-0 flex-col overflow-hidden border-r bg-muted/10">
      <div className="shrink-0 border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Outline
      </div>
      <div className="flex-1 overflow-auto py-1">
        {items.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/60">
            No sections yet — add a \section to see the outline.
          </p>
        )}
        {items.map((item, i) => (
          <button
            key={`${item.line}:${item.title}`}
            onClick={() => onJump(item.line)}
            className={cn(
              "flex w-full items-center gap-1.5 truncate px-2 py-1 text-left text-[11px] transition-colors hover:bg-muted",
              i === currentIdx ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
            style={{ paddingLeft: `${8 + item.depth * 10}px` }}
            title={item.title}
          >
            {iconFor(item.kind)}
            <span className="truncate">{item.title || "(untitled)"}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
