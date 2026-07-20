import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import factory, {
  modalChildTools,
  ModalJobIdParams as ChildJobIdParams,
  ModalRunParams as ChildRunParams,
  ModalSubmitBatchParams as ChildBatchParams,
  ModalWaitParams as ChildWaitParams,
} from "../pi-packages/kady-modal/index.ts";
import {
  ModalJobIdParams as LeadJobIdParams,
  ModalRunParams as LeadRunParams,
  ModalSubmitBatchParams as LeadBatchParams,
  ModalWaitParams as LeadWaitParams,
  MODAL_TOOL_NAMES,
} from "../src/agent/modal-tool.ts";
import {
  kadyModalPackageDir,
  seedBuiltinAgentModalTools,
  seedModalPackage,
} from "../src/agent/modal-bridge.ts";
import { seedBuiltinAgentNotebookTools } from "../src/agent/notebook-bridge.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";

const properties = (schema: unknown) =>
  (schema as { properties?: Record<string, unknown> }).properties ?? {};

const originalChild = process.env.PI_SUBAGENT_CHILD;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

describe("kady-modal child package", () => {
  it("registers the complete tool set only in child processes", () => {
    const registered: { name: string }[] = [];
    process.env.PI_SUBAGENT_CHILD = "1";
    factory({ registerTool: (tool: { name: string }) => registered.push(tool) } as never);
    expect(registered.map((tool) => tool.name)).toEqual([...MODAL_TOOL_NAMES]);

    delete process.env.PI_SUBAGENT_CHILD;
    const parent: unknown[] = [];
    factory({ registerTool: (tool: unknown) => parent.push(tool) } as never);
    expect(parent).toEqual([]);
    expect(modalChildTools.map((tool) => tool.name)).toEqual([...MODAL_TOOL_NAMES]);
  });

  it("keeps lead and child request/control schemas in parity", () => {
    expect(ChildRunParams).toEqual(LeadRunParams);
    expect(ChildJobIdParams).toEqual(LeadJobIdParams);
    expect(ChildWaitParams).toEqual(LeadWaitParams);
    expect(ChildBatchParams).toEqual(LeadBatchParams);
    expect(Object.keys(properties(ChildRunParams)).sort()).toEqual(
      Object.keys(properties(LeadRunParams)).sort(),
    );
    expect(Object.keys(properties(ChildJobIdParams)).sort()).toEqual(
      Object.keys(properties(LeadJobIdParams)).sort(),
    );
    expect(Object.keys(properties(ChildWaitParams)).sort()).toEqual(
      Object.keys(properties(LeadWaitParams)).sort(),
    );
    expect(Object.keys(properties(ChildBatchParams)).sort()).toEqual(
      Object.keys(properties(LeadBatchParams)).sort(),
    );
  });

  it("seeds the child package and extends generated builtin allowlists idempotently", () => {
    const paths = ensureProjectExists("default");
    expect(seedModalPackage(paths)).toBe(true);
    expect(seedModalPackage(paths)).toBe(false);
    const settingsPath = path.join(paths.sandbox, ".pi", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      packages: string[];
    };
    expect(settings.packages).toContain(kadyModalPackageDir());

    // notebook runs immediately before modal during a real session build.
    seedBuiltinAgentNotebookTools(paths);
    seedBuiltinAgentModalTools(paths);
    const updated = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as any;
    const tools = updated.subagents.agentOverrides.researcher.tools as string[];
    for (const name of MODAL_TOOL_NAMES) expect(tools).toContain(name);
    expect(seedBuiltinAgentModalTools(paths)).toBe(false);
  });

  it("does not override a user-pinned builtin tool list", () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(path.join(paths.sandbox, ".pi"), { recursive: true });
    const file = path.join(paths.sandbox, ".pi", "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        subagents: { agentOverrides: { researcher: { tools: ["read"] } } },
      }),
      "utf-8",
    );
    seedBuiltinAgentModalTools(paths);
    const settings = JSON.parse(fs.readFileSync(file, "utf-8")) as any;
    expect(settings.subagents.agentOverrides.researcher.tools).toEqual(["read"]);
  });
});
