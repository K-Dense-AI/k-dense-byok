"use client";

import type { Database } from "@/components/database-selector";
import type { ModalInstance } from "@/components/compute-selector";
import type { Model } from "@/components/model-selector";
import type { ThinkingLevel } from "@/components/thinking-selector";
import type { PromptImage } from "@/lib/image-attachments";
import type { ModalComputeScope } from "@/lib/modal-jobs";
import type { Skill } from "@/lib/use-skills";

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_STORAGE_KEY = "kady:workspace:v1";

const DB_NAME = "kady-workspace";
const DB_VERSION = 1;
const BLOB_STORE = "blobs";
const MAX_TABS = 10;
const MAX_QUEUE = 5;

export type WorkspaceScreen = "projects" | "workspace";
export type WorkspaceView = "chat" | "workflows";

export interface PromptDraftAttachment {
  id: string;
  filename?: string;
  mediaType?: string;
  url: string;
}

export interface PromptDraftState {
  text: string;
  attachments: PromptDraftAttachment[];
}

export interface WorkspaceQueuedMessage {
  id: string;
  rawText: string;
  text: string;
  model: {
    id: string;
    label: string;
    fusionConfig?: Record<string, unknown>;
  };
  databases: Database[];
  skills: Skill[];
  files: string[];
  images: PromptImage[];
  computeTarget: string | null;
  computeOptions?: {
    gpuCount?: number;
    gpuFallback?: string[];
    cache?: "project" | "none";
  };
  thinkingLevel: ThinkingLevel | null;
  timestamp: number;
}

export interface ChatWorkspaceState {
  selectedModel: Model;
  thinkingLevel: ThinkingLevel;
  selectedComputeTarget: ModalInstance | null;
  attachedFiles: string[];
  selectedDatabases: Database[];
  selectedSkills: Skill[];
  queuedMessages: WorkspaceQueuedMessage[];
  composer: PromptDraftState;
}

export interface SandboxWorkspaceState {
  openPaths: string[];
  activePath: string | null;
}

export interface WorkspaceTabState {
  id: string;
  title: string;
  sessionId?: string;
  chat?: ChatWorkspaceState;
}

export interface ProjectWorkspaceState {
  tabs: WorkspaceTabState[];
  activeTabId: string;
  view: WorkspaceView;
  showNotebook: boolean;
  showCompute: boolean;
  computeScope: ModalComputeScope;
  sandboxOpen: boolean;
  chatOpen: boolean;
  treeWidth: number;
  chatWidth: number;
  sandbox: SandboxWorkspaceState;
}

export interface WorkspaceSnapshot {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  screen: WorkspaceScreen;
  openedProjectIds: string[];
  projects: Record<string, ProjectWorkspaceState>;
}

interface StoredBlobRef {
  key: string;
  filename?: string;
  mediaType?: string;
}

interface StoredQueuedMessage extends Omit<WorkspaceQueuedMessage, "images"> {
  images: StoredBlobRef[];
}

interface StoredChatState
  extends Omit<ChatWorkspaceState, "queuedMessages" | "composer"> {
  queuedMessages: StoredQueuedMessage[];
  composer: {
    text: string;
    attachments: StoredBlobRef[];
  };
}

interface StoredTabState extends Omit<WorkspaceTabState, "chat"> {
  chat?: StoredChatState;
}

interface StoredProjectState extends Omit<ProjectWorkspaceState, "tabs"> {
  tabs: StoredTabState[];
}

interface StoredWorkspaceMetadata {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  screen: WorkspaceScreen;
  openedProjectIds: string[];
  projects: Record<string, StoredProjectState>;
}

interface BlobRecord {
  key: string;
  blob: Blob;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
let metadataWriteChain = Promise.resolve();
const projectWriteChains = new Map<string, Promise<void>>();
const projectWriteVersions = new Map<string, number>();

const EMPTY_METADATA: StoredWorkspaceMetadata = {
  version: WORKSPACE_SCHEMA_VERSION,
  screen: "projects",
  openedProjectIds: [],
  projects: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && !!item.trim()))];
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function sanitizeObjectArray<T extends { id: string }>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is T => {
    if (!isRecord(item) || !stringValue(item.id) || seen.has(item.id as string)) return false;
    seen.add(item.id as string);
    return true;
  });
}

function sanitizeDatabases(value: unknown): Database[] {
  return sanitizeObjectArray<Database>(value).filter(
    (database) =>
      typeof database.name === "string" &&
      typeof database.url === "string" &&
      typeof database.description === "string" &&
      typeof database.category === "string" &&
      (database.domain === "science" || database.domain === "finance"),
  );
}

function sanitizeSkills(value: unknown): Skill[] {
  return sanitizeObjectArray<Skill>(value).filter(
    (skill) =>
      typeof skill.name === "string" &&
      typeof skill.description === "string",
  );
}

function sanitizeThinkingLevel(value: unknown, nullable = false): ThinkingLevel | null {
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (nullable && value === null) return null;
  return levels.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "high";
}

function sanitizeBlobRefs(value: unknown): StoredBlobRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const key = stringValue(item.key);
    if (!key) return [];
    return [{
      key,
      ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
      ...(typeof item.mediaType === "string" ? { mediaType: item.mediaType } : {}),
    }];
  });
}

function sanitizeModel(value: unknown): Model | null {
  if (!isRecord(value) || !stringValue(value.id) || !stringValue(value.label)) return null;
  return value as unknown as Model;
}

function sanitizeComputeTarget(value: unknown): ModalInstance | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim()) {
    return {
      id: value,
      label: value,
      gpu: null,
      gpuCount: 1,
      cpu: null,
      memoryMiB: null,
      pricePerHour: 0,
    };
  }
  if (!isRecord(value) || !stringValue(value.id)) return null;
  return {
    ...value,
    id: stringValue(value.id)!,
    label: stringValue(value.label) ?? stringValue(value.id)!,
  } as unknown as ModalInstance;
}

function sanitizeStoredChat(value: unknown): StoredChatState | undefined {
  if (!isRecord(value)) return undefined;
  const selectedModel = sanitizeModel(value.selectedModel);
  if (!selectedModel) return undefined;
  const queuedMessages: StoredQueuedMessage[] = Array.isArray(value.queuedMessages)
    ? value.queuedMessages.slice(0, MAX_QUEUE).flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = stringValue(item.id);
        const text = typeof item.text === "string" ? item.text : null;
        const model = isRecord(item.model) && stringValue(item.model.id) && stringValue(item.model.label)
          ? item.model as StoredQueuedMessage["model"]
          : null;
        if (!id || text === null || !model) return [];
        return [{
          id,
          rawText: typeof item.rawText === "string" ? item.rawText : "",
          text,
          model,
          databases: sanitizeDatabases(item.databases),
          skills: sanitizeSkills(item.skills),
          files: stringArray(item.files),
          images: sanitizeBlobRefs(item.images),
          computeTarget: typeof item.computeTarget === "string" ? item.computeTarget : null,
          computeOptions: isRecord(item.computeOptions)
            ? {
                ...(typeof item.computeOptions.gpuCount === "number" &&
                Number.isInteger(item.computeOptions.gpuCount) &&
                item.computeOptions.gpuCount >= 1 &&
                item.computeOptions.gpuCount <= 8
                  ? { gpuCount: item.computeOptions.gpuCount }
                  : {}),
                ...(Array.isArray(item.computeOptions.gpuFallback)
                  ? {
                      gpuFallback: item.computeOptions.gpuFallback.filter(
                        (entry): entry is string => typeof entry === "string",
                      ),
                    }
                  : {}),
                ...(item.computeOptions.cache === "project" ||
                item.computeOptions.cache === "none"
                  ? { cache: item.computeOptions.cache }
                  : {}),
              }
            : undefined,
          thinkingLevel: sanitizeThinkingLevel(item.thinkingLevel, true),
          timestamp: typeof item.timestamp === "number" && Number.isFinite(item.timestamp)
            ? item.timestamp
            : Date.now(),
        }];
      })
    : [];
  const composer = isRecord(value.composer) ? value.composer : {};
  return {
    selectedModel,
    thinkingLevel: sanitizeThinkingLevel(value.thinkingLevel) ?? "high",
    selectedComputeTarget: sanitizeComputeTarget(value.selectedComputeTarget),
    attachedFiles: stringArray(value.attachedFiles),
    selectedDatabases: sanitizeDatabases(value.selectedDatabases),
    selectedSkills: sanitizeSkills(value.selectedSkills),
    queuedMessages,
    composer: {
      text: typeof composer.text === "string" ? composer.text : "",
      attachments: sanitizeBlobRefs(composer.attachments),
    },
  };
}

function sanitizeStoredProject(value: unknown): StoredProjectState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const seenTabs = new Set<string>();
  const seenSessions = new Set<string>();
  const tabs: StoredTabState[] = value.tabs.slice(0, MAX_TABS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const title = stringValue(item.title);
    if (!id || !title || seenTabs.has(id)) return [];
    seenTabs.add(id);
    const rawSessionId = stringValue(item.sessionId);
    const sessionId = rawSessionId && !seenSessions.has(rawSessionId) ? rawSessionId : undefined;
    if (sessionId) seenSessions.add(sessionId);
    const chat = sanitizeStoredChat(item.chat);
    return [{ id, title, ...(sessionId ? { sessionId } : {}), ...(chat ? { chat } : {}) }];
  });
  if (tabs.length === 0) return null;
  const requestedActiveTab = stringValue(value.activeTabId);
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveTab)
    ? requestedActiveTab!
    : tabs[0].id;
  const sandbox = isRecord(value.sandbox) ? value.sandbox : {};
  const openPaths = stringArray(sandbox.openPaths);
  const requestedActivePath = stringValue(sandbox.activePath);
  const showNotebook = value.showNotebook === true;
  return {
    tabs,
    activeTabId,
    view: value.view === "workflows" ? "workflows" : "chat",
    showNotebook,
    showCompute: !showNotebook && value.showCompute === true,
    computeScope: value.computeScope === "session" ? "session" : "project",
    sandboxOpen: value.sandboxOpen !== false,
    chatOpen: value.chatOpen !== false,
    treeWidth: boundedNumber(value.treeWidth, 320, 150, 480),
    chatWidth: boundedNumber(value.chatWidth, 640, 280, 720),
    sandbox: {
      openPaths,
      activePath: requestedActivePath && openPaths.includes(requestedActivePath)
        ? requestedActivePath
        : openPaths[0] ?? null,
    },
  };
}

export function validateWorkspaceMetadata(value: unknown): StoredWorkspaceMetadata {
  if (!isRecord(value) || value.version !== WORKSPACE_SCHEMA_VERSION) {
    return { ...EMPTY_METADATA, projects: {} };
  }
  const projects: Record<string, StoredProjectState> = {};
  if (isRecord(value.projects)) {
    for (const [projectId, project] of Object.entries(value.projects)) {
      if (!projectId.trim()) continue;
      const sanitized = sanitizeStoredProject(project);
      if (sanitized) projects[projectId] = sanitized;
    }
  }
  const openedProjectIds = stringArray(value.openedProjectIds).filter((id) => id in projects);
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    screen:
      value.screen === "workspace" && openedProjectIds.length > 0
        ? "workspace"
        : "projects",
    openedProjectIds,
    projects,
  };
}

export function parseWorkspaceMetadata(serialized: string | null): StoredWorkspaceMetadata {
  if (!serialized) return { ...EMPTY_METADATA, projects: {} };
  try {
    return validateWorkspaceMetadata(JSON.parse(serialized));
  } catch {
    return { ...EMPTY_METADATA, projects: {} };
  }
}

export function pruneWorkspaceMetadata(
  metadata: StoredWorkspaceMetadata,
  validProjectIds: Iterable<string>,
): StoredWorkspaceMetadata {
  const valid = new Set(validProjectIds);
  const projects = Object.fromEntries(
    Object.entries(metadata.projects).filter(([projectId]) => valid.has(projectId)),
  );
  return {
    ...metadata,
    openedProjectIds: metadata.openedProjectIds.filter((id) => valid.has(id)),
    projects,
  };
}

function readMetadata(): StoredWorkspaceMetadata {
  if (typeof window === "undefined") return { ...EMPTY_METADATA, projects: {} };
  try {
    return parseWorkspaceMetadata(window.localStorage.getItem(WORKSPACE_STORAGE_KEY));
  } catch {
    return { ...EMPTY_METADATA, projects: {} };
  }
}

function writeMetadata(metadata: StoredWorkspaceMetadata): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(metadata));
  } catch {
    // Storage can be disabled or full. Persistence is always best-effort.
  }
}

function mutateMetadata(
  update: (current: StoredWorkspaceMetadata) => StoredWorkspaceMetadata,
): Promise<void> {
  metadataWriteChain = metadataWriteChain
    .catch(() => undefined)
    .then(() => writeMetadata(update(readMetadata())));
  return metadataWriteChain;
}

function enqueueProjectWrite(
  projectId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const next = (projectWriteChains.get(projectId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  projectWriteChains.set(projectId, next);
  void next.finally(() => {
    if (projectWriteChains.get(projectId) === next) projectWriteChains.delete(projectId);
  });
  return next;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(BLOB_STORE)) {
          request.result.createObjectStore(BLOB_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return databasePromise;
}

async function replaceBlobPrefix(prefix: string, records: BlobRecord[]): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(BLOB_STORE, "readwrite");
      const store = transaction.objectStore(BLOB_STORE);
      store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function removeBlobPrefix(prefix: string): Promise<void> {
  await replaceBlobPrefix(prefix, []);
}

async function readBlob(key: string): Promise<Blob | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(BLOB_STORE, "readonly");
      const request = transaction.objectStore(BLOB_STORE).get(key);
      request.onsuccess = () => {
        const blob = (request.result as BlobRecord | undefined)?.blob;
        resolve(blob instanceof Blob ? blob : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function urlToBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

function imageToBlob(image: PromptImage): Blob | null {
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: image.mimeType });
  } catch {
    return null;
  }
}

async function blobToImage(blob: Blob): Promise<PromptImage | null> {
  try {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize));
    }
    return { data: btoa(binary), mimeType: blob.type || "image/png" };
  } catch {
    return null;
  }
}

async function storeProject(projectId: string, state: ProjectWorkspaceState): Promise<StoredProjectState> {
  const prefix = `${projectId}:`;
  const records: BlobRecord[] = [];
  const tabs: StoredTabState[] = [];

  for (const tab of state.tabs) {
    if (!tab.chat) {
      tabs.push({ id: tab.id, title: tab.title, ...(tab.sessionId ? { sessionId: tab.sessionId } : {}) });
      continue;
    }
    const attachments: StoredBlobRef[] = [];
    for (const attachment of tab.chat.composer.attachments) {
      const key = `${prefix}${tab.id}:composer:${attachment.id}`;
      const blob = await urlToBlob(attachment.url);
      if (!blob) continue;
      records.push({ key, blob });
      attachments.push({
        key,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        mediaType: attachment.mediaType || blob.type,
      });
    }
    const queuedMessages: StoredQueuedMessage[] = [];
    for (const message of tab.chat.queuedMessages.slice(0, MAX_QUEUE)) {
      const images: StoredBlobRef[] = [];
      message.images.forEach((image, index) => {
        const blob = imageToBlob(image);
        if (!blob) return;
        const key = `${prefix}${tab.id}:queue:${message.id}:${index}`;
        records.push({ key, blob });
        images.push({ key, mediaType: image.mimeType });
      });
      queuedMessages.push({ ...message, images });
    }
    tabs.push({
      id: tab.id,
      title: tab.title,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      chat: {
        ...tab.chat,
        queuedMessages,
        composer: { text: tab.chat.composer.text, attachments },
      },
    });
  }

  const blobsStored = await replaceBlobPrefix(prefix, records);
  if (!blobsStored) {
    for (const tab of tabs) {
      if (!tab.chat) continue;
      tab.chat.composer.attachments = [];
      tab.chat.queuedMessages = tab.chat.queuedMessages.map((message) => ({
        ...message,
        images: [],
      }));
    }
  }
  return { ...state, tabs };
}

async function hydrateProject(stored: StoredProjectState): Promise<ProjectWorkspaceState> {
  const tabs: WorkspaceTabState[] = [];
  for (const tab of stored.tabs) {
    if (!tab.chat) {
      tabs.push({
        id: tab.id,
        title: tab.title,
        ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      });
      continue;
    }
    const attachments: PromptDraftAttachment[] = [];
    for (const ref of tab.chat.composer.attachments) {
      const blob = await readBlob(ref.key);
      if (!blob) continue;
      try {
        attachments.push({
          id: ref.key.split(":").at(-1) ?? ref.key,
          filename: ref.filename,
          mediaType: ref.mediaType || blob.type,
          url: URL.createObjectURL(blob),
        });
      } catch {
        // A broken Blob record must not prevent the rest of the workspace loading.
      }
    }
    const queuedMessages: WorkspaceQueuedMessage[] = [];
    for (const message of tab.chat.queuedMessages) {
      const images = (await Promise.all(
        message.images.map(async (ref) => {
          const blob = await readBlob(ref.key);
          return blob ? blobToImage(blob) : null;
        }),
      )).filter((image): image is PromptImage => image !== null);
      queuedMessages.push({ ...message, images });
    }
    tabs.push({
      id: tab.id,
      title: tab.title,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      chat: {
        ...tab.chat,
        queuedMessages,
        composer: { text: tab.chat.composer.text, attachments },
      },
    });
  }
  return { ...stored, tabs };
}

function projectMetadataFromState(
  projectId: string,
  state: ProjectWorkspaceState,
): StoredProjectState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      ...(tab.chat
        ? {
            chat: {
              ...tab.chat,
              queuedMessages: tab.chat.queuedMessages.map((message) => ({
                ...message,
                images: message.images.map((image, index) => ({
                  key: `${projectId}:${tab.id}:queue:${message.id}:${index}`,
                  mediaType: image.mimeType,
                })),
              })),
              composer: {
                text: tab.chat.composer.text,
                attachments: tab.chat.composer.attachments.map((attachment) => ({
                  key: `${projectId}:${tab.id}:composer:${attachment.id}`,
                  ...(attachment.filename ? { filename: attachment.filename } : {}),
                  ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
                })),
              },
            },
          }
        : {}),
    })),
  };
}

/**
 * Release the blob: URLs minted by `loadWorkspaceSnapshot`.
 *
 * Hydration creates one per restored composer attachment. When the caller
 * throws the snapshot away — the page unmounted mid-load, or a second load
 * superseded it — nothing else will ever revoke them and the blobs stay
 * resident for the lifetime of the document.
 */
export function revokeSnapshotObjectUrls(snapshot: WorkspaceSnapshot): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const project of Object.values(snapshot.projects)) {
    for (const tab of project.tabs) {
      for (const attachment of tab.chat?.composer.attachments ?? []) {
        if (attachment.url?.startsWith("blob:")) URL.revokeObjectURL(attachment.url);
      }
    }
  }
}

export async function loadWorkspaceSnapshot(
  validProjectIds?: Iterable<string>,
): Promise<WorkspaceSnapshot> {
  const metadata = validProjectIds
    ? pruneWorkspaceMetadata(readMetadata(), validProjectIds)
    : readMetadata();
  if (validProjectIds) writeMetadata(metadata);
  const projects: Record<string, ProjectWorkspaceState> = {};
  await Promise.all(
    Object.entries(metadata.projects).map(async ([projectId, project]) => {
      projects[projectId] = await hydrateProject(project);
    }),
  );
  return { ...metadata, projects };
}

export function saveWorkspaceShellState(
  screen: WorkspaceScreen,
  openedProjectIds: string[],
): Promise<void> {
  const current = readMetadata();
  writeMetadata({
    ...current,
    screen,
    openedProjectIds: [...new Set(openedProjectIds)].filter((id) => id in current.projects),
  });
  return Promise.resolve();
}

export async function saveProjectWorkspaceState(
  projectId: string,
  state: ProjectWorkspaceState,
): Promise<void> {
  const version = (projectWriteVersions.get(projectId) ?? 0) + 1;
  projectWriteVersions.set(projectId, version);
  const optimistic = sanitizeStoredProject(projectMetadataFromState(projectId, state));
  if (!optimistic) return;
  const current = readMetadata();
  writeMetadata({
    ...current,
    openedProjectIds: current.openedProjectIds.includes(projectId)
      ? current.openedProjectIds
      : [...current.openedProjectIds, projectId],
    projects: { ...current.projects, [projectId]: optimistic },
  });
  await enqueueProjectWrite(projectId, async () => {
    const sanitized = sanitizeStoredProject(await storeProject(projectId, state));
    if (!sanitized || projectWriteVersions.get(projectId) !== version) return;
    await mutateMetadata((current) => ({
      ...current,
      openedProjectIds: current.openedProjectIds.includes(projectId)
        ? current.openedProjectIds
        : [...current.openedProjectIds, projectId],
      projects: { ...current.projects, [projectId]: sanitized },
    }));
  });
}

export async function deletePersistedChatState(projectId: string, tabId: string): Promise<void> {
  projectWriteVersions.set(projectId, (projectWriteVersions.get(projectId) ?? 0) + 1);
  const current = readMetadata();
  const project = current.projects[projectId];
  if (project && project.tabs.length > 1) {
    const tabs = project.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      project.activeTabId === tabId ? tabs[0]?.id ?? project.activeTabId : project.activeTabId;
    writeMetadata({
      ...current,
      projects: {
        ...current.projects,
        [projectId]: { ...project, tabs, activeTabId },
      },
    });
  }
  await enqueueProjectWrite(projectId, () => removeBlobPrefix(`${projectId}:${tabId}:`));
}

export async function deletePersistedProjectState(projectId: string): Promise<void> {
  projectWriteVersions.set(projectId, (projectWriteVersions.get(projectId) ?? 0) + 1);
  const current = readMetadata();
  const projects = { ...current.projects };
  delete projects[projectId];
  writeMetadata({
    ...current,
    openedProjectIds: current.openedProjectIds.filter((id) => id !== projectId),
    projects,
  });
  await enqueueProjectWrite(projectId, async () => {
    await removeBlobPrefix(`${projectId}:`);
    await mutateMetadata((current) => {
      const projects = { ...current.projects };
      delete projects[projectId];
      return {
        ...current,
        openedProjectIds: current.openedProjectIds.filter((id) => id !== projectId),
        projects,
      };
    });
  });
}

export async function pruneDeletedProjectState(validProjectIds: Iterable<string>): Promise<void> {
  const valid = new Set(validProjectIds);
  const current = readMetadata();
  const removed = [...new Set([
    ...Object.keys(current.projects),
    ...projectWriteChains.keys(),
  ])].filter((id) => !valid.has(id));
  for (const projectId of removed) {
    projectWriteVersions.set(
      projectId,
      (projectWriteVersions.get(projectId) ?? 0) + 1,
    );
  }
  writeMetadata(pruneWorkspaceMetadata(current, valid));
  await Promise.all(
    removed.map((id) => enqueueProjectWrite(id, () => removeBlobPrefix(`${id}:`))),
  );
  await mutateMetadata((latest) => pruneWorkspaceMetadata(latest, valid));
}
