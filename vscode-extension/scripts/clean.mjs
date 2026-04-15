import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../dist", import.meta.url), {
    force: true,
    recursive: true,
  }),
  rm(new URL("../out", import.meta.url), {
    force: true,
    recursive: true,
  }),
]);
