import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subagentsPackageDir } from "../src/agent/agent-files.ts";
import { patchSubagents } from "../scripts/patch-subagents.mjs";

patchSubagents();
const upstream = (file: string) => import(pathToFileURL(path.join(subagentsPackageDir(), "src/watchdog", file)).href);
const { computeWatchdogRepoChangeSignature } = await upstream("change-signature.js");
const { captureWatchdogDiffBaseline } = await upstream("diff-tool.js");
const { MainWatchdogRuntime } = await upstream("runtime.js");
const { DEFAULT_WATCHDOG_CONFIG } = await upstream("settings.js");
let root: string;
let sandbox: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-watchdog-scope-"));
  sandbox = path.join(root, "projects", "study", "sandbox");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "projects/\n");
  git("init", "-q");
  git("add", ".gitignore");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture");
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", "test-host");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it("does not inspect or expose an ancestor checkout for an ignored sandbox", () => {
  fs.writeFileSync(path.join(root, "unrelated.txt"), "outside project");
  expect(computeWatchdogRepoChangeSignature(sandbox)).toBeUndefined();
  expect(captureWatchdogDiffBaseline(sandbox)).toBeUndefined();
});

it("reviews a successful sandbox write even when the parent Git status is unchanged", async () => {
  const review = vi.fn(async (_request: { delta: string }) => ({ warnings: [], stopReason: "stop" }));
  const runtime = new MainWatchdogRuntime({
    cwd: sandbox, review, reviewChangesOnly: true,
    resolveConfig: () => ({ ok: true, config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: true,
      main: { enabled: true }, lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: false } }, sources: [], errors: [] }),
  });
  const ctx = { cwd: sandbox };
  runtime.bindSession(ctx);
  fs.writeFileSync(path.join(sandbox, "result.md"), "333 complete cases");
  runtime.handleTurnEnd({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Created result.md" }] },
    toolResults: [{ role: "toolResult", toolName: "write", content: [{ type: "text", text: "Wrote result.md" }], isError: false }] }, ctx);
  await runtime.handleAgentEnd({}, ctx);
  expect(review).toHaveBeenCalledOnce();
  expect(review.mock.calls[0][0].delta).toContain("result.md");
  runtime.dispose();
});

it("retains Git detection for a checkout rooted at the working directory", () => {
  fs.writeFileSync(path.join(root, "result.md"), "new analysis");
  expect(computeWatchdogRepoChangeSignature(root).changedPaths).toContain("result.md");
  expect(fs.realpathSync.native(captureWatchdogDiffBaseline(root).root)).toBe(fs.realpathSync.native(root));
});

it("leaves standalone Pi behavior unchanged outside the Kady host", () => {
  vi.stubEnv("KADY_SUBAGENT_HOST_MODULE", "");
  expect(fs.realpathSync.native(computeWatchdogRepoChangeSignature(sandbox).root)).toBe(fs.realpathSync.native(root));
  expect(fs.realpathSync.native(captureWatchdogDiffBaseline(sandbox).root)).toBe(fs.realpathSync.native(root));
});
