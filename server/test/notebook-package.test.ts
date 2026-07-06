import { describe, it, expect, afterEach } from "vitest";
import factory, { notebookChildTool } from "../pi-packages/kady-notebook/index.ts";

/** Minimal ExtensionAPI stub capturing registerTool calls. */
function fakePi() {
  const registered: unknown[] = [];
  return { registered, api: { registerTool: (t: unknown) => registered.push(t) } };
}

const origChild = process.env.PI_SUBAGENT_CHILD;
afterEach(() => {
  if (origChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = origChild;
});

describe("kady-notebook package", () => {
  it("registers the notebook tool only in a child process", () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const child = fakePi();
    factory(child.api as never);
    expect(child.registered).toHaveLength(1);
    expect((child.registered[0] as { name: string }).name).toBe("notebook");

    delete process.env.PI_SUBAGENT_CHILD;
    const parent = fakePi();
    factory(parent.api as never);
    expect(parent.registered).toHaveLength(0);
  });

  it("the child tool rejects an empty title and returns an ack otherwise", async () => {
    const exec = (id: string, params: unknown) =>
      notebookChildTool.execute(id, params as never, undefined as never, undefined as never, undefined as never);
    await expect(exec("tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
    const ok = await exec("tc_y", { type: "note", title: "kept" });
    expect((ok.content?.[0] as { text: string }).text).toMatch(/tc_y|logged/i);
  });

  it("schema accepts the full NotebookEntryInput shape (parity)", () => {
    // The package schema must accept every field the backend NotebookEntryInput has.
    // Guard: constructing the tool exposes its parameters object.
    const props = (notebookChildTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const k of ["type", "title", "body", "artifacts", "code", "confidence", "tags"]) {
      expect(k in props).toBe(true);
    }
  });
});
