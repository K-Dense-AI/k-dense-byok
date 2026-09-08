import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { appendNotebookEntry, readNotebookEntries } from "../src/agent/notebook-store.ts";
import { experimentPlan, experimentSource as source } from "../../web/src/test/next-experiments-fixture.ts";
const app = await buildApp();
const base = `/sessions/${source.sessionId}/notebook/${source.entryId}/next-experiments`;
const headers = { "x-project-id": "project-a" };
beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  createProject({ name: "A", projectId: "project-a" }); createProject({ name: "B", projectId: "project-b" });
  appendNotebookEntry(source.sessionId, { id: source.entryId, type: "hypothesis", title: "Treatment lowers marker X", role: "agent", timestamp: 1 }, "project-a");
  appendNotebookEntry(source.sessionId, { id: "p", type: "note", title: "Ideas", role: "agent", timestamp: 2, nextExperiments: experimentPlan }, "project-a");
});
afterAll(async () => { await app.close(); });
describe("next-experiment API", () => {
  it("reads without a model call, records only an explicitly acknowledged preference, and exports it", async () => {
    const res = await app.inject({ method: "GET", url: base, headers }); expect(res.statusCode, res.body).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
    const view = res.json(), p = view.proposals[0];
    const payload = { proposal: p.source, candidateId: "adjust_batch", disposition: "defer", reason: "Need usable batch labels", requestId: crypto.randomUUID(), expectedContextDigest: view.context.digest, expectedProposalDigest: p.digest };
    const malformed = await app.inject({ method: "POST", url: `${base}/decision`, headers, payload: { ...payload, disposition: ["defer"], acknowledgeUnverifiedContext: true } }); expect(malformed.statusCode).toBe(400);
    const noAck = await app.inject({ method: "POST", url: `${base}/decision`, headers, payload }); expect(noAck.statusCode).toBe(400);
    const saved = await app.inject({ method: "POST", url: `${base}/decision`, headers, payload: { ...payload, acknowledgeUnverifiedContext: true, execute: true, approvedBudgetUsd: 1000 } });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().entry).toMatchObject({ role: "you", proposalOnly: true }); expect(saved.json().entry.approvedBudgetUsd).toBeUndefined();
    expect(readNotebookEntries(source.sessionId, "project-b")).toHaveLength(0);
    const exported = await app.inject({ method: "GET", url: `/sessions/${source.sessionId}/notebook/export?format=md`, headers });
    expect(exported.statusCode).toBe(200); expect(exported.body).toContain("not execution/spending approval"); expect(exported.body).toContain("PREDICTED under treatment");
  });
  it("rejects implicit generation, stale approval context and missing-project fallback", async () => {
    const res = await app.inject({ method: "POST", url: `${base}/generate`, headers, payload: { model: "openrouter/openai/gpt-4o" } }); expect(res.statusCode).toBe(400);
    const stale = await app.inject({ method: "POST", url: `${base}/generate`, headers, payload: { approveModelCall: true, requestId: crypto.randomUUID(), expectedContextDigest: "fake" } }); expect(stale.statusCode).toBe(409);
    for (const project of ["project-b", "not-found"]) {
      const response = await app.inject({ method: "GET", url: base, headers: { "x-project-id": project } }); expect(response.statusCode).toBe(404);
    }
    const invalid = await app.inject({ method: "GET", url: base.replace(source.sessionId, "bad%2Fsession"), headers }); expect(invalid.statusCode).toBe(400);
  });
  it("checks a request receipt read-only and validates request ids", async () => {
    const status = await app.inject({ method: "GET", url: `${base}/requests/${crypto.randomUUID()}`, headers }); expect(status.statusCode).toBe(200); expect(status.json().state).toBe("not-started");
    const invalid = await app.inject({ method: "GET", url: `${base}/requests/not-a-request`, headers }); expect(invalid.statusCode).toBe(400);
  });
});
