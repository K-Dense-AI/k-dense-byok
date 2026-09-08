"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, SlashIcon, WandSparklesIcon } from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";
import type { CommandBlock } from "@/lib/command-blocks";
import { cn } from "@/lib/utils";

/**
 * A user message that Kady expanded from `/skill:name` or `/template`: show
 * what the user typed as a chip, the expanded instructions behind a toggle,
 * and the user's own arguments/context below.
 */
export function CommandBlockChip({ block }: { block: CommandBlock }) {
  const [open, setOpen] = useState(false);
  const Icon = block.kind === "skill" ? WandSparklesIcon : SlashIcon;
  const label = block.kind === "skill" ? `Skill: ${block.name}` : `Prompt: /${block.name}`;
  return (
    <div className="flex flex-col gap-1.5" data-command-block={block.kind}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs font-medium",
          "hover:bg-background",
        )}
        aria-expanded={open}
      >
        <Icon className="size-3.5" aria-hidden />
        <span>{label}</span>
        {open ? <ChevronDownIcon className="size-3" aria-hidden /> : <ChevronRightIcon className="size-3" aria-hidden />}
      </button>
      {open && (
        <div className="max-h-72 overflow-auto rounded-md border bg-background/60 px-3 py-2 text-xs">
          <MessageResponse>{block.body}</MessageResponse>
        </div>
      )}
      {block.tail && <MessageResponse>{block.tail}</MessageResponse>}
    </div>
  );
}
