/**
 * KADY_HOST_CORE_NODE_ALIAS_V1: pi-subagents refuses a background launch when
 * a host alias it lists cannot be resolved, and Pi 1.0 dropped the
 * `@earendil-works/pi-agent-core/node` export it still lists. Without the
 * seam every async `subagent` call failed before a child started.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { patchSubagents } from "../scripts/patch-subagents.mjs";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";

patchSubagents();

const piPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "..",
);
const { resolveHostPeerAliases } = await import(
  pathToFileURL(path.join(subagentsPackageDir(), "src/runs/background/runner-aliases.js")).href
);
const CORE_NODE = "@earendil-works/pi-agent-core/node";
const hostModule = process.env.KADY_SUBAGENT_HOST_MODULE;

afterEach(() => {
  if (hostModule === undefined) delete process.env.KADY_SUBAGENT_HOST_MODULE;
  else process.env.KADY_SUBAGENT_HOST_MODULE = hostModule;
});

describe("background runner host aliases", () => {
  it("resolves every alias the installed Pi still provides under Kady", () => {
    process.env.KADY_SUBAGENT_HOST_MODULE = "file:///kady-host.mjs";
    const { aliases, missing } = resolveHostPeerAliases(piPackageRoot);
    expect(missing).toEqual([]);
    expect(aliases["@earendil-works/pi-coding-agent"]).toBeTruthy();
    expect(aliases["@earendil-works/pi-agent-core"]).toBeTruthy();
  });

  it("leaves upstream behaviour unchanged outside a Kady-hosted process", () => {
    delete process.env.KADY_SUBAGENT_HOST_MODULE;
    expect(resolveHostPeerAliases(piPackageRoot).missing).toContain(CORE_NODE);
  });
});
