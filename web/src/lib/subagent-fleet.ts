import { apiFetch } from "@/lib/projects";
export interface FleetNode {
  id: string; kind: string; label: string; state: string; startedAt?: number; endedAt?: number;
  activity?: { currentTool?: string; lastActivityAt?: number; toolCount?: number; turnCount?: number };
  children?: FleetNode[];
  control?: { runId: string; index: number; childId: string };
}
export interface FleetSnapshot {
  text: string;
  asyncSnapshot?: { runs: FleetNode[]; omitted?: { runs: number; children: number; byteLimitExceeded: boolean } };
  fleet?: { totalActive: number; omitted: number; entries: Array<{ key: string; agent: string; model?: string; goal?: string; tokens: { input: number; output: number; total: number } }> };
  compute?: Array<{ id: string; label: string; state: string }>;
}
async function request<T>(projectId: string, route: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(route, init, projectId);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Specialist request failed");
  return data;
}
export const fleetSessions = (projectId: string) => request<{ sessions: Array<{ id: string; name: string }> }>(projectId, "/subagents/sessions");
export const getFleet = (projectId: string, sessionId: string) => request<FleetSnapshot>(projectId, `/sessions/${encodeURIComponent(sessionId)}/subagents`, { cache: "no-store" });
export type FleetAction = "transcript" | "steer" | "stop" | "resume";
export const controlSpecialist = (projectId: string, sessionId: string, action: FleetAction, runId: string, message?: string, index?: number) =>
  request<{ text?: string }>(projectId, `/sessions/${encodeURIComponent(sessionId)}/subagents/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, message, index }),
  });
