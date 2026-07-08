/**
 * Filtering/search/counting helpers for the notebook view, plus the stable
 * per-agent accent palette used by lanes and badges. Pure.
 */
import type { NotebookEntry, NotebookEntryType } from "./notebook";

export interface NotebookFilterState {
  /** Empty set = all types. */
  types: ReadonlySet<NotebookEntryType>;
  query: string;
  pinnedOnly: boolean;
}

export const EMPTY_FILTERS: NotebookFilterState = {
  types: new Set<NotebookEntryType>(),
  query: "",
  pinnedOnly: false,
};

export function isFiltering(f: NotebookFilterState): boolean {
  return f.types.size > 0 || f.query.trim() !== "" || f.pinnedOnly;
}

export function filterEntries(
  entries: NotebookEntry[],
  f: NotebookFilterState,
  pinnedIds: ReadonlySet<string>,
): NotebookEntry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.types.size > 0 && !f.types.has(e.type)) return false;
    if (f.pinnedOnly && !pinnedIds.has(e.id)) return false;
    if (q) {
      const hay = [e.title, e.body ?? "", ...(e.tags ?? [])].join("\n").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function countByType(entries: NotebookEntry[]): Record<NotebookEntryType, number> {
  const out: Record<NotebookEntryType, number> = {
    hypothesis: 0,
    method: 0,
    observation: 0,
    decision: 0,
    note: 0,
  };
  for (const e of entries) out[e.type]++;
  return out;
}

export interface AgentAccent {
  dot: string;
  text: string;
  ring: string;
}

// Slot 0 is reserved for the lead agent; subagents hash into the rest.
const ACCENTS: AgentAccent[] = [
  { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", ring: "ring-sky-500/30" },
  { dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400", ring: "ring-violet-500/30" },
  { dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400", ring: "ring-rose-500/30" },
  { dot: "bg-teal-500", text: "text-teal-600 dark:text-teal-400", ring: "ring-teal-500/30" },
  { dot: "bg-orange-500", text: "text-orange-600 dark:text-orange-400", ring: "ring-orange-500/30" },
  { dot: "bg-indigo-500", text: "text-indigo-600 dark:text-indigo-400", ring: "ring-indigo-500/30" },
  { dot: "bg-lime-600", text: "text-lime-700 dark:text-lime-400", ring: "ring-lime-500/30" },
  { dot: "bg-fuchsia-500", text: "text-fuchsia-600 dark:text-fuchsia-400", ring: "ring-fuchsia-500/30" },
];

const USER_ACCENT: AgentAccent = {
  dot: "bg-amber-500",
  text: "text-amber-600 dark:text-amber-400",
  ring: "ring-amber-500/30",
};

/** Stable accent per role: "agent" (lead) fixed, "you" reserved, rest hashed. */
export function agentAccent(role: string): AgentAccent {
  if (role === "agent") return ACCENTS[0];
  if (role === "you") return USER_ACCENT;
  let hash = 0;
  for (let i = 0; i < role.length; i++) hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
  return ACCENTS[1 + (hash % (ACCENTS.length - 1))];
}

/** Display label for a lane/badge role. */
export function roleLabel(role: string): string {
  if (role === "agent") return "Kady (lead)";
  if (role === "you") return "You";
  return role;
}
