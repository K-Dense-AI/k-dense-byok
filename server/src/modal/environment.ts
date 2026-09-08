import fs from "node:fs";
import path from "node:path";
import { atomicJson } from "../atomic-json.ts";
import { resolvePaths } from "../projects.ts";
import type { ModalAdapter, ModalEnvironment } from "./adapter.ts";
import type { ModalImageRequest } from "./types.ts";

export interface ModalCacheMetadata {
  version: 1;
  projectId: string;
  volumeName: string;
  mountPath: "/cache";
  canonical: false;
  updatedAt: number;
}

export interface ModalEnvironmentMetadata {
  version: 1;
  projectId: string;
  name: string;
  publishedImage: string;
  imageId?: string;
  updatedAt: number;
}

function cacheMetadataPath(projectId: string): string {
  return path.join(resolvePaths(projectId).modalCacheDir, "cache.json");
}

/**
 * The one rule for a user-facing environment name: lowercase, hyphenated,
 * at most 24 characters. Shared by the metadata filename and the published
 * Modal image name so the two cannot diverge.
 */
export function safeEnvironmentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function environmentMetadataPath(projectId: string, name: string): string {
  const safe = safeEnvironmentName(name);
  if (!safe) throw new Error("Invalid Modal environment name");
  return path.join(resolvePaths(projectId).modalEnvironmentsDir, `${safe}.json`);
}

function writeCacheMetadata(value: ModalCacheMetadata): void {
  atomicJson(cacheMetadataPath(value.projectId), value);
}

export function readModalCacheMetadata(projectId: string): ModalCacheMetadata | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(cacheMetadataPath(projectId), "utf-8"),
    ) as ModalCacheMetadata;
    return value?.version === 1 && value.projectId === projectId ? value : null;
  } catch {
    return null;
  }
}

export async function prepareModalEnvironment(
  adapter: ModalAdapter,
  projectId: string,
  image: ModalImageRequest | undefined,
  defaultImage: string,
  environment?: string,
  cache: "project" | "none" = "project",
): Promise<ModalEnvironment> {
  const prepared = await adapter.prepareEnvironment(
    projectId,
    image,
    defaultImage,
    environment,
    cache,
  );
  if (prepared.cacheName) {
    writeCacheMetadata({
      version: 1,
      projectId,
      volumeName: prepared.cacheName,
      mountPath: "/cache",
      canonical: false,
      updatedAt: Date.now(),
    });
  }
  if (environment && prepared.snapshotName) {
    const metadata: ModalEnvironmentMetadata = {
      version: 1,
      projectId,
      name: environment,
      publishedImage: prepared.snapshotName,
      ...(prepared.imageId ? { imageId: prepared.imageId } : {}),
      updatedAt: Date.now(),
    };
    atomicJson(environmentMetadataPath(projectId, environment), metadata);
  }
  return prepared;
}

export async function clearModalCache(
  adapter: ModalAdapter,
  projectId: string,
): Promise<{ cleared: boolean; volumeName: string | null }> {
  const metadata = readModalCacheMetadata(projectId);
  if (!metadata) return { cleared: false, volumeName: null };
  await adapter.clearCache(metadata.volumeName);
  fs.rmSync(resolvePaths(projectId).modalCacheDir, { recursive: true, force: true });
  return { cleared: true, volumeName: metadata.volumeName };
}
