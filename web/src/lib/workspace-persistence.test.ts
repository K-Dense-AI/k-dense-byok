import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_KEY,
  deletePersistedChatState,
  loadWorkspaceSnapshot,
  parseWorkspaceMetadata,
  pruneDeletedProjectState,
  pruneWorkspaceMetadata,
  revokeSnapshotObjectUrls,
  saveProjectWorkspaceState,
  saveWorkspaceShellState,
  validateWorkspaceMetadata,
  type ProjectWorkspaceState,
} from "./workspace-persistence";

const projectState: ProjectWorkspaceState = {
  tabs: [
    {
      id: "tab-1",
      title: "Recovered chat",
      sessionId: "session-1",
      chat: {
        selectedModel: {
          id: "openrouter/test",
          label: "Test model",
          provider: "Test",
          tier: "mid",
          context_length: 128_000,
          pricing: { prompt: 1, completion: 2 },
          modality: "text",
          description: "Fixture",
        },
        thinkingLevel: "high",
        selectedComputeTarget: null,
        attachedFiles: ["notes.md"],
        selectedDatabases: [],
        selectedSkills: [
          { id: "literature", name: "Literature", description: "Search papers" },
        ],
        queuedMessages: [],
        composer: { text: "unfinished question", attachments: [] },
      },
    },
  ],
  activeTabId: "tab-1",
  view: "chat",
  showNotebook: true,
  showCompute: false,
  computeScope: "session",
  sandboxOpen: false,
  chatOpen: true,
  treeWidth: 280,
  chatWidth: 600,
  sandbox: {
    openPaths: ["notes.md", "figure.png"],
    activePath: "figure.png",
  },
};

describe("workspace persistence schema", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips small workspace and per-chat state", async () => {
    await saveProjectWorkspaceState("project-a", projectState);
    await saveWorkspaceShellState("workspace", ["project-a"]);

    const restored = await loadWorkspaceSnapshot();

    expect(restored.version).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(restored.screen).toBe("workspace");
    expect(restored.openedProjectIds).toEqual(["project-a"]);
    expect(restored.projects["project-a"]).toMatchObject({
      activeTabId: "tab-1",
      showNotebook: true,
      showCompute: false,
      computeScope: "session",
      sandboxOpen: false,
      sandbox: {
        openPaths: ["notes.md", "figure.png"],
        activePath: "figure.png",
      },
      tabs: [
        {
          id: "tab-1",
          title: "Recovered chat",
          sessionId: "session-1",
          chat: {
            thinkingLevel: "high",
            attachedFiles: ["notes.md"],
            composer: { text: "unfinished question", attachments: [] },
          },
        },
      ],
    });
  });

  it("falls back safely for invalid JSON and unsupported versions", () => {
    expect(parseWorkspaceMetadata("{not-json")).toMatchObject({
      version: WORKSPACE_SCHEMA_VERSION,
      screen: "projects",
      openedProjectIds: [],
      projects: {},
    });
    expect(validateWorkspaceMetadata({ version: 99, screen: "workspace" })).toMatchObject({
      screen: "projects",
      projects: {},
    });
    expect(
      validateWorkspaceMetadata({
        version: WORKSPACE_SCHEMA_VERSION,
        screen: "workspace",
        openedProjectIds: [],
        projects: {},
      }),
    ).toMatchObject({
      screen: "projects",
      openedProjectIds: [],
    });
  });

  it("repairs corrupt tabs, selections, and panel sizes", () => {
    const repaired = validateWorkspaceMetadata({
      version: WORKSPACE_SCHEMA_VERSION,
      screen: "workspace",
      openedProjectIds: ["project-a", "missing"],
      projects: {
        "project-a": {
          tabs: [
            { id: "tab-1", title: "One", sessionId: "same" },
            { id: "tab-1", title: "Duplicate" },
            { id: "tab-2", title: "Two", sessionId: "same" },
            { nope: true },
          ],
          activeTabId: "deleted-tab",
          view: "invalid",
          showNotebook: false,
          showCompute: true,
          computeScope: "invalid",
          treeWidth: -100,
          chatWidth: 10000,
          sandbox: {
            openPaths: ["a.md", "a.md", 42],
            activePath: "deleted.md",
          },
        },
      },
    });

    expect(repaired.openedProjectIds).toEqual(["project-a"]);
    expect(repaired.projects["project-a"]).toMatchObject({
      activeTabId: "tab-1",
      view: "chat",
      showNotebook: false,
      showCompute: true,
      computeScope: "project",
      treeWidth: 150,
      chatWidth: 720,
      sandbox: { openPaths: ["a.md"], activePath: "a.md" },
      tabs: [
        { id: "tab-1", sessionId: "same" },
        { id: "tab-2" },
      ],
    });
  });

  it("sanitizes Compute state without breaking v1 snapshots that predate it", () => {
    const legacy = validateWorkspaceMetadata({
      version: WORKSPACE_SCHEMA_VERSION,
      screen: "workspace",
      openedProjectIds: ["project-a"],
      projects: {
        "project-a": {
          tabs: [{
            id: "tab-1",
            title: "Legacy",
            chat: {
              selectedModel: { id: "openrouter/test", label: "Test" },
              selectedComputeTarget: "h100",
            },
          }],
          activeTabId: "tab-1",
          showNotebook: false,
          sandbox: { openPaths: [], activePath: null },
        },
      },
    });
    expect(legacy.projects["project-a"]).toMatchObject({
      showCompute: false,
      computeScope: "project",
      tabs: [
        {
          chat: {
            selectedComputeTarget: { id: "h100", label: "h100" },
          },
        },
      ],
    });

    const conflicting = validateWorkspaceMetadata({
      version: WORKSPACE_SCHEMA_VERSION,
      screen: "workspace",
      openedProjectIds: ["project-a"],
      projects: {
        "project-a": {
          tabs: [{ id: "tab-1", title: "Conflict" }],
          activeTabId: "tab-1",
          showNotebook: true,
          showCompute: true,
          computeScope: "session",
          sandbox: { openPaths: [], activePath: null },
        },
      },
    });
    expect(conflicting.projects["project-a"]).toMatchObject({
      showNotebook: true,
      showCompute: false,
      computeScope: "session",
    });
  });

  it("prunes deleted projects from metadata and storage", async () => {
    await saveProjectWorkspaceState("project-a", projectState);
    await saveProjectWorkspaceState("project-b", {
      ...projectState,
      tabs: [{ id: "tab-b", title: "B" }],
      activeTabId: "tab-b",
    });
    await saveWorkspaceShellState("workspace", ["project-a", "project-b"]);

    const metadata = parseWorkspaceMetadata(
      window.localStorage.getItem(WORKSPACE_STORAGE_KEY),
    );
    expect(pruneWorkspaceMetadata(metadata, ["project-b"]).openedProjectIds).toEqual([
      "project-b",
    ]);

    await pruneDeletedProjectState(["project-b"]);
    const restored = await loadWorkspaceSnapshot();
    expect(Object.keys(restored.projects)).toEqual(["project-b"]);
    expect(restored.openedProjectIds).toEqual(["project-b"]);
  });

  it("removes closed tabs from durable metadata immediately", async () => {
    await saveProjectWorkspaceState("project-a", {
      ...projectState,
      tabs: [
        ...projectState.tabs,
        { id: "tab-2", title: "Second chat", sessionId: "session-2" },
      ],
    });

    await deletePersistedChatState("project-a", "tab-2");

    const metadata = parseWorkspaceMetadata(
      window.localStorage.getItem(WORKSPACE_STORAGE_KEY),
    );
    expect(metadata.projects["project-a"].tabs.map((tab) => tab.id)).toEqual([
      "tab-1",
    ]);
  });

  it("never places draft image payloads in localStorage", async () => {
    await saveProjectWorkspaceState("project-a", {
      ...projectState,
      tabs: [
        {
          ...projectState.tabs[0],
          chat: {
            ...projectState.tabs[0].chat!,
            composer: {
              text: "image draft",
              attachments: [
                {
                  id: "image-1",
                  filename: "pixel.png",
                  mediaType: "image/png",
                  url: "data:image/png;base64,c2VjcmV0LWltYWdlLWJ5dGVz",
                },
              ],
            },
          },
        },
      ],
    });

    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain(
      "c2VjcmV0LWltYWdlLWJ5dGVz",
    );
  });

  it("revokes the blob URLs of a snapshot the caller discards", () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revoke,
      configurable: true,
      writable: true,
    });
    try {
      revokeSnapshotObjectUrls({
        version: WORKSPACE_SCHEMA_VERSION,
        screen: "workspace",
        openedProjectIds: ["project-a"],
        projects: {
          "project-a": {
            ...projectState,
            tabs: [
              {
                ...projectState.tabs[0],
                chat: {
                  ...projectState.tabs[0].chat!,
                  composer: {
                    text: "restored",
                    attachments: [
                      { id: "image-1", filename: "a.png", mediaType: "image/png", url: "blob:a" },
                      // Data URLs are inline, not handles — nothing to release.
                      { id: "image-2", filename: "b.png", mediaType: "image/png", url: "data:b" },
                    ],
                  },
                },
              },
            ],
          },
        },
      });
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("blob:a");
    } finally {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
