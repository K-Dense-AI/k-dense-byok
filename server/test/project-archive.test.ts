import fs from "node:fs";
import path from "node:path";
import { buffer as consumeBuffer } from "node:stream/consumers";
import AdmZip from "adm-zip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  ensureProjectExists,
  resolvePaths,
} from "../src/projects.ts";
import {
  appendNotebookEntry,
  type NotebookEntry,
} from "../src/agent/notebook-store.ts";
import { writeNotebookAnnotations } from "../src/agent/notebook-annotations.ts";
import {
  buildProjectArchive,
  type ProjectArchiveOptions,
} from "../src/project-archive.ts";

const app = await buildApp();

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function zipText(zip: AdmZip, entry: string): string {
  const found = zip.getEntry(entry);
  expect(found, `missing ${entry}`).not.toBeNull();
  return found!.getData().toString("utf-8");
}

async function finishArchive(
  opts: ProjectArchiveOptions,
): Promise<Buffer> {
  const { archive } = await buildProjectArchive(opts);
  const result = consumeBuffer(archive);
  await archive.finalize();
  return result;
}

type ArchiveSession = NonNullable<ProjectArchiveOptions["sessions"]>[number];

function archiveSession(
  pathName: string,
  over: Partial<ArchiveSession> = {},
): ArchiveSession {
  return {
    id: "chat-1",
    path: pathName,
    name: "Analysis chat",
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date("2026-01-01T01:00:00Z"),
    messageCount: 2,
    firstMessage: "Analyze the data",
    ...over,
  } as ArchiveSession;
}

function message(role: string, text: string) {
  return {
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  };
}

describe("buildProjectArchive", () => {
  it("keeps visible sandbox files and adds raw/readable non-empty chats", async () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "results.txt"), "result", "utf-8");
    fs.writeFileSync(path.join(paths.sessionsDir, "settings.json"), "hidden", "utf-8");

    const chatFile = path.join(paths.sessionsDir, "chat-1.jsonl");
    fs.writeFileSync(
      chatFile,
      [
        JSON.stringify({ type: "session", id: "chat-1" }),
        JSON.stringify(message("user", "Analyze the data")),
        JSON.stringify(message("assistant", "Analysis complete")),
      ].join("\n") + "\n",
      "utf-8",
    );
    const emptyFile = path.join(paths.sessionsDir, "empty.jsonl");
    fs.writeFileSync(
      emptyFile,
      JSON.stringify({ type: "session", id: "empty" }) + "\n",
      "utf-8",
    );

    const buffer = await finishArchive({
      paths,
      projectName: "Archive test",
      sessions: [
        archiveSession(chatFile),
        archiveSession(emptyFile, { id: "empty", messageCount: 0 }),
      ],
    });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((entry) => entry.entryName);

    expect(names).toContain("results.txt");
    expect(names).not.toContain(".pi/sessions/settings.json");
    expect(names).toContain("chat-history/raw/chat-1.jsonl");
    expect(names).toContain("chat-history/markdown/chat-1.md");
    expect(names).not.toContain("chat-history/raw/empty.jsonl");
    expect(zipText(zip, "chat-history/raw/chat-1.jsonl")).toContain(
      '"id":"chat-1"',
    );
    expect(zipText(zip, "chat-history/markdown/chat-1.md")).toContain(
      "Analyze the data",
    );
    const manifest = JSON.parse(zipText(zip, "chat-history/manifest.json"));
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]).toMatchObject({
      id: "chat-1",
      messageCount: 2,
    });
  });

  it("includes every live notebook, annotations, and safe artifact links", async () => {
    const paths = resolvePaths("default");
    fs.mkdirSync(path.join(paths.sandbox, "figures"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.sandbox, "figures", "plot.png"),
      "PNG",
      "utf-8",
    );
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    fs.writeFileSync(path.join(paths.kadyDir, "private.txt"), "no", "utf-8");

    const entry: NotebookEntry = {
      id: "entry-1",
      type: "observation",
      title: "Signal found",
      body: "The signal is strong.",
      timestamp: 1_000,
      role: "agent",
      artifacts: ["figures/plot.png", ".kady/private.txt"],
    };
    appendNotebookEntry("notebook-1", entry, "default");
    writeNotebookAnnotations(
      "notebook-1",
      {
        version: 1,
        annotations: [
          {
            id: "pin-1",
            kind: "pin",
            entryId: "entry-1",
            createdAt: 2_000,
          },
          {
            id: "comment-1",
            kind: "comment",
            entryId: "entry-1",
            body: "Check this result.",
            createdAt: 3_000,
          },
          {
            id: "note-1",
            kind: "note",
            title: "Follow-up",
            body: "Repeat with more samples.",
            createdAt: 4_000,
          },
        ],
      },
      "default",
    );
    writeNotebookAnnotations(
      "notes-only",
      {
        version: 1,
        annotations: [
          {
            id: "note-2",
            kind: "note",
            body: "Annotation-only session.",
            createdAt: 5_000,
          },
        ],
      },
      "default",
    );

    const buffer = await finishArchive({
      paths,
      projectName: "Notebook test",
      sessions: [],
    });
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((item) => item.entryName);

    expect(names).toContain("figures/plot.png");
    expect(names).not.toContain(".kady/private.txt");
    expect(names).toContain("notebook/raw/notebook-1.jsonl");
    expect(names).toContain("notebook/raw/notebook-1.annotations.json");
    expect(names).toContain("notebook/markdown/notebook-1.md");
    expect(names).toContain("notebook/raw/notes-only.annotations.json");
    expect(names).toContain("notebook/markdown/notes-only.md");

    const markdown = zipText(zip, "notebook/markdown/notebook-1.md");
    expect(markdown).toContain("![plot.png](../../figures/plot.png)");
    expect(markdown).toContain(
      "`.kady/private.txt` _(artifact missing at export time)_",
    );
    expect(markdown).toContain("Pinned by user");
    expect(markdown).toContain("Check this result.");
    expect(markdown).toContain("Repeat with more samples.");

    const manifest = JSON.parse(zipText(zip, "notebook/manifest.json"));
    expect(manifest.sessions.map((session: { sessionId: string }) => session.sessionId))
      .toEqual(["notebook-1", "notes-only"]);
    expect(manifest.sessions[0].annotations).toHaveLength(3);
  });
});

describe("GET /sandbox/download-all", () => {
  it("hides system files and dependency caches from the sandbox tree", async () => {
    const paths = ensureProjectExists("alpha");
    fs.mkdirSync(path.join(paths.sandbox, "node_modules", "package"), { recursive: true });
    fs.mkdirSync(path.join(paths.sandbox, "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(paths.sandbox, "analysis-venv", "lib"), { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "node_modules", "package", "index.js"), "");
    fs.writeFileSync(path.join(paths.sandbox, "__pycache__", "module.pyc"), "");
    fs.writeFileSync(path.join(paths.sandbox, "analysis-venv", "lib", "dependency.py"), "");
    fs.writeFileSync(path.join(paths.sandbox, "results.csv"), "value\n1\n");
    expect(fs.existsSync(path.join(paths.sandbox, "AGENTS.md"))).toBe(true);

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    const tree = JSON.stringify(response.json());
    expect(tree).toContain("results.csv");
    expect(tree).not.toContain("AGENTS.md");
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain("__pycache__");
    expect(tree).not.toContain("analysis-venv");

    const etag = response.headers.etag;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const unchanged = await app.inject({
      method: "GET",
      url: "/sandbox/tree",
      headers: {
        "x-project-id": "alpha",
        "if-none-match": etag,
      },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
  });

  it("streams a directory ZIP through the folder download endpoint", async () => {
    const paths = ensureProjectExists("alpha");
    const directory = path.join(paths.sandbox, "dataset", "nested");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(paths.sandbox, "dataset", "samples.csv"), "sample\n1\n");
    fs.writeFileSync(path.join(directory, "results.txt"), "complete");
    fs.writeFileSync(path.join(directory, ".hidden"), "private");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/download-dir?path=dataset",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toContain(
      'filename="dataset.zip"',
    );
    const names = new AdmZip(response.rawPayload)
      .getEntries()
      .map((entry) => entry.entryName);
    expect(names).toContain("samples.csv");
    expect(names).toContain("nested/results.txt");
    expect(names).not.toContain("nested/.hidden");
  });

  it("returns a scoped project archive through the existing download contract", async () => {
    const alpha = ensureProjectExists("alpha");
    const beta = ensureProjectExists("beta");
    fs.writeFileSync(path.join(alpha.sandbox, "alpha.txt"), "alpha", "utf-8");
    fs.writeFileSync(path.join(beta.sandbox, "beta.txt"), "beta", "utf-8");

    const response = await app.inject({
      method: "GET",
      url: "/sandbox/download-all",
      headers: { "x-project-id": "alpha" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toContain(
      'filename="sandbox.zip"',
    );
    const names = new AdmZip(response.rawPayload)
      .getEntries()
      .map((entry) => entry.entryName);
    expect(names).toContain("alpha.txt");
    expect(names).not.toContain("AGENTS.md");
    expect(names).not.toContain("beta.txt");
  });
});
