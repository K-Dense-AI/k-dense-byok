import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Cache/system artifacts that should never surface in @ mention suggestions
 *  (they still show in the file tree for transparency). */
export function isJunkFilePath(path: string): boolean {
  return (
    /(^|\/)__pycache__(\/|$)/.test(path) ||
    /\.pyc$|\.pyo$/.test(path) ||
    /(^|\/)\.DS_Store$/.test(path) ||
    /(^|\/)\.ipynb_checkpoints(\/|$)/.test(path)
  );
}

export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
