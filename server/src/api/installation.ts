import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { runtimePaths } from "../runtime-paths.ts";
import { helperStatus, installHelpers } from "../installation.ts";

export async function registerInstallationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/installation", async () => {
    const paths = runtimePaths();
    return paths.packaged ? { packaged: true, projects: paths.projects, helpers: helperStatus(),
      releaseUrl: "https://github.com/K-Dense-AI/k-dense-byok/releases/latest" } : { packaged: false };
  });
  app.post("/installation/helpers", async (_req, reply) => {
    if (!runtimePaths().packaged) return reply.code(404).send({ detail: "Available in installed Kady." });
    try { return reply.code(202).send(installHelpers()); }
    catch (error) { return reply.code(503).send({ detail: String(error) }); }
  });
  app.get("/installation/logs", async (_req, reply) => {
    if (!runtimePaths().packaged) return reply.code(404).send({ detail: "Available in installed Kady." });
    const file = path.join(runtimePaths().data, "logs", "kady.log");
    try {
      const handle = await fs.promises.open(file, "r");
      try {
        const size = (await handle.stat()).size;
        const bytes = Buffer.alloc(Math.min(size, 128 * 1024));
        await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        return reply.type("text/plain").send(bytes.toString());
      } finally { await handle.close(); }
    } catch { return reply.type("text/plain").send("No startup log is available yet."); }
  });
  app.post("/installation/stop", async (_req, reply) => {
    if (!runtimePaths().packaged || !process.env.KADY_CONTROL_URL) return reply.code(404).send({ detail: "Available in installed Kady." });
    try {
      const response = await fetch(process.env.KADY_CONTROL_URL + "/stop", {
        method: "POST", headers: { "X-Kady-Token": process.env.KADY_AUTH_TOKEN || "" }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("The launcher could not stop Kady.");
      return { stopping: true };
    } catch (error) { return reply.code(503).send({ detail: String(error) }); }
  });
  app.post<{ Body: { source?: unknown } }>("/installation/import", async (req, reply) => {
    if (!runtimePaths().packaged || !process.env.KADY_CONTROL_URL) return reply.code(404).send({ detail: "Available in installed Kady." });
    if (typeof req.body?.source !== "string" || !path.isAbsolute(req.body.source)) return reply.code(400).send({ detail: "Enter the full path to your existing Kady installation." });
    try {
      const response = await fetch(process.env.KADY_CONTROL_URL + "/import", {
        method: "POST", headers: { "X-Kady-Token": process.env.KADY_AUTH_TOKEN || "", "Content-Type": "application/json" },
        body: JSON.stringify({ source: req.body.source }), signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return reply.code(response.status).send({ detail: await response.text() });
      return { stopping: true };
    } catch (error) { return reply.code(503).send({ detail: String(error) }); }
  });
}
