"use client";

import { useState, useEffect } from "react";

import { apiFetch } from "@/lib/projects";

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

/** Sentinel used when no build-time version was injected (dev / source checkout).
 *  We must not nag about updates in this case — `0.0.0` is older than every
 *  real release, so a naive semver compare would always claim an update. */
export const UNVERSIONED = "0.0.0";
export const isVersioned = APP_VERSION !== UNVERSIONED;

const CACHE_KEY = "kdense-update-check";
const CACHE_TTL_MS = 60 * 60 * 1000; // re-check at most once per hour

interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string | null;
}

interface CachedCheck extends UpdateCheckResult {
  ts: number;
  forVersion: string;
}

function compareSemver(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

export function useUpdateCheck(): UpdateCheckResult {
  const [result, setResult] = useState<UpdateCheckResult>({
    updateAvailable: false,
    latestVersion: null,
  });

  useEffect(() => {
    // No injected build version → don't compare against releases (the 0.0.0
    // sentinel is "older" than everything and would nag forever).
    if (!isVersioned) return;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached: CachedCheck = JSON.parse(raw);
        if (cached.forVersion === APP_VERSION && Date.now() - cached.ts < CACHE_TTL_MS) {
          setResult({ updateAvailable: cached.updateAvailable, latestVersion: cached.latestVersion });
          return;
        }
      }
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }

    // Routed through the backend (`/version/latest`) so an unauthenticated
    // GitHub rate-limit never surfaces as a console error in the browser.
    apiFetch("/version/latest")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const latestVersion: string = data?.latestVersion ?? "";
        if (!latestVersion) return;
        const updateAvailable = compareSemver(APP_VERSION, latestVersion);
        const value: CachedCheck = { updateAvailable, latestVersion, ts: Date.now(), forVersion: APP_VERSION };
        localStorage.setItem(CACHE_KEY, JSON.stringify(value));
        setResult({ updateAvailable, latestVersion });
      })
      .catch(() => {
        // Network error — silently ignore
      });
  }, []);

  return result;
}
