/**
 * Deep links into the Settings dialog. A window event — like chat-prefill.ts —
 * so a budget banner or a "connect Modal" hint anywhere in the app can open
 * Settings on the right tab without prop threading. page.tsx (per active
 * workspace) and project-view.tsx listen and open their dialog; an already
 * open dialog listens too, so in-dialog references just switch tab.
 */

export const SETTINGS_TABS = [
  "providers",
  "defaults",
  "fusion",
  "project",
  "skills",
  "prompts",
  "specialists",
  "connectors",
  "services",
  "appearance",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Tab ids from before the grouped layout, kept so old links still land. */
const LEGACY_TABS: Record<string, SettingsTab> = {
  "model-providers": "providers",
  "api-keys": "services",
};

export interface OpenSettingsRequest {
  tab?: SettingsTab;
  /** Project the Project tab edits; defaults to the workspace's project. */
  projectId?: string;
  /** Element id inside the tab to scroll into view (e.g. "context"). */
  section?: string;
}

const OPEN_SETTINGS_EVENT = "kady:open-settings";

export function normalizeSettingsTab(value: unknown): SettingsTab | null {
  if (typeof value !== "string") return null;
  if ((SETTINGS_TABS as readonly string[]).includes(value)) return value as SettingsTab;
  return LEGACY_TABS[value] ?? null;
}

export function openSettings(request: OpenSettingsRequest = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: request }));
}

export function onOpenSettings(handler: (request: OpenSettingsRequest) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<OpenSettingsRequest>).detail ?? {};
    const tab = normalizeSettingsTab(detail.tab) ?? undefined;
    handler({ ...detail, tab });
  };
  window.addEventListener(OPEN_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
}

const LAST_TAB_KEY = "kady:settings:lastTab";

export function readLastSettingsTab(): SettingsTab | null {
  try {
    return normalizeSettingsTab(window.localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return null;
  }
}

export function writeLastSettingsTab(tab: SettingsTab): void {
  try {
    window.localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    /* not remembered */
  }
}
