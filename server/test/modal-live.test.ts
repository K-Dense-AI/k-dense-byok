import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import { DurableModalJobManager } from "../src/modal/manager.ts";

const enabled = process.env.MODAL_LIVE_TEST === "1";

describe.skipIf(!enabled)("Modal live smoke", () => {
  const manager = new DurableModalJobManager();

  beforeAll(() => {
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      throw new Error(
        "MODAL_LIVE_TEST=1 requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET",
      );
    }
    fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    ensureProjectExists("default");
    fs.writeFileSync(
      path.join(resolvePaths("default").sandbox, "modal-live-input.txt"),
      "live\n",
    );
  });

  afterAll(async () => {
    await manager.cancelProject("default");
  });

  it(
    "runs a durable CPU job and atomically returns its output",
    async () => {
      const job = manager.submit(
        "default",
        {
          command:
            "python -c \"from pathlib import Path; " +
            "Path('modal-live-output.txt').write_text(" +
            "Path('modal-live-input.txt').read_text().upper())\"",
          instance: "cpu",
          timeoutSec: 120,
          filesIn: ["modal-live-input.txt"],
          filesOut: ["modal-live-output.txt"],
        },
        { sessionId: "modal-live-test", submittedBy: "api" },
      );
      const terminal = await manager.wait("default", job.id, 180_000);
      expect(terminal.state).toBe("succeeded");
      expect(terminal.accounting.reconciled).toBe(true);
      expect(
        fs.readFileSync(
          path.join(resolvePaths("default").sandbox, "modal-live-output.txt"),
          "utf-8",
        ),
      ).toBe("LIVE\n");
    },
    200_000,
  );
});

