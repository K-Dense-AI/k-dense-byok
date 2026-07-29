import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists } from "../src/projects.ts";
import { appendNotebookEntry } from "../src/agent/notebook-store.ts";
import {
  appendStep,
  PROVENANCE_SCHEMA_VERSION,
  type ProvenanceStep,
} from "../src/provenance/store.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

const step = (over: Partial<ProvenanceStep> = {}): ProvenanceStep => ({
  schemaVersion: PROVENANCE_SCHEMA_VERSION,
  id: "tc_1",
  sessionId: "sess-a",
  timestamp: 1_000,
  toolName: "bash",
  role: "agent",
  inputs: [],
  outputs: [],
  ...over,
});

function get(url: string, projectId = "default") {
  return app.inject({ method: "GET", url, headers: { "x-project-id": projectId } });
}

describe("GET /sandbox/provenance", () => {
  it("returns the producing step and a current verdict for a matching hash", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "fig.png"), "PNG");
    // Deliberately NOT sha256("PNG"): the route must hash the file itself and
    // report the mismatch, not echo back whatever the record claims.
    const sha = "d8bb0e0d1d1e2a1a5b1e7cb4a1f2d2f4e4c0e2b9c2c17d1c4f6f5ba1a1c7e4d1";
    appendStep(
      step({
        outputs: [
          {
            path: "fig.png",
            sha256: sha,
            size: 3,
            mtimeMs: 1,
            change: "created",
            confidence: "observed",
          },
        ],
      }),
      "default",
    );

    const res = await get("/sandbox/provenance?path=fig.png");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.producedBy.map((s: ProvenanceStep) => s.id)).toEqual(["tc_1"]);
    // The stored hash is deliberately wrong for these bytes, so the route must
    // report drift rather than trusting the record.
    expect(body.staleness).toBe("stale");
  });

  it("includes notebook citations and flags ones that predate the latest output", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "fig.png"), "PNG");
    appendNotebookEntry(
      "sess-a",
      {
        id: "nb_1",
        type: "observation",
        title: "Six clusters",
        timestamp: 1,
        role: "agent",
        artifacts: ["fig.png"],
      },
      "default",
    );
    appendStep(
      step({
        id: "regen",
        timestamp: 9_000,
        outputs: [
          { path: "fig.png", size: 3, mtimeMs: 1, change: "modified", confidence: "observed" },
        ],
      }),
      "default",
    );

    const body = (await get("/sandbox/provenance?path=fig.png")).json();
    expect(body.citedBy).toHaveLength(1);
    expect(body.citedBy[0].precedesLatestOutput).toBe(true);
  });

  it("returns an empty record for a file with no recorded provenance", async () => {
    const paths = ensureProjectExists("default");
    fs.writeFileSync(path.join(paths.sandbox, "uploaded.csv"), "a,b\n");
    const body = (await get("/sandbox/provenance?path=uploaded.csv")).json();
    expect(body.producedBy).toEqual([]);
    expect(body.citedBy).toEqual([]);
    expect(body.staleness).toBe("unknown");
    expect(body.exists).toBe(true);
  });

  it("scopes lookups to the requesting project", async () => {
    ensureProjectExists("default");
    const other = ensureProjectExists("other");
    fs.writeFileSync(path.join(other.sandbox, "fig.png"), "PNG");
    appendStep(
      step({
        outputs: [
          { path: "fig.png", size: 3, mtimeMs: 1, change: "created", confidence: "observed" },
        ],
      }),
      "other",
    );

    const mine = (await get("/sandbox/provenance?path=fig.png", "other")).json();
    expect(mine.producedBy).toHaveLength(1);

    const theirs = (await get("/sandbox/provenance?path=fig.png", "default")).json();
    expect(theirs.producedBy).toEqual([]);
  });

  it("rejects a missing path parameter", async () => {
    ensureProjectExists("default");
    const res = await get("/sandbox/provenance");
    expect(res.statusCode).toBe(400);
  });

  it("refuses traversal outside the sandbox", async () => {
    ensureProjectExists("default");
    const res = await get("/sandbox/provenance?path=../../etc/passwd");
    expect(res.statusCode).toBe(403);
  });

  it("refuses a hidden internal path", async () => {
    ensureProjectExists("default");
    const res = await get("/sandbox/provenance?path=.kady/provenance/sess-a/steps.jsonl");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
