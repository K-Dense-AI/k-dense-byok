import { describe, it, expect, afterEach } from "vitest";
import factory, {
  notebookChildTool,
  NotebookParams as ChildParams,
} from "../pi-packages/kady-notebook/index.ts";
import { NotebookParams as LeadParams } from "../src/agent/notebook.ts";

const propsOf = (schema: unknown): Record<string, unknown> =>
  (schema as { properties?: Record<string, unknown> }).properties ?? {};

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

  it("the child tool rejects an empty title and acks with the (id: ...) message", async () => {
    const exec = (id: string, params: unknown) =>
      notebookChildTool.execute(id, params as never, undefined as never, undefined as never, undefined as never);
    await expect(exec("tc_x", { type: "note", title: "  " })).rejects.toThrow(/title/i);
    const ok = await exec("tc_y", { type: "note", title: "kept" });
    const text = (ok.content?.[0] as { text: string }).text;
    expect(text).toContain("(id: tc_y)");
    expect(text).toMatch(/relatesTo\/supersedes/);
  });

  it("schema accepts the full NotebookEntryInput shape including the link fields", () => {
    // The package schema must accept every field the backend NotebookEntryInput has.
    const props = propsOf(notebookChildTool.parameters);
    for (const k of [
      "type", "title", "body", "artifacts", "code", "confidence", "tags",
      "relatesTo", "stance", "supersedes",
    ]) {
      expect(k in props).toBe(true);
    }
  });

  it("lead and child schemas expose the same field set (parity)", () => {
    const lead = Object.keys(propsOf(LeadParams)).sort();
    const child = Object.keys(propsOf(ChildParams)).sort();
    expect(child).toEqual(lead);
  });

  it("neither schema exposes a runId property (it is server-stamped)", () => {
    // runId is stamped by the server at append time; the model must never set it.
    expect("runId" in propsOf(LeadParams)).toBe(false);
    expect("runId" in propsOf(ChildParams)).toBe(false);
  });
});
