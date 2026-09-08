import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths, createProject, getProject } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
import { snapshotNotebookResults } from "../src/agent/notebook-results.ts";
const app = await buildApp();
afterAll(async () => { await app.close(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });
beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); });
const plan = { hypothesis: "Treatment effect", primaryOutcome: "Mean score", exclusions: "QC failures", model: "Linear model", multiplicity: "One test", qc: "No missingness", stopping: "100 samples", exposureNotes: "Unknown", datasets: ["data.csv"], intent: "exploratory", priorExposure: "unknown" };
const base = "/sessions/s1/notebook/h1/plans";
const post = (action: string, payload: unknown, project = "default") => app.inject({ method: "POST", url: `${base}/${action}`, headers: { "x-project-id": project }, payload });
function setup(project = "default") {
  if (project !== "default" && !getProject(project)) createProject({ name: project, projectId: project });
  appendNotebookEntry("s1", { id: "h1", type: "hypothesis", title: "Hypothesis", timestamp: 1, role: "agent" }, project);
  fs.writeFileSync(path.join(resolvePaths(project).sandbox, "data.csv"), "data");
}

describe("analysis-plan HTTP workflow and exports", () => {
  it("previews, explicitly freezes, records a deviation, and preserves history in every export", async () => {
    setup();
    const p = await post("preview", { plan, expectedHead: null }); expect(p.statusCode).toBe(200);
    expect(p.headers["cache-control"]).toBe("no-store");
    expect((await post("freeze", { previewId: p.json().id })).statusCode).toBe(400);
    const frozen = await post("freeze", { previewId: p.json().id, acknowledgeLocalFreeze: true });
    expect(frozen.statusCode).toBe(200);
    const f = frozen.json();
    const changed = await post("deviations", { expectedHead: f.head, planId: f.events[0].id, field: "model", actual: "Robust regression", reason: "Heavy tails", timing: "after-results" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().events[1].planned).toBe("Linear model");
    for (const url of ["/sessions/s1/notebook", "/projects/default/notebook"]) {
      const entries = (await app.inject({ method: "GET", url })).json().entries;
      expect(entries[0].planHistory.events).toHaveLength(2);
      const exported = await app.inject({ method: "GET", url: `${url}/export?format=json` });
      expect(exported.json().entries[0].planHistory.events).toHaveLength(2);
      const markdown = await app.inject({ method: "GET", url: `${url}/export?format=md` });
      expect(markdown.body).toContain("Frozen revision 1"); expect(markdown.body).toContain("Heavy tails");
      expect(markdown.body).toContain("not external preregistration");
      const zipped = await app.inject({ method: "GET", url: `${url}/export?format=zip` });
      expect(new AdmZip(zipped.rawPayload).readAsText("lab-notebook.md")).toContain("Robust regression");
    }
  });
  it("enforces head preconditions, scope and source existence at the route boundary", async () => {
    setup(); setup("other");
    expect((await post("preview", { plan })).statusCode).toBe(409);
    const p = (await post("preview", { plan, expectedHead: null })).json();
    expect((await post("freeze", { previewId: p.id, acknowledgeLocalFreeze: true }, "no-such-project")).statusCode).toBe(404);
    expect((await post("freeze", { previewId: p.id, acknowledgeLocalFreeze: true }, "other")).statusCode).toBe(410);
    const freeze = await post("freeze", { previewId: p.id, acknowledgeLocalFreeze: true }); expect(freeze.statusCode).toBe(200);
    expect((await post("preview", { plan, expectedHead: null })).statusCode).toBe(409);
    const missing = await app.inject({ method: "POST", url: "/sessions/s1/notebook/absent/plans/preview", payload: { plan, expectedHead: null } });
    expect(missing.statusCode).toBe(404);
    const other = await app.inject({ method: "GET", url: base, headers: { "x-project-id": "other" } });
    expect(other.json().events).toEqual([]);
  });
  it("resolves referenced cards only through a saved notebook source", async () => {
    setup(); setup("other");
    const dir = resolvePaths("default").sessionsDir; fs.mkdirSync(dir, { recursive: true });
    const card = { schemaVersion: 1, kind: "table", title: "Actual data", columns: [{ key: "x", label: "x" }], rows: [[42]] };
    fs.writeFileSync(path.join(dir, "s1.jsonl"), JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "result", toolName: "scientific_result", details: { scientificResult: card } } }) + "\n");
    const results = [{ toolCallId: "result" }];
    appendNotebookEntry("s1", { id: "o1", type: "observation", title: "Observed", timestamp: 2, role: "agent", results, resultSnapshots: await snapshotNotebookResults("default", "s1", results) });
    const res = await app.inject({ method: "GET", url: "/sessions/s1/notebook/o1/results/0" });
    expect(res.statusCode).toBe(200); expect(res.json()).toMatchObject({ status: "available", card });
    const other = await app.inject({ method: "GET", url: "/sessions/s1/notebook/o1/results/0", headers: { "x-project-id": "other" } }); expect(other.statusCode).toBe(404);
    const missing = await app.inject({ method: "GET", url: "/sessions/s1/notebook/o1/results/11" }); expect(missing.statusCode).toBe(404);
    const md = await app.inject({ method: "GET", url: "/sessions/s1/notebook/export?format=md" });
    expect(md.body).toContain("s1/result"); expect(md.body).toContain("sha256");
  });
});
