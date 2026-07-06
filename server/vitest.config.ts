import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Multiple test files reset/repopulate this same shared directory in
    // beforeEach/afterAll; running files concurrently races on it (ENOTEMPTY,
    // files vanishing mid-assertion). Run test files serially to avoid that.
    fileParallelism: false,
    // Each run gets an isolated projects root under the OS temp dir.
    env: {
      KADY_PROJECTS_ROOT:
        process.env.VITEST_PROJECTS_ROOT ?? path.join(os.tmpdir(), "kady-vitest-projects"),
    },
  },
});
