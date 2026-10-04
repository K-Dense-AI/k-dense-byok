import { apiFetch } from "@/lib/projects";
import type { ResearchRef } from "@/lib/composer-context";

export interface ChatSnapshotResult {
  sessionId: string;
  path: string;
  digest: string;
  capturedAt: number;
  prompts: number;
  omittedTurns: number;
  bytes: number;
}

/**
 * Capture a compact transcript for every referenced earlier chat, right
 * before the message is sent, so the message cites what the chat said at
 * that moment. A chat whose snapshot fails keeps its plain reference (the
 * agent then searches the raw log) and is reported in `failed`.
 */
export async function withChatSnapshots(
  refs: ResearchRef[],
  projectId: string,
  fetcher: typeof apiFetch = apiFetch,
): Promise<{ refs: ResearchRef[]; failed: string[] }> {
  const failed: string[] = [];
  const out = await Promise.all(
    refs.map(async (ref) => {
      if (ref.kind !== "chat") return ref;
      try {
        const res = await fetcher(
          `/sessions/${encodeURIComponent(ref.sessionId)}/snapshot`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: ref.title }),
          },
          projectId,
        );
        const data = (await res.json().catch(() => null)) as ChatSnapshotResult | null;
        if (!res.ok || !data || typeof data.path !== "string") throw new Error(`snapshot ${res.status}`);
        return { ...ref, snapshot: data.path };
      } catch {
        failed.push(ref.title);
        return { kind: "chat" as const, sessionId: ref.sessionId, title: ref.title };
      }
    }),
  );
  return { refs: out, failed };
}
