import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEnvFile } from "./env-file.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
// Credentials/configuration saved by Settings take precedence over ambient
// exports, while transport and private runtime paths remain launcher-owned.
const owned = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["KADY_PACKAGED", "KADY_DATA_DIR", "KADY_CONFIG_DIR", "KADY_CACHE_DIR", "KADY_PROJECTS_ROOT", "KADY_HOST", "KADY_PORT", "KADY_API_URL", "KADY_FRONTEND_PORT", "KADY_CONTROL_URL", "KADY_AUTH_TOKEN", "KADY_REQUIRE_AUTH", "KADY_LAUNCHER", "NODE_OPTIONS", "NODE_PATH", "NODE_ENV", "PATH", "PORT", "HOSTNAME", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "GIT_EXEC_PATH", "PI_BASH_PATH"].includes(key)));
applyEnvFile(path.join(process.env.KADY_CONFIG_DIR, ".env"), { override: true });
Object.assign(process.env, owned);
process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
if (process.platform !== "win32") process.umask(0o077);
const role = process.argv[2];
const entry = role === "backend" ? path.join(root, "server", "src", "index.ts")
  : role === "frontend" ? path.join(root, "frontend", "server.js") : null;
if (!entry || !fs.existsSync(entry)) throw new Error("Missing application entry point: " + role);
process.argv = [process.execPath, entry];
await import(pathToFileURL(entry).href);
