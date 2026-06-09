import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Each run gets an isolated projects root under the OS temp dir.
    env: {
      KADY_PROJECTS_ROOT: process.env.VITEST_PROJECTS_ROOT ?? "/tmp/kady-vitest-projects",
    },
  },
});
