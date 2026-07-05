/** Thin client helpers for the LaTeX editor's backend endpoints. */
import { apiFetch } from "@/lib/projects";

export async function readSandboxFile(path: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/sandbox/file?path=${encodeURIComponent(path)}`);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export type SynctexBoxDto = { page: number; h: number; v: number; W: number; H: number };
export type SynctexLocDto = { file: string | null; line: number; column: number };

async function synctexRequest<T>(params: URLSearchParams): Promise<T | "unavailable" | null> {
  try {
    const res = await apiFetch(`/sandbox/synctex?${params.toString()}`);
    if (res.status === 424) return "unavailable";
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchSynctexForward(
  tex: string,
  line: number,
  pdf: string,
): Promise<SynctexBoxDto | "unavailable" | null> {
  return synctexRequest<SynctexBoxDto>(
    new URLSearchParams({ dir: "forward", path: tex, line: String(line), col: "0", pdf }),
  );
}

export function fetchSynctexInverse(
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexLocDto | "unavailable" | null> {
  return synctexRequest<SynctexLocDto>(
    new URLSearchParams({
      dir: "inverse", pdf, page: String(page), x: x.toFixed(2), y: y.toFixed(2),
    }),
  );
}

export class LatexAssistError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LatexAssistResult {
  replacement: string;
  model: string;
  costUsd: number;
}

export async function postLatexAssist(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LatexAssistResult> {
  const res = await apiFetch(`/sandbox/latex-assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let message = `AI assist failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string; detail?: string };
      message = data.message ?? data.detail ?? message;
    } catch { /* non-JSON error body */ }
    throw new LatexAssistError(res.status, message);
  }
  return (await res.json()) as LatexAssistResult;
}
