import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Installed resources are immutable. Never derive writable paths from cwd. */
export function runtimePaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()) {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packaged = env.KADY_PACKAGED === "1";
  const dataBase = platform === "darwin" ? path.join(home, "Library", "Application Support", "Kady")
    : platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Kady")
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "kady");
  const configBase = platform === "linux" ? path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "kady") : dataBase;
  const cacheBase = platform === "darwin" ? path.join(home, "Library", "Caches", "Kady")
    : platform === "win32" ? path.join(dataBase, "cache")
    : path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "kady");
  const data = path.resolve(env.KADY_DATA_DIR || (packaged ? dataBase : resources));
  const config = path.resolve(env.KADY_CONFIG_DIR || (packaged ? configBase : resources));
  const cache = path.resolve(env.KADY_CACHE_DIR || (packaged ? cacheBase : path.join(home, ".kady")));
  return { packaged, resources, data, config, cache,
    credentials: path.resolve(env.KADY_ENV_FILE || path.join(config, ".env")),
    projects: path.resolve(env.KADY_PROJECTS_ROOT || path.join(data, "projects")),
  };
}
