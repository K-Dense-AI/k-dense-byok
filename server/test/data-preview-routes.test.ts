import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
const preview = vi.hoisted(() => vi.fn(async () => ({ status: 0, stdout: '{"kind":"table"}', stderr: "", timedOut: false })));
vi.mock("../src/api/sci-previews.ts", () => ({ requestPreview: preview }));
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";

const app = await buildApp();
ensureProjectExists("default");
fs.writeFileSync(path.join(resolvePaths("default").sandbox, "data.xlsx"), "test");
afterAll(async () => { await app.close(); fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); });
const get = (query: string) => app.inject({ method: "GET", url: `/sandbox/sci-summary?path=data.xlsx&${query}`, headers: { "x-project-id": "default" } });

describe("scientific preview selections", () => {
  it("passes sheet/dataset selection to the project-scoped cache", async () => {
    const result = await get("kind=tables&key=Sheet%202&slice=0");
    expect(result.statusCode).toBe(200);
    expect(preview).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      projectId: "default", params: ["Sheet 2", "0"], command: "summarize",
    }));
  });
  it.each(["kind=arrays&slice=-1", "kind=arrays&slice=1.5", "kind=arrays&slice=9007199254740992",
    "kind=tables&key=%00", "kind=imaging&key=a", "kind=__proto__", "kind=constructor"])("rejects invalid selection %s", async query => {
    const calls = preview.mock.calls.length;
    expect((await get(query)).statusCode).toBe(400);
    expect(preview).toHaveBeenCalledTimes(calls);
  });
  it("keeps sandbox path confinement", async () => {
    const response = await app.inject({ method: "GET", url: "/sandbox/sci-summary?path=..%2Foutside.xlsx&kind=tables", headers: { "x-project-id": "default" } });
    expect(response.statusCode).toBe(403);
  });
});
