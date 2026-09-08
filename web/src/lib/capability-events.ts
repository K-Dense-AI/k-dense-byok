"use client";

import { useEffect, useState } from "react";

/**
 * Skills and prompt templates are fetched once per project by the composer.
 * Settings edits them in place, so closing the dialog (or any panel that
 * mutates them) announces a change and the hooks refetch.
 */
export const CAPABILITIES_CHANGED_EVENT = "kady:capabilities-changed";

export function notifyCapabilitiesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
}

/** Increments every time {@link notifyCapabilitiesChanged} fires. */
export function useCapabilitiesRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((r) => r + 1);
    window.addEventListener(CAPABILITIES_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CAPABILITIES_CHANGED_EVENT, bump);
  }, []);
  return revision;
}
