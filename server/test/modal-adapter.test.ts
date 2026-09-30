import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NotFoundError, type ModalClient } from "modal";
import { SdkModalAdapter, validateModalRuntime } from "../src/modal/adapter.ts";
import { resolveInstance, validateImageRequest } from "../src/modal/catalog.ts";
import { FakeSandbox } from "./helpers/fake-modal.ts";

/** Minimal stand-in for the parts of the Modal client `prepareEnvironment` touches. */
function stubClient(options: { published: boolean }) {
  const calls: string[] = [];
  const dockerCommands: string[] = [];
  const sandboxParams: unknown[] = [];
  const image: any = {
    imageId: "im-built",
    dockerfileCommands: (commands: string[]) => { dockerCommands.push(...commands); return image; },
    build: async () => {
      calls.push("build");
      return image;
    },
    publish: async (name: string) => {
      calls.push(`publish:${name}`);
    },
  };
  const client = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    volumes: { fromName: async () => ({}) },
    sandboxes: { create: async (_app: unknown, _image: unknown, params: unknown) => {
      sandboxParams.push(params);
      return { sandboxId: "sb-test", filesystem: {} };
    } },
    images: {
      fromRegistry: () => image,
      fromName: async (name: string) => {
        calls.push(`fromName:${name}`);
        if (!options.published) throw new NotFoundError(`Image '${name}' not found`);
        return { ...image, imageId: "im-published" };
      },
    },
    close() {},
  } as unknown as ModalClient;
  return { client, calls, dockerCommands, sandboxParams };
}

describe("SdkModalAdapter named environments", () => {
  it("reuses a previously published environment instead of rebuilding it", async () => {
    const { client, calls } = stubClient({ published: true });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const environment = await adapter.prepareEnvironment("proj", { pip: ["numpy"] }, "python:3.12", "My Env", "none");
    expect(environment.reusedSnapshot).toBe(true);
    expect(environment.imageId).toBe("im-published");
    expect(environment.snapshotName).toMatch(/^kady-proj-my-env:[0-9a-f]{16}$/);
    expect(calls.filter((call) => call === "build")).toHaveLength(0);
    expect(calls.some((call) => call.startsWith("publish:"))).toBe(false);
  });

  it("builds and publishes when nothing was published under that name yet", async () => {
    const { client, calls } = stubClient({ published: false });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const environment = await adapter.prepareEnvironment("proj", { pip: ["numpy"] }, "python:3.12", "My Env", "none");
    expect(environment.reusedSnapshot).toBe(false);
    expect(calls).toEqual([
      expect.stringMatching(/^fromName:kady-proj-my-env:/),
      "build",
      expect.stringMatching(/^publish:kady-proj-my-env:/),
    ]);
  });

  it("applies one name rule so metadata files and Modal image names agree", async () => {
    const { client } = stubClient({ published: true });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const long = "A_very_long_environment_name_beyond_twenty_four_chars";
    const environment = await adapter.prepareEnvironment("proj", undefined, "python:3.12", long, "none");
    expect(environment.snapshotName!.split(":")[0]).toBe(`kady-proj-${"a-very-long-environment-".slice(0, 24)}`);
  });

  it("does not reuse environments built by the previous unquoted package recipe", async () => {
    const { client, calls } = stubClient({ published: true });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const previousHash = crypto.createHash("sha256").update(JSON.stringify({ base: "python:3.13-slim", apt: [], pip: ["numpy>=2"] })).digest("hex").slice(0, 16);
    await adapter.prepareEnvironment("proj", { pip: ["numpy>=2"] }, "python:3.13-slim", "science", "none");
    expect(calls[0]).not.toBe(`fromName:kady-proj-science:${previousHash}`);
  });
});

describe("Modal image and resource contract", () => {
  it.skipIf(process.platform === "win32")("passes version ranges and extras to pip literally through the build shell", async () => {
    const { client, dockerCommands } = stubClient({ published: false });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const packages = ["numpy>=2,<3", "requests[socks]>=2", "scipy!=1.0", "torch~=2.6"];
    await adapter.prepareEnvironment("proj", { pip: packages }, "python:3.13-slim", undefined, "none");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-package-args-"));
    try {
      const command = dockerCommands[0].replace(/^RUN /, "");
      const result = spawnSync("/bin/sh", ["-c", 'pip() { printf "%s\\n" "$@"; }; ' + command], { cwd: dir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["install", "--no-cache-dir", ...packages]);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("quotes apt pins and rejects package-manager flags as package names", async () => {
    const { client, dockerCommands } = stubClient({ published: false });
    await new SdkModalAdapter(undefined, undefined, client).prepareEnvironment("proj", { apt: ["libfoo=1.2"] }, "python:3.13-slim", undefined, "none");
    expect(dockerCommands[0]).toContain("'libfoo=1.2'");
    expect(() => validateImageRequest({ pip: ["--no-deps"] })).toThrow(/invalid/);
  });

  it("caps CPU and memory at exactly the resources included in the estimate", async () => {
    const { client, sandboxParams } = stubClient({ published: false });
    const adapter = new SdkModalAdapter(undefined, undefined, client);
    const environment = await adapter.prepareEnvironment("proj", undefined, "python:3.13-slim", undefined, "none");
    await adapter.createSandbox(environment, { instance: resolveInstance("t4")!, gpuCount: 2, timeoutMs: 1000, name: "test", tags: {} });
    expect(sandboxParams[0]).toMatchObject({ gpu: "T4:2", cpu: 2, cpuLimit: 2, memoryMiB: 8192, memoryLimitMiB: 8192 });
  });

  it("reports missing or unusable Python as an actionable non-retryable image error", async () => {
    const sandbox = new FakeSandbox("sb-runtime", { kind: "success" });
    sandbox.pythonMissing = true;
    await expect(validateModalRuntime(sandbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: false });
    sandbox.exec = async () => ({ wait: async () => 1 });
    await expect(validateModalRuntime(sandbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: false });
  });
});
