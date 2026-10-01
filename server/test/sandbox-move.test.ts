import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import * as userSteps from "../src/provenance/user-steps.ts";

const app = await buildApp();
const sandbox = () => resolvePaths("default").sandbox;
const move = (src: string, dest: string) => app.inject({
  method: "POST", url: "/sandbox/move", payload: { src, dest },
  headers: { "x-project-id": "default" },
});

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  ensureProjectExists("default");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

it.each(["file", "directory"])("preserves a competing destination while collecting %s provenance", async (kind) => {
  for (const name of ["first", "second"]) {
    const location = path.join(sandbox(), name);
    if (kind === "directory") fs.mkdirSync(location);
    fs.writeFileSync(kind === "directory" ? path.join(location, "data.txt") : location, name);
  }
  let resume!: () => void;
  let arrived!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const collect = userSteps.collectPrior;
  vi.spyOn(userSteps, "collectPrior").mockImplementationOnce(async (...args) => {
    const result = await collect(...args);
    arrived();
    await paused;
    return result;
  });
  const first = move("first", "destination").then((result) => result);
  await entered;
  try {
    expect((await move("second", "destination")).statusCode).toBe(200);
  } finally {
    resume();
  }
  const rejected = await first;
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json()).toMatchObject({ detail: "Destination already exists" });
  const suffix = kind === "directory" ? "data.txt" : "";
  expect(fs.readFileSync(path.join(sandbox(), "first", suffix), "utf8")).toBe("first");
  expect(fs.readFileSync(path.join(sandbox(), "destination", suffix), "utf8")).toBe("second");
});
