import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("projects.ts", () => {
  let projectsModule: typeof import("./projects");

  beforeEach(async () => {
    vi.resetModules();
    window.localStorage.clear();
    // Clear all cookies.
    document.cookie
      .split(";")
      .forEach((c) => {
        const name = c.split("=")[0].trim();
        if (name) {
          document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        }
      });
    projectsModule = await import("./projects");
  });

  describe("getActiveProjectId / setActiveProjectId", () => {
    it("returns DEFAULT_PROJECT_ID when storage is empty", () => {
      expect(projectsModule.getActiveProjectId()).toBe(
        projectsModule.DEFAULT_PROJECT_ID
      );
    });

    it("round-trips an id through localStorage", () => {
      projectsModule.setActiveProjectId("my-proj");
      expect(projectsModule.getActiveProjectId()).toBe("my-proj");
    });

    it("falls back to default when id is empty", () => {
      projectsModule.setActiveProjectId("   ");
      expect(projectsModule.getActiveProjectId()).toBe(
        projectsModule.DEFAULT_PROJECT_ID
      );
    });

    it("mirrors the active id into the kady-project cookie", () => {
      projectsModule.setActiveProjectId("cookie-proj");
      expect(document.cookie).toContain("kady-project=cookie-proj");
    });

    it("trims surrounding whitespace", () => {
      window.localStorage.setItem("kady:activeProjectId", "  spaced  ");
      expect(projectsModule.getActiveProjectId()).toBe("spaced");
    });
  });

  describe("onProjectChange", () => {
    it("invokes the handler when setActiveProjectId is called", () => {
      const handler = vi.fn();
      const unsubscribe = projectsModule.onProjectChange(handler);
      projectsModule.setActiveProjectId("new-id");
      expect(handler).toHaveBeenCalledWith("new-id");
      unsubscribe();
    });

    it("stops receiving events after unsubscribe", () => {
      const handler = vi.fn();
      const unsubscribe = projectsModule.onProjectChange(handler);
      unsubscribe();
      projectsModule.setActiveProjectId("after-unsub");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("apiFetch", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("prepends API_BASE and injects X-Project-Id", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      projectsModule.setActiveProjectId("scoped");
      await projectsModule.apiFetch("/projects");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/projects$/);
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("X-Project-Id")).toBe("scoped");
    });

    it("does not override an explicit X-Project-Id header", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await projectsModule.apiFetch("/x", {
        headers: { "X-Project-Id": "explicit" },
      });

      const headers = new Headers(
        (fetchMock.mock.calls[0][1] as RequestInit).headers
      );
      expect(headers.get("X-Project-Id")).toBe("explicit");
    });

    it("passes absolute URLs through untouched", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await projectsModule.apiFetch("https://example.org/foo");
      expect(fetchMock.mock.calls[0][0]).toBe("https://example.org/foo");
    });
  });

  describe("CRUD wrappers", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("listProjects parses JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "x", name: "X" }]), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await projectsModule.listProjects();
      expect(result).toEqual([{ id: "x", name: "X" }]);
    });

    it("listProjects throws on non-ok responses", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("nope", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(projectsModule.listProjects()).rejects.toThrow(/500/);
    });

    it("createProject serialises the input as JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "new", name: "N" }), { status: 201 })
      );
      vi.stubGlobal("fetch", fetchMock);
      await projectsModule.createProject({ name: "N" });
      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).body).toBe(JSON.stringify({ name: "N" }));
    });

    it("deleteProject tolerates 204 responses", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        projectsModule.deleteProject("abc")
      ).resolves.toBeUndefined();
    });

    it("patchProject passes id via URL and body via JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "a", description: "x" }), {
          status: 200,
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      await projectsModule.patchProject("a", { description: "x" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/projects/a");
      expect((init as RequestInit).method).toBe("PATCH");
    });
  });
});
