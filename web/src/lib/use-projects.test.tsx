import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "./projects";

const listProjects = vi.fn<() => Promise<Project[]>>();
const deleteProject = vi.fn<(id: string) => Promise<void>>();

vi.mock("./projects", async () => {
  const actual = await vi.importActual<typeof import("./projects")>("./projects");
  return {
    ...actual,
    listProjects: () => listProjects(),
    deleteProject: (id: string) => deleteProject(id),
  };
});

const { ProjectProvider, useProjects } = await import("./use-projects");

const project = (id: string): Project =>
  ({ id, name: id, createdAt: "", updatedAt: "" }) as Project;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ProjectProvider, null, children);
}

/** A list response the test resolves by hand. */
function deferred(): { promise: Promise<Project[]>; resolve: (v: Project[]) => void } {
  let resolve!: (v: Project[]) => void;
  const promise = new Promise<Project[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  listProjects.mockReset();
  deleteProject.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProjectProvider refresh ordering", () => {
  it("ignores a slow earlier list that would resurrect a deleted project", async () => {
    const slow = deferred();
    listProjects
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce([project("alpha")]);

    const { result } = renderHook(() => useProjects(), { wrapper });

    // Mount's list is still in flight when a delete triggers its own refresh.
    await act(async () => {
      await result.current.remove("beta");
    });
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["alpha"]));

    await act(async () => {
      slow.resolve([project("alpha"), project("beta")]);
      await slow.promise;
    });
    expect(result.current.projects.map((p) => p.id)).toEqual(["alpha"]);
    expect(result.current.loading).toBe(false);
  });

  it("does not let a stale failure overwrite a successful reload", async () => {
    let failSlow!: (e: Error) => void;
    const failing = new Promise<Project[]>((_resolve, reject) => {
      failSlow = reject;
    });
    listProjects
      .mockReturnValueOnce(failing)
      .mockResolvedValueOnce([project("alpha")]);

    const { result } = renderHook(() => useProjects(), { wrapper });
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => {
      failSlow(new Error("network down"));
      await failing.catch(() => {});
    });
    expect(result.current.error).toBeNull();
  });
});
