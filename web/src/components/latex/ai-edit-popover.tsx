"use client";

import { LoaderCircleIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function AiEditPopover({
  anchor,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  anchor: { x: number; y: number };
  busy: boolean;
  error: string | null;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus on mount and again when a request settles — `disabled={busy}` blurs
  // the input, which would otherwise leave the keyboard dead after an error.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);
  // Escape must cancel even while busy: the disabled input receives no
  // keydown events, so listen at the window instead of on the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed z-50 w-80 rounded-lg border bg-background p-2 shadow-xl"
      style={{
        left: Math.min(anchor.x, window.innerWidth - 340),
        top: Math.min(anchor.y + 8, window.innerHeight - 120),
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim() && !busy) onSubmit(instruction.trim());
        }}
        className="flex items-center gap-1.5"
      >
        <SparklesIcon className="size-3.5 shrink-0 text-violet-500" />
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Edit selection… e.g. “convert to a booktabs table”"
          disabled={busy}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <button type="submit" className="rounded bg-violet-600 px-2 py-0.5 text-[11px] text-white hover:bg-violet-700">
            Go
          </button>
        )}
        <button type="button" onClick={onCancel} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <XIcon className="size-3" />
        </button>
      </form>
      {error && <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
