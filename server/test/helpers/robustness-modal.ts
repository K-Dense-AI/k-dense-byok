import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ModalAdapter, ModalRemoteFilesystem, ModalRemoteSandbox, ModalRemoteProcess } from "../../src/modal/adapter.ts";
import { ModalJobError } from "../../src/modal/types.ts";

class Filesystem implements ModalRemoteFilesystem {
  files = new Map<string, Buffer>();
  async makeDirectory() {}
  async copyFromLocal(local: string, remote: string) { this.files.set(remote, fs.readFileSync(local)); }
  async copyToLocal(remote: string, local: string) { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, this.files.get(remote)!); }
  async writeText(data: string, remote: string) { this.files.set(remote, Buffer.from(data)); }
  async readText(remote: string) { if (!this.files.has(remote)) throw new Error("missing"); return this.files.get(remote)!.toString("utf8"); }
  async readBytes(remote: string) { if (!this.files.has(remote)) throw new Error("missing"); return new Uint8Array(this.files.get(remote)!); }
  // Mirrors the SDK adapter, which classifies SandboxFilesystemNotFoundError as REMOTE_NOT_FOUND.
  async stat(remote: string): Promise<any> { const data = this.files.get(remote); if (!data) throw new ModalJobError("REMOTE_NOT_FOUND", `not found: ${remote}`, 404); return { type: "file", path: remote, size: data.length }; }
  async listFiles(dir: string): Promise<any[]> {
    const prefix = dir.replace(/\/$/, "") + "/"; const children = new Map<string, string>();
    for (const file of this.files.keys()) if (file.startsWith(prefix)) { const rest = file.slice(prefix.length); if (rest) children.set(rest.split("/")[0], rest.includes("/") ? "directory" : "file"); }
    return [...children].map(([name, type]) => ({ name, path: prefix + name, type, size: this.files.get(prefix + name)?.length ?? 0 }));
  }
}
export class RobustnessFakeModal {
  created = 0; prepared = 0; executions = 0; verifications = 0;
  createError = false; terminationError = false; tamperUpload = false;
  behaviors: Record<string, "success" | "fail" | "missing" | "invalid" | "qc-fail" | "hang" | "oversized"> = {};
  sandboxes = new Map<string, FakeSandbox>();
  factory = (): ModalAdapter => ({
    validate: async () => {}, clearCache: async () => {}, close: () => {},
    prepareEnvironment: async () => { this.prepared++; return { appId: "test", appName: "test", cacheName: null, opaque: {} }; },
    createSandbox: async () => { this.created++; if (this.createError) throw new Error("ambiguous creation"); const s = new FakeSandbox(`fake-${this.created}`, this); this.sandboxes.set(s.id, s); return s; },
    fromId: async (id) => { const s = this.sandboxes.get(id); if (!s) throw new Error("not found"); return s; },
    findByTags: async () => null,
  });
}
class FakeSandbox implements ModalRemoteSandbox {
  filesystem = new Filesystem(); terminated = false; reject?: (e: Error) => void;
  constructor(readonly id: string, private fake: RobustnessFakeModal) {}
  detach() {}
  async poll() { return this.terminated ? 0 : null; }
  async terminate() { if (this.fake.terminationError) throw new Error("termination unconfirmed"); this.terminated = true; this.reject?.(new Error("terminated")); }
  async exec(command: string[]): Promise<ModalRemoteProcess> {
    if (command[0] === "mv") {
      this.filesystem.files.set(command[3], this.filesystem.files.get(command[2])!); this.filesystem.files.delete(command[2]);
      return { wait: async () => 0 };
    }
    if (command.includes("-c")) {
      if (!command.includes("-I")) throw new Error("Checksum verification must isolate Python from uploaded module names");
      const listPath = command[4]!;
      if (listPath.endsWith("outputs.json")) {
        const paths = JSON.parse(await this.filesystem.readText(listPath)) as string[];
        const lines = paths.map((p) => `${crypto.createHash("sha256").update(this.filesystem.files.get(`/workspace/${p}`)!).digest("hex")} ${p}`);
        await this.filesystem.writeText(lines.join("\n") + (lines.length ? "\n" : ""), command[5]!);
        return { wait: async () => 0 };
      }
      this.fake.verifications++;
      const manifest = JSON.parse(await this.filesystem.readText(listPath));
      const valid = !this.fake.tamperUpload && manifest.every((f: any) => crypto.createHash("sha256").update(this.filesystem.files.get(`/workspace/${f.path}`)!).digest("hex") === f.sha256);
      return { wait: async () => valid ? 0 : 1 };
    }
    this.fake.executions++;
    const configPath = [...this.filesystem.files.keys()].find((p) => p.includes("/__kady_robustness/") && p.endsWith(".json"))!;
    const spec = JSON.parse(await this.filesystem.readText(configPath));
    const behavior = this.fake.behaviors[spec.key] ?? "success";
    if (behavior === "hang") return { wait: () => new Promise<number>((_, reject) => { this.reject = reject; }) };
    const request = await this.filesystem.readText("/workspace/.kady-job/command.sh");
    const output = /--output '([^']+)'/.exec(request)![1];
    const result = { schemaVersion: 1, metric: spec.metric, unit: spec.unit, ...(behavior !== "qc-fail" ? { estimate: spec.parameters.effect ?? 1, interval: { low: 0, high: 2, level: 0.95 } } : {}), qc: behavior === "qc-fail" ? "fail" : "pass", notes: "Test-only script output" };
    if (behavior !== "missing") await this.filesystem.writeText(behavior === "invalid" ? "not json" : behavior === "oversized" ? "x".repeat(70000) : JSON.stringify(result), `/workspace/${output}`);
    await this.filesystem.writeText(JSON.stringify({ state: "finished", exitCode: behavior === "fail" ? 1 : 0 }), "/workspace/.kady-job/status.json");
    await this.filesystem.writeText("test log\n", "/workspace/.kady-job/stdout.log");
    await this.filesystem.writeText("", "/workspace/.kady-job/stderr.log");
    return { wait: async () => 0 };
  }
}
