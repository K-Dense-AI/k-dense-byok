import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/format";

export function BudgetBanner({
  state,
  totalUsd,
  limitUsd,
}: {
  state: "warn" | "exceeded";
  totalUsd: number;
  limitUsd: number | null;
}) {
  const blocked = state === "exceeded";
  return (
    <div
      role="alert"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        blocked
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <span className="flex-1">
        {blocked ? (
          <>
            <b>Project spend limit reached</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). New
            delegations are blocked. Raise the limit in the project settings to
            continue.
          </>
        ) : (
          <>
            <b>Approaching spend limit</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). You&apos;re
            over 80% of the project&apos;s cap.
          </>
        )}
      </span>
    </div>
  );
}
