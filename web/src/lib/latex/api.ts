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
