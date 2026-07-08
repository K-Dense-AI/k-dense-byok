import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { PROJECTS_ROOT } from "../src/config.ts";
import { resolvePaths } from "../src/projects.ts";
import { buildNotebookZip } from "../src/agent/notebook-zip.ts";
import type { NotebookEntry } from "../src/agent/notebook-store.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("buildNotebookZip", () => {
  it("bundles real artifacts and reports missing / traversal ones", () => {
    const sandboxRoot = resolvePaths("default").sandbox;
    fs.mkdirSync(path.join(sandboxRoot, "figures"), { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, "figures", "fig01.png"), "PNGDATA", "utf-8");

    const entries: NotebookEntry[] = [
      { id: "a", type: "observation", title: "has fig", timestamp: 1, role: "agent",
        artifacts: ["figures/fig01.png"] },
      { id: "b", type: "observation", title: "missing", timestamp: 2, role: "agent",
        artifacts: ["figures/gone.png"] },
      { id: "c", type: "observation", title: "traversal", timestamp: 3, role: "agent",
        artifacts: ["../outside.txt"] },
    ];

    const { buffer, missing } = buildNotebookZip(entries, { sessionId: "s", sandboxRoot });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((e) => e.entryName);

    // Markdown + the one real artifact are archived under artifacts/<rel>.
    expect(names).toContain("lab-notebook.md");
    expect(names).toContain("artifacts/figures/fig01.png");
    // Missing + traversal artifacts are excluded from the archive...
    expect(names).not.toContain("artifacts/figures/gone.png");
    expect(names.some((n) => n.includes("outside.txt"))).toBe(false);
    // ...and reported in `missing`.
    expect(missing).toContain("figures/gone.png");
    expect(missing).toContain("../outside.txt");

    // The markdown links the bundled artifact and notes the missing one.
    const md = zip.getEntry("lab-notebook.md")!.getData().toString("utf-8");
    expect(md).toContain("![fig01.png](artifacts/figures/fig01.png)");
    expect(md).toContain("`figures/gone.png` _(artifact missing at export time)_");
    expect(md).toContain("`../outside.txt` _(artifact missing at export time)_");
  });

  it("produces a markdown-only archive when there are no artifacts", () => {
    const sandboxRoot = resolvePaths("default").sandbox;
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const entries: NotebookEntry[] = [
      { id: "a", type: "note", title: "text only", timestamp: 1, role: "agent" },
    ];
    const { buffer, missing } = buildNotebookZip(entries, { sessionId: "s", sandboxRoot });
    const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
    expect(names).toEqual(["lab-notebook.md"]);
    expect(missing).toEqual([]);
  });
});
