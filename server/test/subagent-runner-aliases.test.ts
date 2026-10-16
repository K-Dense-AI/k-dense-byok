/**
 * pi-subagents refuses a background launch when a host alias it requires
 * cannot be resolved against the installed Pi. Pi 1.0 dropped
 * `@earendil-works/pi-agent-core/node` and Pi 1.2 dropped
 * `@earendil-works/chord`; a harness upgrade that leaves the pinned plugin
 * requiring either fails every async `subagent` call before a child starts.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";

const piPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "..",
);
const { resolveHostPeerAliases } = await import(
  pathToFileURL(path.join(subagentsPackageDir(), "src/runs/background/runner-aliases.js")).href
);

describe("background runner host aliases", () => {
  it("resolves every alias the pinned plugin requires from the installed Pi", () => {
    const { aliases, missing } = resolveHostPeerAliases(piPackageRoot);
    expect(missing).toEqual([]);
    expect(aliases["@earendil-works/pi-coding-agent"]).toBeTruthy();
    expect(aliases["@earendil-works/pi-agent-core"]).toBeTruthy();
  });
});
