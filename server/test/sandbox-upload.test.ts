/**
 * Upload/download plumbing that used to lose user data: a re-upload silently
 * destroyed the existing file, and a non-ASCII or quote-bearing filename broke
 * the Content-Disposition header so the browser saved it under a mangled name.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";

const app = await buildApp();
const BOUNDARY = "----kadytest";

function multipart(files: { filename: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: text/plain\r\n\r\n${file.content}\r\n`,
      ),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function upload(files: { filename: string; content: string }[]) {
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

  it("neutralizes a quote that would truncate the header", async () => {
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
