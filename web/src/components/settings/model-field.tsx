"use client";

/**
 * A model picker for settings forms: the composer's picker list behind a
 * form-styled trigger, storing a canonical `provider/model` ref string.
 * Optional "inherit" choice (empty value) and a free-text escape hatch for
 * refs the catalogue does not list (private endpoints, newer models).
 */

import { useMemo, useState } from "react";
import { ChevronDownIcon, PencilIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModelPickerList } from "@/components/model-selector";
import { useModels } from "@/lib/use-models";
import { cn } from "@/lib/utils";

export function ModelField({
  id,
  label,
  value,
  onChange,
  emptyLabel,
  disabled,
  className,
}: {
  id?: string;
  /** Accessible name of the field (the visible label lives with the caller). */
  label: string;
  /** Canonical model ref, or "" for the empty/inherit choice. */
  value: string;
  onChange: (value: string) => void;
  /** When set, offers an explicit "no model" choice with this label. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState(value);
  const { models, modelAvailability } = useModels();
  const selected = useMemo(() => models.find((model) => model.id === value) ?? null, [models, value]);
  const availability = value ? modelAvailability({ id: value }) : "available";

  if (manual) {
    const commit = () => {
      const next = draft.trim();
      setManual(false);
      if (next !== value) onChange(next);
    };
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Input
          id={id}
          aria-label={label}
          autoFocus
          value={draft}
          placeholder="provider/model-id"
          className="h-8 font-mono text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value);
              setManual(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            aria-label={`${label}: ${value ? (selected?.label ?? value) : (emptyLabel ?? "none")}`}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2.5 text-left text-xs hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
              {value ? (selected?.label ?? <code className="font-mono">{value}</code>) : (emptyLabel ?? "Choose a model")}
            </span>
            {value && selected ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{selected.provider}</span>
            ) : null}
            {availability === "unavailable" ? (
              <span className="shrink-0 text-[10px] font-medium text-destructive">disconnected</span>
            ) : null}
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {emptyLabel ? (
            <button
              type="button"
              className={cn(
                "w-full border-b px-3 py-2 text-left text-xs hover:bg-muted/60",
                !value && "bg-muted/40 font-medium",
              )}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              {emptyLabel}
            </button>
          ) : null}
          <ModelPickerList
            selected={selected}
            excludeFusion
            compact
            onSelect={(model) => {
              onChange(model.id);
              setOpen(false);
            }}
            onNavigate={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        disabled={disabled}
        aria-label={`Type a model id for ${label}`}
        title="Type a model id"
        onClick={() => {
          setDraft(value);
          setManual(true);
        }}
      >
        <PencilIcon className="size-3.5" />
      </Button>
    </div>
  );
}
