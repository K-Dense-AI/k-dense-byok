import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import {
  setCredentialEnvPathForTests,
  setModalCredentialValidatorForTests,
} from "../src/api/credentials.ts";
import { modalJobManager } from "../src/modal/manager.ts";
import { listComputeReservations } from "../src/cost/ledger.ts";
import { FakeModal } from "./helpers/fake-modal.ts";

const originalId = process.env.MODAL_TOKEN_ID;
const originalSecret = process.env.MODAL_TOKEN_SECRET;

beforeEach(() => {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
  setCredentialEnvPathForTests(`${PROJECTS_ROOT}/test.env`);
});

afterEach(() => {
  modalJobManager.setAdapterFactoryForTests(null);
  setModalCredentialValidatorForTests(null);
  setCredentialEnvPathForTests(null);
  if (originalId === undefined) delete process.env.MODAL_TOKEN_ID;
  else process.env.MODAL_TOKEN_ID = originalId;
  if (originalSecret === undefined) delete process.env.MODAL_TOKEN_SECRET;
  else process.env.MODAL_TOKEN_SECRET = originalSecret;
});

describe("Modal HTTP API and credentials", () => {
  it("serves the authoritative catalogue and project-scoped empty job views", async () => {
    const app = await buildApp();
    try {
      const catalogue = await app.inject({ method: "GET", url: "/modal/instances" });
      expect(catalogue.statusCode).toBe(200);
      const body = catalogue.json();
      expect(body.estimatedBilling).toBe(true);
      expect(body.instances.map((instance: { id: string }) => instance.id)).toContain("b200");

      const jobs = await app.inject({
        method: "GET",
        url: "/modal/jobs",
        headers: { "x-project-id": "default" },
      });
      expect(jobs.statusCode).toBe(200);
      expect(jobs.json()).toEqual({ jobs: [], groups: [] });

      const groups = await app.inject({ method: "GET", url: "/modal/groups" });
      expect(groups.json()).toEqual({ groups: [] });
      const cache = await app.inject({ method: "GET", url: "/modal/cache" });
      expect(cache.json()).toMatchObject({
        canonicalFilesystem: "local-project-sandbox",
        cacheOnly: true,
      });
    } finally {
      await app.close();
    }
  });

  it("reads every job record once per list poll", async () => {
    const app = await buildApp();
    const list = vi.spyOn(modalJobManager.store, "list");
    try {
      const response = await app.inject({ method: "GET", url: "/modal/jobs" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobs: [], groups: [] });
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore();
      await app.close();
    }
  });

  it("writes the credential .env file owner-only", async () => {
    setModalCredentialValidatorForTests(async () => {});
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          modalTokenId: "token-id-valid-length",
          modalTokenSecret: "token-secret-valid-length",
        },
      });
      expect(response.statusCode).toBe(200);
      const envFile = `${PROJECTS_ROOT}/test.env`;
      expect(fs.readFileSync(envFile, "utf-8")).toContain("MODAL_TOKEN_ID=");
      if (process.platform !== "win32") {
        expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed image at submission, before any budget reservation", async () => {
    modalJobManager.setAdapterFactoryForTests(new FakeModal().factory);
    const app = await buildApp();
    try {
      for (const image of [
        { pip: "numpy; rm -rf /" },
        { pip: ["numpy; rm -rf /"] },
        { base: 42 },
        "python:3.12",
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/modal/jobs",
          payload: { command: "echo ready", image },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "INVALID_IMAGE" });
      }
      expect(listComputeReservations("default")).toEqual([]);
      const jobs = await app.inject({ method: "GET", url: "/modal/jobs" });
      expect(jobs.json().jobs).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects half a Modal credential pair without mutating live env", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: { modalTokenId: "token-id-valid-length" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/pair/i);
      expect(process.env.MODAL_TOKEN_ID).toBeUndefined();
      expect(process.env.MODAL_TOKEN_SECRET).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("keeps the job API present but rejects submission while unconfigured", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/modal/jobs",
        payload: { command: "echo ready" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "NOT_CONFIGURED" });
    } finally {
      await app.close();
    }
  });

  it("performs harmless validation before persisting a complete Modal pair", async () => {
    let called = 0;
    setModalCredentialValidatorForTests(async (id, secret) => {
      called++;
      expect(id).toBe("token-id-valid-length");
      expect(secret).toBe("token-secret-valid-length");
      throw new Error("invalid Modal credentials");
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          modalTokenId: "token-id-valid-length",
          modalTokenSecret: "token-secret-valid-length",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/could not be validated/i);
      expect(called).toBe(1);
      expect(process.env.MODAL_TOKEN_ID).toBeUndefined();
      expect(process.env.MODAL_TOKEN_SECRET).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("persists and activates both values only after successful validation", async () => {
    let called = 0;
    setModalCredentialValidatorForTests(async () => {
      called++;
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/credentials",
        payload: {
          modalTokenId: "token-id-valid-length",
          modalTokenSecret: "token-secret-valid-length",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(called).toBe(1);
      expect(process.env.MODAL_TOKEN_ID).toBe("token-id-valid-length");
      expect(process.env.MODAL_TOKEN_SECRET).toBe("token-secret-valid-length");
      const persisted = fs.readFileSync(`${PROJECTS_ROOT}/test.env`, "utf-8");
      expect(persisted).toContain("MODAL_TOKEN_ID=token-id-valid-length");
      expect(persisted).toContain("MODAL_TOKEN_SECRET=token-secret-valid-length");
    } finally {
      await app.close();
    }
  });
});
