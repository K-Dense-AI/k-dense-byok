import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
vi.mock("../src/api/sci-helpers.ts", () => ({ runHelperScript: run }));
import { getPreview } from "../src/api/sci-previews.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kady-preview-test-"));
afterAll(() => fs.rm(root, { recursive: true, force: true }));
describe("versioned scientific summaries", () => {
  it("shares successful summaries and invalidates on file, project, and helper changes", async () => {
    const target = path.join(root, "data");
    const script = path.join(root, "helper.py");
    await fs.writeFile(target, "a");
    await fs.writeFile(script, "script");
    const request = { projectId: "one", target, script, command: "summarize" as const };
    run.mockImplementation(async () => ({ status: 0, stdout: await fs.readFile(target, "utf8"), stderr: "", timedOut: false }));
    const [first, second] = await Promise.all([getPreview(request), getPreview(request)]);
    expect(first.stdout).toBe("a");
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    await getPreview(request);
    expect(run).toHaveBeenCalledTimes(1);
    const time = await fs.stat(target);
    await fs.writeFile(target, "b");
    await fs.utimes(target, time.atime, time.mtime);
    expect((await getPreview(request)).stdout).toBe("b");
    expect(run).toHaveBeenCalledTimes(2);
    await getPreview({ ...request, projectId: "two" });
    expect(run).toHaveBeenCalledTimes(3);
    await fs.writeFile(script, "new helper");
    await getPreview(request);
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("does not cache a result whose input changed during computation", async () => {
    const target = path.join(root, "mutating");
    const script = path.join(root, "other.py");
    await fs.writeFile(target, "a");
    await fs.writeFile(script, "script");
    run.mockReset().mockImplementation(async () => {
      await fs.writeFile(target, "changed");
      return { status: 0, stdout: "summary", stderr: "", timedOut: false };
    });
    const request = { projectId: "one", target, script, command: "summarize" as const };
    expect((await getPreview(request)).unchanged).toBe(false);
    await getPreview(request);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

it("forwards selections and isolates cached dataset/slice variants", async () => {
  const target = path.join(root, "selection.npy");
  const script = path.join(root, "selection.py");
  await fs.writeFile(target, "array");
  await fs.writeFile(script, "script");
  run.mockReset().mockImplementation(async (_script, args) => ({ status: 0, stdout: JSON.stringify(args), stderr: "", timedOut: false }));
  const request = { projectId: "one", target, script, command: "summarize" as const, params: ["/group/data", "0"] };
  expect(JSON.parse((await getPreview(request)).stdout)).toEqual(["summarize", target, "/group/data", "0"]);
  await getPreview(request);
  expect(run).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await getPreview({ ...request, params: ["/group/data", "1"] })).stdout).at(-1)).toBe("1");
  await getPreview({ ...request, params: ["/other", "0"] });
  expect(run).toHaveBeenCalledTimes(3);
});

it("invalidates SQLite previews when the WAL changes without changing the main file", async () => {
  const target = path.join(root, "wal.sqlite");
  const script = path.join(root, "wal.py");
  await fs.writeFile(target, "database");
  await fs.writeFile(script, "script");
  run.mockReset().mockResolvedValue({ status: 0, stdout: "{}", stderr: "", timedOut: false });
  const request = { projectId: "one", target, script, command: "summarize" as const };
  await getPreview(request);
  await getPreview(request);
  expect(run).toHaveBeenCalledTimes(1);
  await fs.writeFile(`${target}-wal`, "transaction");
  await getPreview(request);
  expect(run).toHaveBeenCalledTimes(2);
});
