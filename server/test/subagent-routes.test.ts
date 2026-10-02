import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSubagentRoutes } from "../src/api/subagents.ts";
import { withActiveProject } from "../src/scope.ts";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), preflight: vi.fn(), session: vi.fn(), resident: vi.fn() }));
vi.mock("../src/agent/session-registry.ts", () => ({ getSession: mocks.session, listSessions: async () => [{ id: "chat-1", name: "QC chat", modified: new Date(0) }, { id: "host-1", modified: new Date(0) }] }));
vi.mock("../src/agent/scheduler-state.ts", () => ({ schedulerSessionId: mocks.resident }));
vi.mock("../src/agent/subagent-control.ts", () => ({ subagentHost: () => ({ rpc: mocks.rpc, preflight: mocks.preflight }) }));
vi.mock("../src/modal/manager.ts", () => ({ modalJobManager: { list: () => [] } }));
let app: ReturnType<typeof Fastify>;
const snapshot = { asyncSnapshot: { runs: [{ id: "run", state: "running", children: [{ id: "stage-b", control: { runId: "run", index: 7, childId: "stage-b" } }] }] } };
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.session.mockImplementation(async (project, _paths, id) => project === "p1" && id === "parent" ? {} : null);
  mocks.rpc.mockImplementation(async (_method, params) => params?.id ? { text: "ok", secretInternalDetail: "omit" } : snapshot);
  app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => withActiveProject(String(req.headers["x-project-id"] || "p1"), done));
  await registerSubagentRoutes(app);
});
afterEach(async () => { await app.close(); });
const post = (action: string, payload: any, project = "p1") => app.inject({ method: "POST", url: `/sessions/parent/subagents/${action}`, payload, headers: { "x-project-id": project } });
it("targets stable child indices and translates child stop to the plugin identity", async () => {
  expect((await post("transcript", { runId: "run", index: 7 })).json()).toEqual({ text: "ok" });
  expect(mocks.rpc).toHaveBeenLastCalledWith("status", { id: "run", index: 7, view: "transcript", lines: 200 });
  expect((await post("stop", { runId: "run", index: 7 })).statusCode).toBe(200);
  expect(mocks.rpc).toHaveBeenLastCalledWith("stop", { id: "run", childId: "stage-b" });
});
it("rejects cross-project sessions, foreign runs and guessed child positions", async () => {
  for (const [body, project] of [[{ runId: "run" }, "p2"], [{ runId: "foreign" }, "p1"], [{ runId: "run", index: 0 }, "p1"], [{ runId: "../run" }, "p1"]] as const) {
    expect((await post("stop", body, project)).statusCode).toBe(400);
  }
  expect(mocks.rpc.mock.calls.every(([method]) => method === "status")).toBe(true);
});
it("passes only validated steering and catches transcript RPC failures", async () => {
  expect((await post("steer", { runId: "run", message: "  Check units  ", dir: "/foreign" })).statusCode).toBe(200);
  expect(mocks.rpc).toHaveBeenLastCalledWith("steer", { id: "run", message: "Check units" });
  expect((await post("resume", { runId: "run", message: " " })).statusCode).toBe(400);
  mocks.rpc.mockImplementation(async (_method, params) => { if (params?.view) throw new Error("No transcript yet"); return snapshot; });
  expect((await post("transcript", { runId: "run" })).json()).toEqual({ detail: "No transcript yet" });
});
it("lists the hidden schedule host so scheduled runs can be inspected", async () => {
  mocks.resident.mockReturnValue(null);
  let res = await app.inject({ method: "GET", url: "/subagents/sessions", headers: { "x-project-id": "p1" } });
  expect(res.json().sessions.map((s: { id: string }) => s.id)).toEqual(["chat-1", "host-1"]);
  mocks.resident.mockReturnValue("host-1");
  res = await app.inject({ method: "GET", url: "/subagents/sessions", headers: { "x-project-id": "p1" } });
  expect(res.json().sessions).toEqual([
    { id: "chat-1", name: "QC chat", modified: new Date(0).toISOString() },
    { id: "host-1", name: "Scheduled runs", resident: true },
  ]);
});
