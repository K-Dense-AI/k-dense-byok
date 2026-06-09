/**
 * K-Dense BYOK backend (TypeScript, Pi SDK).
 *
 * Replaces the Python FastAPI + Google ADK server. Boots Fastify, applies the
 * same project-scoping contract the frontend expects (X-Project-Id header /
 * ?project query / kady-project cookie), and registers the route plugins.
 */
import "./env.ts";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyRequest } from "fastify";
import { DEFAULT_PROJECT_ID, HOST, PORT, modalConfigured } from "./config.ts";
import { ensureProjectExists } from "./projects.ts";
import { withActiveProject } from "./scope.ts";
import { registerProjectRoutes } from "./api/projects.ts";
import { registerSessionRoutes } from "./api/sessions.ts";
import { registerSandboxRoutes } from "./api/sandbox.ts";
import { registerSystemRoutes } from "./api/system.ts";

// Allow any local dev UI port plus common LAN ranges (Next.js picks 3001+ when
// 3000 is taken). Ported from server.py's CORS allow-list.
const CORS_ALLOW = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/\[::1\]:\d+$/,
  /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}:\d+$/,
];

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function resolveProjectId(req: FastifyRequest): string {
  const header = req.headers["x-project-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const q = (req.query as Record<string, unknown> | undefined)?.project;
  const candidates: (string | undefined)[] = [
    fromHeader != null ? String(fromHeader) : undefined,
    q != null ? String(q) : undefined,
    readCookie(req, "kady-project"),
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return DEFAULT_PROJECT_ID;
}

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, same-origin) send no Origin → allow.
      if (!origin) return cb(null, true);
      const ok = CORS_ALLOW.some((re) => re.test(origin));
      cb(null, ok);
    },
    credentials: true,
  });

  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

  // Binary/unknown request bodies (e.g. PUT /sandbox/file) → raw Buffer.
  // JSON and text/plain keep their built-in parsers; multipart is handled above.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  // Project scope: resolve the active project and run the rest of the request
  // lifecycle inside its AsyncLocalStorage context. Calling `done` inside
  // withActiveProject keeps the store active for downstream hooks + handler.
  app.addHook("onRequest", (req, _reply, done) => {
    let projectId = resolveProjectId(req);
    try {
      ensureProjectExists(projectId);
    } catch {
      projectId = DEFAULT_PROJECT_ID;
      ensureProjectExists(projectId);
    }
    withActiveProject(projectId, () => done());
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/config", async () => ({ modal_configured: modalConfigured() }));

  await registerProjectRoutes(app);
  await registerSessionRoutes(app);
  await registerSandboxRoutes(app);
  await registerSystemRoutes(app);

  return app;
}

// Boot when run directly (tsx src/index.ts), not when imported by tests.
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = await buildApp();
  app
    .listen({ port: PORT, host: HOST })
    .then((addr) => app.log.info(`kady-server listening on ${addr}`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
