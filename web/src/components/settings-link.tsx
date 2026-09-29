"use client";

import type { ReactNode } from "react";
import { openSettings, type OpenSettingsRequest } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";

/**
 * Inline link that opens Settings on a specific tab — for messages like
 * "raise the limit in project settings" that used to name a place the user
 * then had to find by hand.
 */
export function SettingsLink({
  tab,
  projectId,
  section,
  children,
  className,
}: OpenSettingsRequest & { children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={cn(
        "inline p-0 font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        openSettings({ tab, projectId, section });
      }}
    >
      {children}
    </button>
  );
}
