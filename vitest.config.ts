// Fail closed before test discovery: backend tests delete and recreate their
// project root and must load server/vitest.config.ts to isolate that data.
throw new Error(
  "Do not run Vitest from the repository root. Run npm test --prefix server " +
  "or npm test --prefix web so the suite loads its isolated configuration.",
);
export {};
