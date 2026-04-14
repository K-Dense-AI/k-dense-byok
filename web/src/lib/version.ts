"use client";

import { useState, useEffect } from "react";

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

const GITHUB_REPO = "K-Dense-AI/k-dense-byok";
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

    fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
      .then((res) => {
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const tag: string = data.tag_name ?? "";
        const latestVersion = tag.replace(/^v/, "");
        const updateAvailable =
          latestVersion.length > 0 && compareSemver(APP_VERSION, latestVersion);
        const value: CachedCheck = { updateAvailable, latestVersion, ts: Date.now(), forVersion: APP_VERSION };
        localStorage.setItem(CACHE_KEY, JSON.stringify(value));
        setResult({ updateAvailable, latestVersion });
      })
      .catch(() => {
        // Network error or rate limit — silently ignore
      });
  }, []);

  return result;
}
