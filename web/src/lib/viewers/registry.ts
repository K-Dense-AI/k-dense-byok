import type { ComponentType } from "react";
import type { FileCategory } from "@/lib/use-sandbox";

export type LoadMode = "text" | "raw" | "none";

export interface ViewerProps {
  path: string;
  name: string;
  content: string | null;
  onRetry?: () => void;
}

export interface ViewerDef {
  /** "text" => file body is fetched into tab.content; "raw"/"none" => viewer fetches itself. */
  loadMode: LoadMode;
  Viewer: ComponentType<ViewerProps>;
  canEditSource: boolean;
  managesOwnScroll: boolean;
}

/** Registry of viewers for NEW scientific categories. Existing categories keep
 *  their dispatch in file-preview-panel.tsx; this is additive. */
export const VIEWER_REGISTRY: Partial<Record<FileCategory, ViewerDef>> = {};

export function getViewerDef(cat: FileCategory): ViewerDef | undefined {
  return VIEWER_REGISTRY[cat];
}
