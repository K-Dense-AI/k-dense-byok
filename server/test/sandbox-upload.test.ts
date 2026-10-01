/**
 * Upload/download plumbing that used to lose user data: a re-upload silently
 * destroyed the existing file, and a non-ASCII or quote-bearing filename broke
 * the Content-Disposition header so the browser saved it under a mangled name.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { registerSandboxRoutes } from "../src/api/sandbox.ts";

const app = await buildApp();
const BOUNDARY = "----kadytest";

type UploadFile = { filename: string; content: string; relativePath?: string };

function multipart(files: UploadFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: text/plain\r\n\r\n${file.content}\r\n` +
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${file.relativePath ?? ""}\r\n`,
      ),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function upload(files: UploadFile[]) {
  return app.inject({
    method: "POST",
    url: "/sandbox/upload",
    headers: {
      "x-project-id": "default",
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipart(files),
  });
}

function uploadDir(): string {
  return resolvePaths("default").uploadDir;
}

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  ensureProjectExists("default");
  fs.mkdirSync(uploadDir(), { recursive: true });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("POST /sandbox/upload", () => {
  it("returns the multipart limit status and cleans up every staged file", async () => {
    const limited = Fastify();
    await limited.register(fastifyMultipart, { limits: { files: 1 } });
    await registerSandboxRoutes(limited);
    try {
      const res = await limited.inject({
        method: "POST", url: "/sandbox/upload",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        payload: multipart([
          { filename: "first.txt", content: "first" },
          { filename: "second.txt", content: "second" },
        ]),
      });
      expect(res.statusCode).toBe(413);
      expect(fs.readdirSync(uploadDir())).toEqual([]);
      expect(fs.readdirSync(resolvePaths("default").root).filter((name) => name.startsWith(".upload-"))).toEqual([]);
    } finally {
      await limited.close();
    }
  });

  it.each(["upload root", "nested folder"])("rejects the entire batch when a symlink at the %s escapes the sandbox", async (location) => {
    const outside = path.join(PROJECTS_ROOT, "outside");
    fs.mkdirSync(outside);
    const link = location === "upload root" ? uploadDir() : path.join(uploadDir(), "linked");
    if (location === "upload root") fs.rmdirSync(link);
    fs.symlinkSync(outside, link, "junction");

    const relativePath = location === "upload root" ? "new/proof.txt" : "linked/new/proof.txt";
    const res = await upload([
      { filename: "safe.txt", content: "must not be installed before the batch is validated" },
      { filename: "proof.txt", content: "must stay inside", relativePath },
    ]);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ detail: "Path traversal denied" });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(uploadDir(), "safe.txt"))).toBe(false);
    expect(fs.readdirSync(resolvePaths("default").root).filter((name) => name.startsWith(".upload-"))).toEqual([]);
  });

  it("preserves folder uploads and permits directory aliases within the sandbox", async () => {
    const target = path.join(uploadDir(), "dataset");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(uploadDir(), "alias"), "junction");

    const res = await upload([
      { filename: "a.csv", content: "first", relativePath: "dataset/nested/a.csv" },
      { filename: "b.csv", content: "second", relativePath: "alias/nested/b.csv" },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json().uploaded).toEqual(["user_data/dataset/nested/a.csv", "user_data/alias/nested/b.csv"]);
    expect(fs.readFileSync(path.join(target, "nested/a.csv"), "utf-8")).toBe("first");
    expect(fs.readFileSync(path.join(target, "nested/b.csv"), "utf-8")).toBe("second");
  });

  it("parks a colliding upload beside the original instead of overwriting it", async () => {
    const first = await upload([{ filename: "report.csv", content: "original" }]);
    expect(first.json()).toMatchObject({
      uploaded: ["user_data/report.csv"],
      renamed: [],
    });

    const second = await upload([{ filename: "report.csv", content: "replacement" }]);
    expect(second.json()).toEqual({
      uploaded: ["user_data/report (2).csv"],
      renamed: [{ from: "user_data/report.csv", to: "user_data/report (2).csv" }],
    });
    expect(fs.readFileSync(path.join(uploadDir(), "report.csv"), "utf-8")).toBe("original");
    expect(fs.readFileSync(path.join(uploadDir(), "report (2).csv"), "utf-8")).toBe(
      "replacement",
    );
  });

  it("leaves no staging directory behind", async () => {
    await upload([{ filename: "a.txt", content: "a" }]);
    const leftovers = fs
      .readdirSync(resolvePaths("default").root)
      .filter((name) => name.startsWith(".upload-"));
    expect(leftovers).toEqual([]);
  });
});

describe("download filename headers", () => {
  it("carries a non-ASCII name in filename* with an ASCII fallback", async () => {
    fs.writeFileSync(path.join(uploadDir(), "résumé.txt"), "hi", "utf-8");
    const res = await app.inject({
      method: "GET",
      url: "/sandbox/download?path=user_data/r%C3%A9sum%C3%A9.txt",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    const disposition = String(res.headers["content-disposition"]);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("résumé.txt")}`);
    expect(disposition).toMatch(/filename="r_sum_\.txt"/);
  });

  // NTFS forbids `"` in filenames, so the fixture cannot exist on Windows.
  it.skipIf(process.platform === "win32")("neutralizes a quote that would truncate the header", async () => {
    fs.writeFileSync(path.join(uploadDir(), 'we"ird.txt'), "hi", "utf-8");
    const res = await app.inject({
      method: "GET",
      url: `/sandbox/raw?path=${encodeURIComponent('user_data/we"ird.txt')}`,
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-disposition"])).toBe(
      `inline; filename="we_ird.txt"; filename*=UTF-8''${encodeURIComponent('we"ird.txt')}`,
    );
  });
});
