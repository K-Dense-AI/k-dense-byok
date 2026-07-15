"use client";

import { createContext, useContext } from "react";
import type { ProjectActivitySummary } from "@/lib/project-activity";

/**
 * Project types, storage, and the `apiFetch` wrapper used by every hook.
 *
 * The active project id is kept in localStorage so it survives reloads and
 * is readable synchronously from callbacks/hooks. `apiFetch` transparently
 * injects `X-Project-Id` on every request, so individual hooks don't have
 * to know about projects at all -- they keep calling relative paths and
 * get the right project's data for free.
 *
 * When the active project changes we dispatch a window-level
 * `kady:project-changed` CustomEvent so other hooks (chat, sandbox, etc.)
 * can reset their in-memory state.
 */

export interface Project {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  spendLimitUsd: number | null;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
  tags?: string[];
  id?: string;
  spendLimitUsd?: number | null;
}

export interface ProjectPatchInput {
  name?: string;
  description?: string;
  tags?: string[];
  archived?: boolean;
  spendLimitUsd?: number | null;
}

export const DEFAULT_PROJECT_ID = "default";

export const API_BASE =
  process.env.NEXT_PUBLIC_ADK_API_URL ?? "http://localhost:8000";

/**
 * Put long-lived SSE requests on a separate browser connection pool from
 * ordinary API calls. Chrome permits only six HTTP/1.1 connections per
 * origin; several background chat streams can otherwise consume all six and
 * leave interview/abort/steer requests queued indefinitely.
 *
 * localhost and 127.0.0.1 reach the same local backend but are distinct
 * origins/connection pools. Non-local deployments keep their configured URL.
 */
function streamApiBase(base: string): string {
  try {
    const url = new URL(base);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    } else if (url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
      url.hostname = "localhost";
    } else {
      return base;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return base;
  }
}

export const STREAM_API_BASE = streamApiBase(API_BASE);

const STORAGE_KEY = "kady:activeProjectId";
const CHANGE_EVENT = "kady:project-changed";
const ProjectScopeContext = createContext<string | null>(null);

/**
 * Pins descendants to one project even while the globally-visible project
 * changes. Used by mounted background workspaces whose streams must keep
 * talking to their owning project.
 */
export const ProjectScopeProvider = ProjectScopeContext.Provider;

export function useProjectScopeId(): string {
  return useContext(ProjectScopeContext) ?? getActiveProjectId();
}

/**
 * Read the active project id.
 *
 * Safe to call during SSR (returns the default) and from hot paths like
 * fetch wrappers. Invalid or missing values normalise to the default.
 */
export function getActiveProjectId(): string {
  if (typeof window === "undefined") return DEFAULT_PROJECT_ID;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && v.trim()) return v.trim();
  } catch {
    // localStorage can throw in private mode / with quota errors; fall back.
  }
  return DEFAULT_PROJECT_ID;
}

/**
 * Set the active project id, persisting it to localStorage and broadcasting
 * a change event so other tabs and hooks can react.
 *
 * Fires `kady:project-changed` on `window`. No-op when called from SSR.
 */
export function setActiveProjectId(id: string): void {
  if (typeof window === "undefined") return;
  const next = id?.trim() || DEFAULT_PROJECT_ID;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // best-effort -- we'll still dispatch so at least the current tab updates
  }
  // Mirror into a cookie so <img>/<a> URLs to the backend land in the same
  // project (cookies are sent automatically; custom headers are not).
  try {
    document.cookie = `kady-project=${encodeURIComponent(next)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // Safari in private mode can throw; header/localStorage still work.
  }
  window.dispatchEvent(
    new CustomEvent(CHANGE_EVENT, { detail: { id: next } })
  );
}

/**
 * Subscribe to active-project changes.
 *
 * Returns an unsubscribe function. Handler receives the new project id.
 */
export function onProjectChange(
  handler: (projectId: string) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (ev: Event) => {
    const id =
      (ev as CustomEvent<{ id?: string }>).detail?.id ?? getActiveProjectId();
    handler(id);
  };
  const storageListener = (ev: StorageEvent) => {
    if (ev.key === STORAGE_KEY) handler(getActiveProjectId());
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", storageListener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", storageListener);
  };
}

/**
 * `fetch` wrapper that prepends `API_BASE` and injects `X-Project-Id`.
 *
 * Accepts either a leading-slash path ("/projects") or a full URL. For
 * full URLs we still inject the header so cross-origin callers can pass
 * through CORS preflights without losing the scope.
 */
export function apiFetch(
  path: string,
  init: RequestInit = {},
  projectId?: string,
  lane: "default" | "stream" = "default",
): Promise<Response> {
  const base = lane === "stream" ? STREAM_API_BASE : API_BASE;
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has("X-Project-Id")) {
    headers.set("X-Project-Id", projectId?.trim() || getActiveProjectId());
  }
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const res = await apiFetch("/projects");
  if (!res.ok) throw new Error(`listProjects ${res.status}`);
  return (await res.json()) as Project[];
}

export async function listProjectActivities(): Promise<
  Record<string, ProjectActivitySummary>
> {
  const res = await apiFetch("/projects/activity");
  if (!res.ok) throw new Error(`listProjectActivities ${res.status}`);
  const body = (await res.json()) as {
    activities?: Record<string, ProjectActivitySummary>;
  };
  return body.activities ?? {};
}

export async function createProject(
  input: ProjectCreateInput
): Promise<Project> {
  const res = await apiFetch("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `createProject ${res.status}`);
  }
  return (await res.json()) as Project;
}

export async function patchProject(
  id: string,
  input: ProjectPatchInput
): Promise<Project> {
  const res = await apiFetch(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `patchProject ${res.status}`);
  }
  return (await res.json()) as Project;
}

export async function deleteProject(id: string): Promise<void> {
  const res = await apiFetch(`/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const detail = await res.text();
    throw new Error(detail || `deleteProject ${res.status}`);
  }
}

export async function initProjectSandbox(
  id: string,
  opts: { sync_venv?: boolean; download_skills?: boolean } = {}
): Promise<void> {
  const res = await apiFetch(
    `/projects/${encodeURIComponent(id)}/sandbox/init`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `initProjectSandbox ${res.status}`);
  }
}
