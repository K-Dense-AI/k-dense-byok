/** Child-only loopback bridge. Uses node:http(s), not global fetch/proxy
 * dispatchers, and never follows redirects to an external destination. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import type { MemoryToolResult } from "./memory-tool.ts";
const VALID_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function memoryProjectId(cwd = process.cwd(), explicit = process.env.KADY_PROJECT_ID): string {
  let dir = path.resolve(cwd);
  let found: string | undefined;
  let sawSandbox = false;
  for (let depth = 0; depth < 32; depth++) {
    if (path.basename(dir) === "sandbox") {
      sawSandbox = true;
      const file = path.join(path.dirname(dir), "project.json");
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
          const meta = JSON.parse(fs.readFileSync(file, "utf8"));
          if (typeof meta.id === "string" && VALID_PROJECT.test(meta.id) && meta.id === path.basename(path.dirname(dir))) found = meta.id;
        }
      } catch { /* no usable project metadata */ }
      if (found) break;
    }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  if (sawSandbox && !found) throw new Error("Sandbox project metadata is unavailable; no fallback project was queried");
  if (explicit && (!VALID_PROJECT.test(explicit) || found && found !== explicit)) throw new Error("Research memory project context is invalid or conflicts with the sandbox");
  const id = found ?? explicit;
  if (!id) throw new Error("Cannot establish the child project for research memory; no fallback project was queried");
  return id;
}
export function memoryApiBase(raw = process.env.KADY_INTERNAL_URL || `http://127.0.0.1:${process.env.KADY_PORT || process.env.PORT || "8000"}`): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("Research memory only connects to a loopback Kady API");
  return url;
}
export async function callMemoryApi(params: unknown, signal?: AbortSignal): Promise<MemoryToolResult> {
  const projectId = memoryProjectId();
  const base = memoryApiBase();
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/notebook/memory/tool`;
  const body = JSON.stringify(params);
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error("Research memory request is too large");
  return new Promise((resolve, reject) => {
    const request = (base.protocol === "https:" ? https : http).request(base, {
      method: "POST", signal, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Project-Id": projectId },
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024) { response.destroy(new Error("Research memory response exceeded its bound")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200) throw new Error(data.detail ?? `Research memory API returned ${response.statusCode}; no fallback source was used`);
          if (!Array.isArray(data.content) || data.content.length !== 1 || data.content[0]?.type !== "text" || typeof data.content[0].text !== "string" || Buffer.byteLength(data.content[0].text) > 24 * 1024 || !Array.isArray(data.details?.sources)) throw new Error("Invalid bounded research memory response");
          resolve({ content: [{ type: "text", text: data.content[0].text }], details: { memory: true, sources: data.details.sources.slice(0, 12) } });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(20_000, () => request.destroy(new Error("Research memory API timed out; do not infer absence of prior work")));
    request.end(body);
  });
}
