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
