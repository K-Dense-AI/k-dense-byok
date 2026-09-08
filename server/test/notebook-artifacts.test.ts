import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { captureNotebookArtifacts, compareNotebookArtifact, withNotebookArtifactHealth, NOTEBOOK_HASH_FILE_BYTES } from "../src/agent/notebook-artifacts.ts";
import { makeNotebookTool } from "../src/agent/notebook.ts";
import { readNotebookEntries, type NotebookEntry } from "../src/agent/notebook-store.ts";

beforeEach(() => { fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }); fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); });
function write(project = "default", name = "result.txt", text = "first") {
  const target = path.join(resolvePaths(project).sandbox, name);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target;
}
const entry = (over: Partial<NotebookEntry> = {}): NotebookEntry => ({ id: "e", type: "observation", title: "Result", role: "agent", timestamp: 1, artifacts: ["result.txt"], ...over });

describe("notebook artifact verification", () => {
  it("captures citation-time bytes; finds same-size edits and deletion without mutating history", async () => {
    const target = write();
    const snapshots = await captureNotebookArtifacts("default", ["./result.txt"]);
    expect(snapshots[0]).toMatchObject({ path: "result.txt", timing: "entry", size: 5 });
    expect(snapshots[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const record = entry({ artifactSnapshots: snapshots });
    const health = async () => (await withNotebookArtifactHealth([record], "default"))[0].artifactHealth![0];
    expect((await health()).status).toBe("unchanged");
    const before = fs.statSync(target);
    fs.writeFileSync(target, "other"); fs.utimesSync(target, before.atime, before.mtime);
    expect((await health()).status).toBe("changed");
    fs.unlinkSync(target);
    expect((await health()).status).toBe("missing");
    expect(record.artifactHealth).toBeUndefined();
    expect(record.artifactSnapshots).toEqual(snapshots);
  });
  it("legacy entries and no-hash identities never earn unchanged", async () => {
    write();
    const checked = await withNotebookArtifactHealth([entry()], "default");
    expect(checked[0].artifactHealth![0]).toMatchObject({ status: "unverified", reason: expect.stringMatching(/No citation-time hash/) });
    expect(compareNotebookArtifact({ path: "p", timing: "harvest", sha256: "abc", capturedAt: 1 }, { path: "p", sha256: "abc", capturedAt: 2 }).status).toBe("unverified");
    expect(compareNotebookArtifact({ path: "p", timing: "entry", size: 10, capturedAt: 1 }, { path: "p", size: 10, capturedAt: 2 }).status).toBe("unverified");
  });
  it("isolates projects with identical artifact paths", async () => {
    write("a", "result.txt", "A"); write("b", "result.txt", "B");
    const record = entry({ artifactSnapshots: await captureNotebookArtifacts("a", ["result.txt"]) });
    expect((await withNotebookArtifactHealth([record], "a"))[0].artifactHealth![0].status).toBe("unchanged");
    expect((await withNotebookArtifactHealth([record], "b"))[0].artifactHealth![0].status).toBe("changed");
  });
  it("does not hash hidden paths or traversal targets", async () => {
    write();
    const checks = await captureNotebookArtifacts("default", ["../../outside.txt", ".pi/auth.json", "AGENTS.md"]);
    expect(checks.every((c) => c.reason === "unsafe-path" && !c.sha256)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("does not follow symlinks outside the sandbox or into hidden files", async () => {
    write();
    const outside = path.join(PROJECTS_ROOT, "secret.txt"); fs.writeFileSync(outside, "secret");
    const sandbox = resolvePaths("default").sandbox;
    fs.symlinkSync(outside, path.join(sandbox, "link.txt"));
    write("default", ".pi/hidden", "secret"); fs.symlinkSync(path.join(sandbox, ".pi/hidden"), path.join(sandbox, "hidden-link.txt"));
    const checks = await captureNotebookArtifacts("default", ["link.txt", "hidden-link.txt"]);
    expect(checks.every((c) => c.reason === "unsafe-path" && !c.sha256)).toBe(true);
  });
  it("reports per-file and per-entry bounds visibly", async () => {
    const file = write(); fs.truncateSync(file, NOTEBOOK_HASH_FILE_BYTES + 1);
    const snapshots = await captureNotebookArtifacts("default", ["result.txt"]);
    expect(snapshots[0].reason).toBe("budget");
    expect(snapshots[0].sha256).toBeUndefined();
    const checked = await withNotebookArtifactHealth([entry({ artifacts: Array.from({ length: 30 }, (_, i) => `file-${i}`) })], "default");
    expect(checked[0].artifactHealth).toHaveLength(25);
    expect(checked[0].artifactHealthTruncated).toBe(5);
  });
  it("enforces the aggregate hash budget even when each file fits individually", async () => {
    const names = Array.from({ length: 5 }, (_, i) => `large-${i}.bin`);
    for (const name of names) fs.truncateSync(write("default", name), NOTEBOOK_HASH_FILE_BYTES);
    const snapshots = await captureNotebookArtifacts("default", names);
    expect(snapshots.slice(0, 4).every((s) => Boolean(s.sha256))).toBe(true);
    expect(snapshots[4]).toMatchObject({ reason: "budget" });
    expect(snapshots[4].sha256).toBeUndefined();
  });

  it("reports the request-wide file budget and prioritizes recent entries", async () => {
    write();
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: String(i), timestamp: i, artifacts: Array.from({ length: 25 }, (_, n) => `file-${i}-${n}`) }));
    const checked = await withNotebookArtifactHealth(entries, "default");
    expect(checked[0].artifactHealth!.every((h) => h.status === "unverified" && h.reason?.includes("budget"))).toBe(true);
    expect(checked[4].artifactHealth!.every((h) => h.status === "missing")).toBe(true);
  });
  it("ignores model-injected health/snapshots and saves only server identities", async () => {
    write();
    const tool = makeNotebookTool("default", () => "owner");
    await tool.execute("real", {
      type: "observation", title: "Result", artifacts: ["result.txt"],
      artifactSnapshots: [{ path: "result.txt", sha256: "forged", timing: "entry" }],
      artifactHealth: [{ path: "result.txt", status: "unchanged" }], sessionId: "forged",
      evidence: [{ entryId: "h", relation: "supports" }], limitations: ["One cohort"], outcome: "signal",
    } as never, undefined as never);
    const saved = readNotebookEntries("owner", "default")[0];
    expect(saved.artifactSnapshots![0].sha256).not.toBe("forged");
    expect(saved.artifactHealth).toBeUndefined();
    expect((saved as unknown as { sessionId?: string }).sessionId).toBeUndefined();
    expect(saved.evidence).toEqual([{ entryId: "h", relation: "supports" }]);
    expect(saved.limitations).toEqual(["One cohort"]);
    const again = await withNotebookArtifactHealth([{ ...saved, artifactHealth: [{ path: "result.txt", status: "changed", checkedAt: 1 }] }], "default");
    expect(again[0].artifactHealth![0].status).toBe("unchanged");
  });
});
