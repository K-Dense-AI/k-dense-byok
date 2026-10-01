/**
 * PUT /credentials persists into `.env`, which the launcher loads with
 * override:true on the next start. A value must never be able to write a
 * second assignment (NODE_OPTIONS=…, KADY_HOST=…) or be silently corrupted.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { applyEnvFile } from "../../env-file.mjs";
import { setCredentialEnvPathForTests } from "../src/api/credentials.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { buildApp } from "../src/index.ts";

const app = await buildApp();
const envFile = path.join(PROJECTS_ROOT, "injection.env");

beforeEach(() => {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  fs.writeFileSync(envFile, "");
  setCredentialEnvPathForTests(envFile);
  delete process.env.EXA_API_KEY;
  delete process.env.NODE_OPTIONS_PROBE;
});

afterAll(async () => {
  setCredentialEnvPathForTests(null);
  delete process.env.EXA_API_KEY;
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

function put(body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/credentials",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

describe("credential persistence", () => {
  it("refuses a value that would add its own .env line", async () => {
    const res = await put({ exaApiKey: 'xxxxxxxx"\nNODE_OPTIONS_PROBE=--import=data:x #' });
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(envFile, "utf-8")).not.toContain("NODE_OPTIONS_PROBE");
    expect(process.env.EXA_API_KEY).toBeUndefined();
  });

  it("refuses non-string values instead of clearing the key", async () => {
    process.env.EXA_API_KEY = "existing-key-123";
    const res = await put({ exaApiKey: 12345678 });
    expect(res.statusCode).toBe(400);
    expect(process.env.EXA_API_KEY).toBe("existing-key-123");
  });

  it("round-trips values containing quotes, hashes and backslashes", async () => {
    for (const value of ['abc"def#ghi', "abc'def ghi", "C:\\keys\\svc-account.json"]) {
      const res = await put({ exaApiKey: value });
      expect(res.statusCode).toBe(200);
      delete process.env.EXA_API_KEY;
      applyEnvFile(envFile, { override: true });
      expect(process.env.EXA_API_KEY).toBe(value);
    }
  });
});
