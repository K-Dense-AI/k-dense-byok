import crypto from "node:crypto";
import {
  ModalClient,
  type App,
  type ContainerProcess,
  type FileInfo,
  type Image,
  type Sandbox,
  type Volume,
} from "modal";
import { gpuString, type ModalInstanceSpec } from "./catalog.ts";
import { ModalJobError, type ModalImageRequest } from "./types.ts";

export interface ModalRemoteProcess {
  wait(): Promise<number>;
}

export interface ModalRemoteFilesystem {
  makeDirectory(remotePath: string, options?: { createParents?: boolean }): Promise<void>;
  copyFromLocal(localPath: string, remotePath: string): Promise<void>;
  copyToLocal(remotePath: string, localPath: string): Promise<void>;
  listFiles(remotePath: string): Promise<readonly FileInfo[]>;
  stat(remotePath: string): Promise<FileInfo>;
  readText(remotePath: string): Promise<string>;
  writeText(data: string, remotePath: string): Promise<void>;
}

export interface ModalRemoteSandbox {
  readonly id: string;
  readonly filesystem: ModalRemoteFilesystem;
  exec(
    command: string[],
    params?: {
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore";
      workdir?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<ModalRemoteProcess>;
  terminate(): Promise<void>;
  poll(): Promise<number | null>;
  detach(): void;
}

export interface ModalEnvironment {
  appId: string;
  appName: string;
  cacheName: string | null;
  snapshotName?: string;
  imageId?: string;
  opaque: unknown;
}

export interface ModalCreateSandboxParams {
  instance: ModalInstanceSpec;
  gpuCount: number;
  timeoutMs: number;
  name: string;
  tags: Record<string, string>;
}

export interface ModalAdapter {
  validate(): Promise<void>;
  prepareEnvironment(
    projectId: string,
    image: ModalImageRequest | undefined,
    defaultImage: string,
    environment?: string,
    cache?: "project" | "none",
  ): Promise<ModalEnvironment>;
  createSandbox(
    environment: ModalEnvironment,
    params: ModalCreateSandboxParams,
  ): Promise<ModalRemoteSandbox>;
  fromId(sandboxId: string): Promise<ModalRemoteSandbox>;
  clearCache(cacheName: string): Promise<void>;
  close(): void;
}

export type ModalAdapterFactory = () => ModalAdapter;

function credentials(): { tokenId: string; tokenSecret: string } {
  const tokenId = process.env.MODAL_TOKEN_ID?.trim();
  const tokenSecret = process.env.MODAL_TOKEN_SECRET?.trim();
  if (!tokenId || !tokenSecret) {
    throw new ModalJobError(
      "NOT_CONFIGURED",
      "Modal is not configured. Add both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings.",
      503,
    );
  }
  return { tokenId, tokenSecret };
}

const PACKAGE_TOKEN_RE = /^[A-Za-z0-9_.+@/:<>=!~,[\]-]+$/;
const IMAGE_RE = /^[A-Za-z0-9._:@/+-]+$/;

function checkedTokens(values: string[] | undefined, field: "pip" | "apt"): string[] {
  return (values ?? []).map((raw) => {
    const value = raw.trim();
    if (!value || value.length > 240 || !PACKAGE_TOKEN_RE.test(value)) {
      throw new ModalJobError(
        "INVALID_IMAGE",
        `Unsafe or invalid ${field} package token: ${JSON.stringify(raw)}`,
      );
    }
    return value;
  });
}

function checkedImageBase(value: string): string {
  const base = value.trim();
  if (!base || base.length > 500 || !IMAGE_RE.test(base)) {
    throw new ModalJobError("INVALID_IMAGE", "Invalid registry image name");
  }
  return base;
}

class SdkRemoteSandbox implements ModalRemoteSandbox {
  readonly id: string;
  readonly filesystem: ModalRemoteFilesystem;
  private sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
    this.filesystem = sandbox.filesystem;
  }

  async exec(
    command: string[],
    params?: {
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore";
      workdir?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<ModalRemoteProcess> {
    return (await this.sandbox.exec(command, params)) as ContainerProcess<string>;
  }

  async terminate(): Promise<void> {
    await this.sandbox.terminate();
  }

  poll(): Promise<number | null> {
    return this.sandbox.poll();
  }

  detach(): void {
    this.sandbox.detach();
  }
}

interface SdkEnvironmentOpaque {
  app: App;
  image: Image;
  volume: Volume | null;
}

export class SdkModalAdapter implements ModalAdapter {
  private client: ModalClient;

  constructor(tokenId?: string, tokenSecret?: string) {
    const pair = tokenId && tokenSecret ? { tokenId, tokenSecret } : credentials();
    this.client = new ModalClient(pair);
  }

  async validate(): Promise<void> {
    // `list().next()` is read-only and harmless. It proves both credentials
    // authenticate without creating apps, sandboxes, images, or volumes.
    const iterator = this.client.sandboxes.list({ tags: { "kady-validation": "never" } });
    await iterator.next();
  }

  async prepareEnvironment(
    projectId: string,
    request: ModalImageRequest | undefined,
    defaultImage: string,
    environment?: string,
    cache: "project" | "none" = "project",
  ): Promise<ModalEnvironment> {
    const appName = "kady";
    const cacheName = `kady-cache-${projectId}`.slice(0, 63);
    const app = await this.client.apps.fromName(appName, { createIfMissing: true });
    const volume =
      cache === "project"
        ? await this.client.volumes.fromName(cacheName, { createIfMissing: true })
        : null;
    const base = checkedImageBase(request?.base ?? defaultImage);
    let image = this.client.images.fromRegistry(base);
    const apt = checkedTokens(request?.apt, "apt");
    const pip = checkedTokens(request?.pip, "pip");
    const commands: string[] = [];
    if (apt.length) {
      commands.push(
        `RUN apt-get update && apt-get install -y --no-install-recommends ${apt.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      );
    }
    if (pip.length) commands.push(`RUN pip install --no-cache-dir ${pip.join(" ")}`);
    if (commands.length) image = image.dockerfileCommands(commands);
    let snapshotName: string | undefined;
    if (environment) {
      const safeEnvironment = environment
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
      if (!safeEnvironment) {
        throw new ModalJobError("INVALID_ENVIRONMENT", "environment must contain a letter or digit");
      }
      const specHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ base, apt, pip }))
        .digest("hex")
        .slice(0, 16);
      snapshotName = `kady-${projectId}-${safeEnvironment}:${specHash}`.slice(0, 127);
      image = await image.build(app);
      await image.publish(snapshotName);
    }
    return {
      appId: app.appId,
      appName,
      cacheName: volume ? cacheName : null,
      ...(snapshotName ? { snapshotName, imageId: image.imageId } : {}),
      opaque: { app, image, volume } satisfies SdkEnvironmentOpaque,
    };
  }

  async createSandbox(
    environment: ModalEnvironment,
    params: ModalCreateSandboxParams,
  ): Promise<ModalRemoteSandbox> {
    const { app, image, volume } = environment.opaque as SdkEnvironmentOpaque;
    const sandbox = await this.client.sandboxes.create(app, image, {
      gpu: gpuString(params.instance, params.gpuCount),
      cpu: params.instance.cpu,
      memoryMiB: params.instance.memoryMiB,
      timeoutMs: params.timeoutMs,
      workdir: "/workspace",
      ...(volume ? { volumes: { "/cache": volume } } : {}),
      name: params.name,
      tags: params.tags,
    });
    return new SdkRemoteSandbox(sandbox);
  }

  async fromId(sandboxId: string): Promise<ModalRemoteSandbox> {
    return new SdkRemoteSandbox(await this.client.sandboxes.fromId(sandboxId));
  }

  async clearCache(cacheName: string): Promise<void> {
    await this.client.volumes.delete(cacheName, { allowMissing: true });
  }

  close(): void {
    this.client.close();
  }
}

export const sdkModalAdapterFactory: ModalAdapterFactory = () => new SdkModalAdapter();

export async function validateModalCredentials(
  tokenId: string,
  tokenSecret: string,
): Promise<void> {
  const adapter = new SdkModalAdapter(tokenId, tokenSecret);
  try {
    await adapter.validate();
  } finally {
    adapter.close();
  }
}
