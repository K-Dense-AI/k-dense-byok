import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildTimeline,
  exportMethodsSection,
  exportMethodsSectionFromManifests,
  fetchManifests,
  type ProvenanceEvent,
  type RunManifest,
  type TurnMeta,
} from "./provenance";
import type { ChatMessage } from "./use-agent";

function makeMsg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hi",
    timestamp: 1000,
    ...overrides,
  } as ChatMessage;
}

describe("buildTimeline", () => {
  it("emits user_query events with attached meta", () => {
    const turnMeta = new Map<string, TurnMeta>([
      [
        "u1",
        {
          model: "openrouter/anthropic/claude-opus",
          databases: ["pubmed"],
          compute: null,
          skills: ["writing"],
          filesAttached: [],
          timestamp: 1000,
        },
      ],
    ]);

    const events = buildTimeline(
      [makeMsg({ id: "u1", role: "user", content: "what?" })],
      turnMeta
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user_query");
    expect(events[0].meta?.model).toBe("openrouter/anthropic/claude-opus");
    expect(events[0].meta?.databases).toEqual(["pubmed"]);
    expect(events[0].meta?.skills).toEqual(["writing"]);
  });

  it("truncates very long user queries", () => {
    const long = "x".repeat(200);
    const events = buildTimeline(
      [makeMsg({ id: "u1", role: "user", content: long })],
      new Map()
    );
    expect(events[0].detail?.endsWith("...")).toBe(true);
    expect(events[0].detail?.length).toBeLessThanOrEqual(100);
  });

  it("emits delegation start/complete for assistant activities", () => {
    const events = buildTimeline(
      [
        makeMsg({
          id: "a1",
          role: "assistant",
          content: "done",
          activities: [
            {
              id: "act1",
              label: "Delegating to writing",
              status: "running",
              timestamp: 1100,
            },
            {
              id: "act2",
              label: "Specialist finished",
              status: "done",
              detail: "Used 'writing', 'parallel-web' skills",
              timestamp: 1200,
            },
          ],
        } as unknown as Partial<ChatMessage>),
      ],
      new Map()
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("delegation_start");
    expect(types).toContain("delegation_complete");

    const complete = events.find((e) => e.type === "delegation_complete");
    expect(complete?.meta?.skillsUsed).toEqual(["writing", "parallel-web"]);
  });

  it("emits assistant_response when the message has content", () => {
    const events = buildTimeline(
      [makeMsg({ id: "a1", role: "assistant", content: "Hello" })],
      new Map()
    );
    expect(events[0].type).toBe("assistant_response");
    expect(events[0].detail).toBe("Hello");
  });
});

describe("exportMethodsSection", () => {
  it("returns empty string when given no events", () => {
    expect(exportMethodsSection([])).toBe("");
  });

  it("reports model and database info", () => {
    const events: ProvenanceEvent[] = [
      {
        id: "1",
        type: "user_query",
        label: "q",
        timestamp: 1000,
        meta: {
          model: "x-model",
          databases: ["pubmed", "arxiv"],
        },
      },
      {
        id: "2",
        type: "delegation_start",
        label: "d",
        timestamp: 2000,
      },
      {
        id: "3",
        type: "assistant_response",
        label: "ok",
        timestamp: 3000,
      },
    ];
    const out = exportMethodsSection(events);
    expect(out).toContain("x-model");
    expect(out).toContain("pubmed");
    expect(out).toContain("arxiv");
    expect(out).toMatch(/delegation/);
  });
});

describe("exportMethodsSectionFromManifests", () => {
  function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
    return {
      turnId: "t1",
      sessionId: "s1",
      timestamp: "2025-01-01T00:00:00Z",
      input: {
        promptSha256: "a",
        promptPreview: "p",
        attachments: [],
        databases: ["pubmed"],
        skills: ["writing"],
        compute: null,
      },
      env: {
        kadyVersion: "0.1",
        kadyCommitSha: null,
        model: "openrouter/x",
        expertModel: null,
        litellmConfigSha256: null,
        pythonVersion: "3.13",
        nodeVersion: null,
        geminiCliVersion: "0.1",
        platform: "darwin",
        mcpServers: [],
        seed: "seed-1",
      },
      delegations: [],
      output: {
        assistantTextSha256: null,
        deliverables: [],
        durationMs: 120_000,
      },
      ...overrides,
    };
  }

  it("returns empty string when given no manifests", () => {
    expect(exportMethodsSectionFromManifests([])).toBe("");
  });

  it("aggregates models, skills, databases, and citations", () => {
    const m = [
      manifest(),
      manifest({
        env: {
          ...manifest().env,
          model: "openrouter/y",
        },
        citations: { total: 3, verified: 2, unresolved: 1 },
      }),
    ];
    const text = exportMethodsSectionFromManifests(m);
    expect(text).toContain("openrouter/x");
    expect(text).toContain("openrouter/y");
    expect(text).toContain("pubmed");
    expect(text).toContain("'writing'");
    expect(text).toContain("2/3 references verified");
  });
});

describe("fetchManifests", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits when session id is empty", async () => {
    expect(await fetchManifests("", ["t1"])).toEqual([]);
  });

  it("filters out manifests that fail to fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turnId: "t1" }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const manifests = await fetchManifests("sess", ["t1", "t2"]);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].turnId).toBe("t1");
  });
});
