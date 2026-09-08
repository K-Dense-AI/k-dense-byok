import crypto from "node:crypto";
import {
  ClientClosedError,
  FunctionTimeoutError,
  InvalidError,
  ModalClient,
  NotFoundError,
  SandboxFilesystemError,
  SandboxFilesystemFileTooLargeError,
  SandboxFilesystemNotFoundError,
  SandboxTimeoutError,
  TimeoutError,
  type App,
  type ContainerProcess,
  type FileInfo,
  type Image,
  type Sandbox,
  type Volume,
} from "modal";
import { checkedImageBase, gpuString, validateImageRequest, type ModalInstanceSpec } from "./catalog.ts";
import { safeEnvironmentName } from "./environment.ts";
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
  /** A previously published named environment was reused instead of rebuilt. */
  reusedSnapshot?: boolean;
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
  /** First live sandbox carrying every given tag, or null. */
  findByTags(tags: Record<string, string>): Promise<ModalRemoteSandbox | null>;
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

/**
 * Map an error thrown by the Modal SDK (or the gRPC layer underneath it) to a
 * typed `ModalJobError` with an honest `retryable` flag. Without this every SDK
 * failure — a revoked token included — reads as a retryable "remote failure"
 * and the manager cycles the whole instance fallback chain on it.
 */
export function classifyModalError(error: unknown): ModalJobError {
  if (error instanceof ModalJobError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = (error as { name?: unknown })?.name;
  const grpcCode = (error as { code?: unknown })?.code;
  // nice-grpc ClientError is not re-exported by the SDK; 16 = UNAUTHENTICATED,
  // 7 = PERMISSION_DENIED.
  if (
    (name === "ClientError" && (grpcCode === 16 || grpcCode === 7)) ||
    /UNAUTHENTICATED|PERMISSION_DENIED|invalid token|token (id|secret)?\s*(is )?(invalid|expired)/i.test(message)
  ) {
    return new ModalJobError("AUTH_FAILED", `Modal rejected the configured credentials: ${message}`, 401, false);
  }
  if (/Image build .*failed/i.test(message)) {
    return new ModalJobError("IMAGE_BUILD_FAILED", message, 422, false);
  }
  if (error instanceof InvalidError) return new ModalJobError("INVALID_REQUEST", message, 400, false);
  if (error instanceof NotFoundError || error instanceof SandboxFilesystemNotFoundError) {
    return new ModalJobError("REMOTE_NOT_FOUND", message, 404, false);
  }
  if (error instanceof SandboxFilesystemFileTooLargeError) {
    return new ModalJobError("OUTPUT_TOO_LARGE", message, 413, false);
  }
  if (
    error instanceof SandboxTimeoutError ||
    error instanceof FunctionTimeoutError ||
    error instanceof TimeoutError ||
    /timeout|timed out/i.test(message)
  ) {
    return new ModalJobError("TIMEOUT", message, 504, true);
  }
  if (error instanceof ClientClosedError) return new ModalJobError("CLIENT_CLOSED", message, 503, true);
  if (error instanceof SandboxFilesystemError) return new ModalJobError("REMOTE_FS_ERROR", message, 502, true);
  return new ModalJobError("REMOTE_FAILURE", message, 502, true);
}

async function classified<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw classifyModalError(error);
  }
}

/** Every filesystem call surfaces a classified error. */
function classifiedFilesystem(fs: Sandbox["filesystem"]): ModalRemoteFilesystem {
  return {
    makeDirectory: (remotePath, options) => classified(fs.makeDirectory(remotePath, options)),
    copyFromLocal: (localPath, remotePath) => classified(fs.copyFromLocal(localPath, remotePath)),
    copyToLocal: (remotePath, localPath) => classified(fs.copyToLocal(remotePath, localPath)),
    listFiles: (remotePath) => classified(fs.listFiles(remotePath)),
    stat: (remotePath) => classified(fs.stat(remotePath)),
    readText: (remotePath) => classified(fs.readText(remotePath)),
    writeText: (data, remotePath) => classified(fs.writeText(data, remotePath)),
  };
}

class SdkRemoteSandbox implements ModalRemoteSandbox {
  readonly id: string;
  readonly filesystem: ModalRemoteFilesystem;
  private sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
    this.filesystem = classifiedFilesystem(sandbox.filesystem);
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
    const process = (await classified(this.sandbox.exec(command, params))) as ContainerProcess<string>;
    return { wait: () => classified(process.wait()) };
  }

  async terminate(): Promise<void> {
    await classified(this.sandbox.terminate());
  }

  poll(): Promise<number | null> {
    return classified(this.sandbox.poll());
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

  constructor(tokenId?: string, tokenSecret?: string, client?: ModalClient) {
    if (client) {
      this.client = client;
      return;
    }
    const pair = tokenId && tokenSecret ? { tokenId, tokenSecret } : credentials();
    this.client = new ModalClient(pair);
  }

  async validate(): Promise<void> {
    // `list().next()` is read-only and harmless. It proves both credentials
    // authenticate without creating apps, sandboxes, images, or volumes.
    const iterator = this.client.sandboxes.list({ tags: { "kady-validation": "never" } });
    await classified(iterator.next());
  }

  prepareEnvironment(
    projectId: string,
    request: ModalImageRequest | undefined,
    defaultImage: string,
    environment?: string,
    cache: "project" | "none" = "project",
  ): Promise<ModalEnvironment> {
    return classified(this.prepareEnvironmentUnclassified(projectId, request, defaultImage, environment, cache));
  }

  private async prepareEnvironmentUnclassified(
    projectId: string,
    request: ModalImageRequest | undefined,
    defaultImage: string,
    environment: string | undefined,
    cache: "project" | "none",
  ): Promise<ModalEnvironment> {
    const appName = "kady";
    const cacheName = `kady-cache-${projectId}`.slice(0, 63);
    const app = await this.client.apps.fromName(appName, { createIfMissing: true });
    const volume =
      cache === "project"
        ? await this.client.volumes.fromName(cacheName, { createIfMissing: true })
        : null;
    // Requests are validated at submission; re-run the same rule here so the
    // adapter stays safe when driven directly (tests, future callers).
    const validated = validateImageRequest(request);
    const base = checkedImageBase(validated?.base ?? defaultImage);
    let image = this.client.images.fromRegistry(base);
    const apt = validated?.apt ?? [];
    const pip = validated?.pip ?? [];
    const commands: string[] = [];
    if (apt.length) {
      commands.push(
        `RUN apt-get update && apt-get install -y --no-install-recommends ${apt.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      );
    }
    if (pip.length) commands.push(`RUN pip install --no-cache-dir ${pip.join(" ")}`);
    if (commands.length) image = image.dockerfileCommands(commands);
    let snapshotName: string | undefined;
    let reusedSnapshot = false;
    if (environment) {
      const safeEnvironment = safeEnvironmentName(environment);
      if (!safeEnvironment) {
        throw new ModalJobError("INVALID_ENVIRONMENT", "environment must contain a letter or digit");
      }
      const specHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ base, apt, pip }))
        .digest("hex")
        .slice(0, 16);
      snapshotName = `kady-${projectId}-${safeEnvironment}:${specHash}`.slice(0, 127);
      // The name embeds the spec hash, so a hit is exactly this environment.
      // Reuse it; only build and publish when nothing was published before.
      const published = await this.client.images.fromName(snapshotName).catch((error) => {
        if (error instanceof NotFoundError || /not found/i.test(String((error as Error)?.message))) return null;
        throw error;
      });
      if (published) {
        image = published;
        reusedSnapshot = true;
      } else {
        image = await image.build(app);
        await image.publish(snapshotName);
      }
    }
    return {
      appId: app.appId,
      appName,
      cacheName: volume ? cacheName : null,
      ...(snapshotName ? { snapshotName, imageId: image.imageId, reusedSnapshot } : {}),
      opaque: { app, image, volume } satisfies SdkEnvironmentOpaque,
    };
  }

  async createSandbox(
    environment: ModalEnvironment,
    params: ModalCreateSandboxParams,
  ): Promise<ModalRemoteSandbox> {
    const { app, image, volume } = environment.opaque as SdkEnvironmentOpaque;
    const sandbox = await classified(
      this.client.sandboxes.create(app, image, {
        gpu: gpuString(params.instance, params.gpuCount),
        cpu: params.instance.cpu,
        memoryMiB: params.instance.memoryMiB,
        timeoutMs: params.timeoutMs,
        workdir: "/workspace",
        ...(volume ? { volumes: { "/cache": volume } } : {}),
        name: params.name,
        tags: params.tags,
      }),
    );
    return new SdkRemoteSandbox(sandbox);
  }

  async fromId(sandboxId: string): Promise<ModalRemoteSandbox> {
    return new SdkRemoteSandbox(await classified(this.client.sandboxes.fromId(sandboxId)));
  }

  async findByTags(tags: Record<string, string>): Promise<ModalRemoteSandbox | null> {
    const iterator = this.client.sandboxes.list({ tags });
    const first = await classified(iterator.next());
    return first.done || !first.value ? null : new SdkRemoteSandbox(first.value);
  }

  async clearCache(cacheName: string): Promise<void> {
    await classified(this.client.volumes.delete(cacheName, { allowMissing: true }));
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
