import { spawnSync } from "node:child_process";

const testCommand = ["node", "./out/test/runTest.js"];
const shouldUseXvfb = process.platform === "linux";

const result = shouldUseXvfb
  ? spawnSync("xvfb-run", ["-a", ...testCommand], {
      stdio: "inherit",
    })
  : null;

if (result?.error && result.error.code !== "ENOENT") {
  throw result.error;
}

if (result && !result.error) {
  process.exit(result.status ?? 1);
}

const fallback = spawnSync(testCommand[0], testCommand.slice(1), {
  stdio: "inherit",
});

if (fallback.error) {
  throw fallback.error;
}

process.exit(fallback.status ?? 1);
