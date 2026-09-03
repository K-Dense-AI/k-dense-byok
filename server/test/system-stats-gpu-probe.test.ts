/**
 * GPU probe lifecycle (as opposed to the parsers, covered in
 * system-stats-gpu.test.ts).
 *
 * The UI polls /system/resources every ~3s for as long as a workspace is open,
 * and that is the only sampler that spawns an external process. AMD ships
 * `amd-smi.exe` in System32 and it requires Administrator on Windows, so each
 * spawn raised a UAC consent dialog — every few seconds, unaffected by the
 * user's answer, because consent is not inherited by the next spawn. These
 * tests pin the three defences: give up immediately on an elevation failure,
 * give up after repeated failures of any kind, and honour the throttle on the
 * failure path (a stale cache timestamp used to re-probe on every poll).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const hasBinaryMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

vi.mock("../src/binaries.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/binaries.ts")>();
  return { ...actual, hasBinary: hasBinaryMock };
});

/**
 * `promisify(execFile)` reads the callback-style export at module load, so the
 * mock has to speak that protocol. Node's promisify honours util.promisify.custom
 * only when present; supplying the callback form keeps this faithful to the
 * real module.
 */
function respondWith(impl: () => { stdout: string } | Error) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback?: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = callback ?? (_opts as typeof callback);
      const result = impl();
      if (result instanceof Error) cb?.(result);
      else cb?.(null, { stdout: result.stdout, stderr: "" });
      return undefined as never;
    },
  );
}

/** Fresh module instance per test: the disable flag is sticky by design. */
async function loadStats() {
  vi.resetModules();
  return await import("../src/system-stats.ts");
}

function elevationError(): NodeJS.ErrnoException {
  const err = new Error("spawn amd-smi EPERM") as NodeJS.ErrnoException;
  err.code = "EPERM";
  return err;
}

const AMD_METRIC = JSON.stringify([
  { gpu: 0, usage: { gfx_activity: { value: 42, unit: "%" } } },
]);

beforeEach(() => {
  vi.useFakeTimers();
  execFileMock.mockReset();
  hasBinaryMock.mockReset();
  // The reported case: no NVIDIA tool, amd-smi present (System32, needs admin).
  hasBinaryMock.mockImplementation((cmd: string) => cmd === "amd-smi");
  delete process.env.KADY_DISABLE_GPU_PROBE;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.KADY_DISABLE_GPU_PROBE;
});

describe("GPU probe gives up instead of re-prompting forever", () => {
  it("stops spawning the tool after one elevation failure", async () => {
    const { getSystemStats } = await loadStats();
    respondWith(() => elevationError());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First poll: one attempt, which fails asking for elevation.
    expect((await getSystemStats()).gpu).toBeNull();
    const attemptsAfterFirst = execFileMock.mock.calls.length;
    expect(attemptsAfterFirst).toBeGreaterThan(0);

    // Ten more polls, each well past the throttle window. Before the fix every
    // one of these spawned amd-smi again — i.e. another UAC dialog.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5_000);
      expect((await getSystemStats()).gpu).toBeNull();
    }

    expect(execFileMock.mock.calls.length).toBe(attemptsAfterFirst);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("GPU monitoring disabled"),
    );
    warn.mockRestore();
  });

  it("gives up after repeated non-elevation failures", async () => {
    const { getSystemStats } = await loadStats();
    respondWith(() => new Error("amd-smi: unknown flag"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(5_000);
      await getSystemStats();
    }

    // Three strikes, then no further spawns however long the chat stays open.
    expect(execFileMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed 3 times"));
    warn.mockRestore();
  });

  // The defect behind the endless prompts: the failure path returned early
  // without stamping the cache, so PROBE_INTERVAL_MS never applied.
  it("honours the probe interval on the failure path", async () => {
    const { getSystemStats } = await loadStats();
    respondWith(() => new Error("transient"));

    await getSystemStats();
    const afterFirst = execFileMock.mock.calls.length;
    // Two more polls inside the same throttle window must not re-spawn.
    vi.advanceTimersByTime(500);
    await getSystemStats();
    vi.advanceTimersByTime(500);
    await getSystemStats();

    expect(execFileMock.mock.calls.length).toBe(afterFirst);
  });

  // The escape hatch for a user who *grants* elevation: the call then succeeds,
  // so there is no failure to detect and only an explicit opt-out can stop it.
  it("skips the probe entirely when KADY_DISABLE_GPU_PROBE is set", async () => {
    process.env.KADY_DISABLE_GPU_PROBE = "1";
    const { getSystemStats } = await loadStats();
    respondWith(() => ({ stdout: AMD_METRIC }));

    const stats = await getSystemStats();

    expect(stats.gpu).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
    // The rest of the monitor still reports.
    expect(stats.cpu.cores).toBeGreaterThan(0);
    expect(stats.memory.totalBytes).toBeGreaterThan(0);
  });

  it("keeps sampling a tool that works", async () => {
    const { getSystemStats } = await loadStats();
    respondWith(() => ({ stdout: AMD_METRIC }));

    expect((await getSystemStats()).gpu).toMatchObject({ utilizationPct: 42 });
    vi.advanceTimersByTime(5_000);
    expect((await getSystemStats()).gpu).toMatchObject({ utilizationPct: 42 });
  });

  it("reports no GPU, without spawning, when no vendor tool is installed", async () => {
    hasBinaryMock.mockReturnValue(false);
    const { getSystemStats } = await loadStats();
    respondWith(() => ({ stdout: AMD_METRIC }));

    const stats = await getSystemStats();

    expect(stats.gpu).toBeNull();
    if (process.platform !== "darwin") expect(execFileMock).not.toHaveBeenCalled();
  });
});
