"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, WandSparklesIcon, XIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Skill } from "@/lib/use-skills";

export type { Skill };

/**
 * Picker UI for skills — no trigger / no popover wrapper.
 */
export function SkillsPickerBody({
  skills,
  selected,
  onChange,
  autoFocus = false,
}: {
  skills: Skill[];
  selected: Skill[];
  onChange: (skills: Skill[]) => void;
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.author.toLowerCase().includes(q)
    );
  }, [skills, search]);

  const toggle = useCallback(
    (skill: Skill) => {
      if (selectedIds.has(skill.id)) {
        onChange(selected.filter((s) => s.id !== skill.id));
      } else {
        onChange([...selected, skill]);
      }
    },
    [selected, selectedIds, onChange]
  );

  const clearAll = useCallback(() => onChange([]), [onChange]);

  useEffect(() => {
    if (autoFocus) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {selected.length > 0 && (
          <button
            onClick={clearAll}
            className="text-[10px] text-muted-foreground hover:text-destructive transition-colors whitespace-nowrap"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No skills found
          </div>
        ) : (
          filtered.map((skill) => {
            const isSelected = selectedIds.has(skill.id);
            return (
              <div
                key={skill.id}
                onClick={() => toggle(skill)}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 px-3 py-2.5 text-xs transition-colors hover:bg-muted/60",
                  isSelected && "bg-muted/40"
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background"
                  )}
                >
                  {isSelected && <CheckIcon className="size-2.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{skill.name}</span>
                    {skill.author && (
                      <span className="text-[10px] text-muted-foreground/60">
                        by {skill.author}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground/80 leading-relaxed">
                    {skill.description}
                  </p>
                  {skill.compatibility && (
                    <span className="mt-1 inline-block rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      {skill.compatibility}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          Expert agent skills
        </span>
        <span className="text-[10px] text-muted-foreground">
          {filtered.length} of {skills.length} skills
        </span>
      </div>
    </>
  );
}

export function SkillsSelector({
  skills,
  selected,
  onChange,
}: {
  skills: Skill[];
  selected: Skill[];
  onChange: (skills: Skill[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const removeSelected = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      onChange(selected.filter((s) => s.id !== id));
    },
    [selected, onChange]
  );

  const clearAll = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange([]);
    },
    [onChange]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs",
            open
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40",
            selected.length > 0 && "border-border"
          )}
          role="button"
          tabIndex={0}
        >
          <WandSparklesIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground select-none whitespace-nowrap">
            {selected.length === 0
              ? "Skills"
              : `${selected.length} skill${selected.length !== 1 ? "s" : ""}`}
          </span>
          {selected.length > 0 && (
            <>
              <span className="mx-0.5 text-border">·</span>
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {selected.slice(0, 3).map((skill) => (
                  <span
                    key={skill.id}
                    className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20"
                  >
                    {skill.name}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => removeSelected(skill.id, e)}
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        removeSelected(skill.id, e as unknown as React.MouseEvent)
                      }
                      className="opacity-60 hover:opacity-100 cursor-pointer"
                    >
                      <XIcon className="size-2.5" />
                    </span>
                  </span>
                ))}
                {selected.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">
                    +{selected.length - 3} more
                  </span>
                )}
              </div>
              <span
                role="button"
                tabIndex={0}
                onClick={clearAll}
                onKeyDown={(e) =>
                  e.key === "Enter" && clearAll(e as unknown as React.MouseEvent)
                }
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <XIcon className="size-3" />
              </span>
            </>
          )}
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform ml-auto",
              open && "rotate-180",
              selected.length > 0 && "hidden"
            )}
          />
        </div>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[420px] max-w-[calc(100vw-2rem)] p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SkillsPickerBody
          skills={skills}
          selected={selected}
          onChange={onChange}
          autoFocus={open}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Build a prompt suffix instructing the agent to use selected skills */
export function buildSkillsContext(selected: Skill[]): string {
  if (selected.length === 0) return "";
  const names = selected.map((s) => `'${s.name}'`).join(", ");
  return `\n\nMake sure to use the skills: ${names}`;
}
