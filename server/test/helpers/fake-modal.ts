import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ModalAdapter,
  ModalEnvironment,
  ModalRemoteFilesystem,
  ModalRemoteProcess,
  ModalRemoteSandbox,
} from "../../src/modal/adapter.ts";
import { ModalJobError, type ModalJob } from "../../src/modal/types.ts";

/**
 * In-memory Modal double shared by the manager, tool, package and API tests.
 * Behaviours are consumed in submission order; sandboxes are addressable by id
 * so recovery paths can reattach to them.
 */
export type Behavior =
  | { kind: "success"; exitCode?: number; stdout?: string; stderr?: string }
  | { kind: "failure"; message: string }
  | { kind: "hang" };

export class FakeFilesystem implements ModalRemoteFilesystem {
  files = new Map<string, Buffer>();
  /** Corrupt uploads (a racing local write) so the remote verifier must catch it. */
  tamperUploads = false;
  /** Corrupt downloads: "flip" keeps the size, "truncate" shortens the file. */
  tamperDownloads: "flip" | "truncate" | null = null;

  async makeDirectory(): Promise<void> {}

  async copyFromLocal(localPath: string, remotePath: string): Promise<void> {
    const bytes = fs.readFileSync(localPath);
    this.files.set(remotePath, this.tamperUploads ? Buffer.concat([bytes, Buffer.from("!")]) : bytes);
  }

  async copyToLocal(remotePath: string, localPath: string): Promise<void> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error(`missing remote file ${remotePath}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    let out = value;
    if (this.tamperDownloads === "flip" && value.length) {
      out = Buffer.from(value);
      out[0] = out[0] ^ 0xff;
    } else if (this.tamperDownloads === "truncate") {
      out = value.subarray(0, Math.max(0, value.length - 1));
    }
    fs.writeFileSync(localPath, out);
  }

  async listFiles(remotePath: string): Promise<any[]> {
    const prefix = `${remotePath.replace(/\/+$/, "")}/`;
    const found = new Map<string, "file" | "directory">();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split("/")[0];
      found.set(first, rest.includes("/") ? "directory" : "file");
    }
    return [...found.entries()].map(([name, type]) => {
      const filePath = `${prefix}${name}`;
      return {
        name,
        path: filePath,
        type,
        size: type === "file" ? this.files.get(filePath)?.length ?? 0 : 0,
        mode: 0,
        permissions: "",
        owner: "",
        group: "",
        modifiedTime: 0,
        symlinkTarget: null,
      };
    });
  }

  async stat(remotePath: string): Promise<any> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error("not found");
    return { path: remotePath, name: path.posix.basename(remotePath), type: "file", size: value.length };
  }

  async readText(remotePath: string): Promise<string> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error(`not found: ${remotePath}`);
    return value.toString("utf-8");
  }

  async readBytes(remotePath: string): Promise<Uint8Array> {
    const value = this.files.get(remotePath);
    if (!value) throw new Error(`not found: ${remotePath}`);
    return new Uint8Array(value);
  }

  async writeText(data: string, remotePath: string): Promise<void> {
    this.files.set(remotePath, Buffer.from(data));
  }
}

export class FakeSandbox implements ModalRemoteSandbox {
  readonly id: string;
  readonly filesystem = new FakeFilesystem();
  terminated = false;
  tags: Record<string, string> = {};
  /** Number of terminate() calls that should fail before one succeeds. */
  terminateFailures = 0;
  behavior: Behavior;
  private rejectWait?: (error: Error) => void;

  constructor(id: string, behavior: Behavior) {
    this.id = id;
    this.behavior = behavior;
  }

  execParams: Array<{ command: string[]; params?: Record<string, unknown> }> = [];

  /** Emulate a sandbox image without python3: every python3 exec fails to start. */
  pythonMissing = false;

  async exec(command: string[], params?: Record<string, unknown>): Promise<ModalRemoteProcess> {
    this.execParams.push({ command, params });
    if (command[0] === "mv") {
      const source = command[2];
      const destination = command[3];
      const value = this.filesystem.files.get(source);
      if (!value) throw new Error(`missing staged input ${source}`);
      this.filesystem.files.set(destination, value);
      this.filesystem.files.delete(source);
      return { wait: async () => 0 };
    }
    if (command[0] === "python3" && this.pythonMissing) {
      throw new Error("executable file not found in $PATH: python3");
    }
    // The transfer layer's inline verifier / hasher scripts (python3 -I -c ...).
    if (command[0] === "python3" && command[1] === "-I" && command[2] === "-c") {
      const listPath = command[4];
      const digest = (rel: string) => {
        const bytes = this.filesystem.files.get(`/workspace/${rel}`);
        return bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
      };
      if (listPath?.endsWith("inputs.json")) {
        const manifest = JSON.parse(this.filesystem.files.get(listPath)!.toString("utf-8")) as { path: string; sha256: string }[];
        const ok = manifest.every((file) => digest(file.path) === file.sha256);
        return { wait: async () => (ok ? 0 : 1) };
      }
      if (listPath?.endsWith("outputs.json")) {
        const paths = JSON.parse(this.filesystem.files.get(listPath)!.toString("utf-8")) as string[];
        const lines = paths.map((rel) => `${digest(rel) ?? "0".repeat(64)} ${rel}`);
        this.filesystem.files.set(command[5], Buffer.from(lines.join("\n") + (lines.length ? "\n" : "")));
        return { wait: async () => 0 };
      }
    }
    this.filesystem.files.set(
      "/workspace/.kady-job/status.json",
      Buffer.from(JSON.stringify({ state: "running", startedAt: Date.now() / 1000 })),
    );
    return {
      wait: () =>
        new Promise<number>((resolve, reject) => {
          this.rejectWait = reject;
          if (this.behavior.kind === "hang") return;
          setTimeout(() => {
            if (this.terminated) {
              reject(new Error("terminated"));
              return;
            }
            if (this.behavior.kind === "failure") {
              reject(new Error(this.behavior.message));
              return;
            }
            const exitCode = this.behavior.exitCode ?? 0;
            this.filesystem.files.set(
              "/workspace/.kady-job/stdout.log",
              Buffer.from(this.behavior.stdout ?? "ok\n"),
            );
            this.filesystem.files.set(
              "/workspace/.kady-job/stderr.log",
              Buffer.from(this.behavior.stderr ?? ""),
            );
            this.filesystem.files.set("/workspace/result.txt", Buffer.from("result\n"));
            this.filesystem.files.set(
              "/workspace/.kady-job/status.json",
              Buffer.from(JSON.stringify({ state: "finished", exitCode })),
            );
            resolve(0);
          }, 5);
        }),
    };
  }

  async terminate(): Promise<void> {
    if (this.terminateFailures > 0) {
      this.terminateFailures--;
      throw new Error("terminate RPC timed out");
    }
    this.terminated = true;
    this.rejectWait?.(new Error("terminated"));
  }

  async poll(): Promise<number | null> {
    return this.terminated ? 1 : null;
  }

  detach(): void {}
}

export class FakeModal {
  behaviors: Behavior[] = [];
  createErrors: Error[] = [];
  sandboxes = new Map<string, FakeSandbox>();
  prepared: Array<{ environment?: string; cache?: "project" | "none" }> = [];
  createParams: Array<{ timeoutMs: number; name: string; tags: Record<string, string> }> = [];
  /** Per created sandbox (in order): how many terminate() calls fail first. */
  terminateFailures: number[] = [];
  nextId = 1;

  factory = (): ModalAdapter => {
    const parent = this;
    return {
      async validate() {},
      async prepareEnvironment(
        _projectId,
        _image,
        _defaultImage,
        environment,
        cache,
      ): Promise<ModalEnvironment> {
        parent.prepared.push({ environment, cache });
        return {
          appId: "app",
          appName: "kady",
          cacheName: cache === "none" ? null : "cache",
          ...(environment
            ? { snapshotName: `published:${environment}`, imageId: "im-test" }
            : {}),
          opaque: {},
        };
      },
      async createSandbox(_environment, params) {
        parent.createParams.push({ timeoutMs: params.timeoutMs, name: params.name, tags: params.tags });
        const createError = parent.createErrors.shift();
        if (createError) throw createError;
        const sandbox = new FakeSandbox(
          `sb-${parent.nextId++}`,
          parent.behaviors.shift() ?? { kind: "success" },
        );
        sandbox.tags = { ...params.tags };
        sandbox.terminateFailures = parent.terminateFailures.shift() ?? 0;
        parent.sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
      async fromId(id: string) {
        const sandbox = parent.sandboxes.get(id);
        if (!sandbox) throw new ModalJobError("REMOTE_NOT_FOUND", "sandbox not found", 404);
        return sandbox;
      },
      async findByTags(tags: Record<string, string>) {
        for (const sandbox of parent.sandboxes.values()) {
          if (sandbox.terminated) continue;
          if (Object.entries(tags).every(([key, value]) => sandbox.tags[key] === value)) return sandbox;
        }
        return null;
      },
      async clearCache() {},
      close() {},
    };
  };
}

export function persistedRunningJob(args: {
  id: string;
  sandboxId: string;
  sessionId: string;
  filesOut?: string[];
}): ModalJob {
  const now = Date.now();
  return {
    version: 1,
    id: args.id,
    projectId: "default",
    state: "running",
    request: {
      command: "work",
      instance: "cpu",
      gpuCount: 1,
      timeoutSec: 600,
      ...(args.filesOut ? { filesOut: args.filesOut } : {}),
    },
    owner: { sessionId: args.sessionId, submittedBy: "api" },
    createdAt: now - 100,
    updatedAt: now,
    queuedAt: now - 100,
    preparingAt: now - 90,
    runningAt: now - 80,
    cancelRequested: false,
    reservationUsd: 0.01,
    effectiveInstance: "cpu",
    effectiveGpu: null,
    pricePerHour: 0.05,
    sandboxId: args.sandboxId,
    sandboxName: `kady-${args.id}`,
    sandboxTags: { kady: "true", project: "default", job: args.id },
    sandboxCreatedAt: now - 75,
    inputFiles: [],
    outputFiles: [],
    missingOutputs: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutBaseCursor: 0,
    stderrBaseCursor: 0,
    eventSeq: 0,
    accounting: { reconciled: false },
  };
}
