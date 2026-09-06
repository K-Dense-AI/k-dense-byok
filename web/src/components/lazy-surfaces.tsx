"use client";

import dynamic from "next/dynamic";
import { useState, type ComponentProps } from "react";

type SettingsProps = ComponentProps<typeof import("./settings-dialog").SettingsDialog>;
const loading = () => <div className="p-4 text-sm text-muted-foreground" role="status">Loading…</div>;
const Settings = dynamic(() => import("./settings-dialog").then((m) => m.SettingsDialog), { loading, ssr: false });
export const FilePreviewPanel = dynamic(() => import("./file-preview-panel").then((m) => m.FilePreviewPanel), { loading, ssr: false });
export const WorkflowsPanel = dynamic(() => import("./workflows-panel").then((m) => m.WorkflowsPanel), { loading, ssr: false });

/** Don't fetch a closed dialog, but preserve its state after the first open. */
export function SettingsDialog(props: SettingsProps) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  return opened || props.open ? <Settings {...props} /> : null;
}
