/**
 * System-resource sampling for the header resource monitor.
 *
 * One cheap snapshot per call: CPU from `os.cpus()` tick deltas between calls,
 * memory with platform-aware "used" (macOS `vm_stat`, Linux `MemAvailable`,
 * else total-free), disk from `statfs` on the projects volume, and GPU from
 * `nvidia-smi` when present or `ioreg` on Apple Silicon. External probes are
 * throttled and fall back to the last good reading, so a 2-3s UI poll stays
 * negligible.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { hasBinary } from "./binaries.ts";
import { PROJECTS_ROOT } from "./config.ts";

const execFileP = promisify(execFile);
const EXEC_OPTS = { timeout: 2000, windowsHide: true } as const;
/** Minimum spacing between external probe runs (vm_stat / ioreg / nvidia-smi). */
const PROBE_INTERVAL_MS = 2000;

export interface SystemStats {
  ts: number;
  cpu: {
    /** Whole-machine CPU busy, 0-100. */
    systemPct: number;
    /** This backend process, as % of total machine capacity, 0-100. */
    processPct: number;
    cores: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    /** RSS of this backend process. */
    processRssBytes: number;
  };
  disk: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
  } | null;
  gpu: {
    name: string;
    utilizationPct: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// CPU: percentages need two snapshots, so keep the previous one in module
// state and report the busy fraction over the elapsed window.

interface CpuSample {
  at: number;
  idle: number;
  total: number;
  proc: NodeJS.CpuUsage;
}

function takeCpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v;
    idle += cpu.times.idle;
  }
  return { at: Date.now(), idle, total, proc: process.cpuUsage() };
}

let lastCpuSample = takeCpuSample();
let lastCpuResult = { systemPct: 0, processPct: 0 };

function sampleCpu(): { systemPct: number; processPct: number } {
  const now = takeCpuSample();
  const elapsedMs = now.at - lastCpuSample.at;
  // Too soon for a meaningful delta -- reuse the previous reading.
  if (elapsedMs < 250) return lastCpuResult;

  const dTotal = now.total - lastCpuSample.total;
  const dIdle = now.idle - lastCpuSample.idle;
  const systemPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;

  const dProcUs =
    now.proc.user - lastCpuSample.proc.user + (now.proc.system - lastCpuSample.proc.system);
  const capacityUs = elapsedMs * 1000 * os.cpus().length;
  const processPct = capacityUs > 0 ? Math.max(0, Math.min(100, (dProcUs / capacityUs) * 100)) : 0;

  lastCpuSample = now;
  lastCpuResult = { systemPct, processPct };
  return lastCpuResult;
}

// ---------------------------------------------------------------------------
// Memory: os.freemem() on macOS/Linux only counts truly-free pages (file
// cache excluded), which pins the gauge near 100% on any warm machine. Use
// the platform's "available" notion instead where we can.

let memCache: { at: number; usedBytes: number } | null = null;

async function usedMemoryBytes(totalBytes: number): Promise<number> {
  const now = Date.now();
  if (memCache && now - memCache.at < PROBE_INTERVAL_MS) return memCache.usedBytes;

  let used = totalBytes - os.freemem();
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileP("vm_stat", [], EXEC_OPTS);
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 16384);
      const pages = (label: string): number =>
        Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      // Activity Monitor's "Memory Used" = active + wired + compressed.
      const usedPages =
        pages("Pages active") +
        pages("Pages wired down") +
        pages("Pages occupied by compressor");
      if (usedPages > 0) used = usedPages * pageSize;
    } else if (process.platform === "linux") {
      const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
      const kb = (label: string): number =>
        Number(new RegExp(`${label}:\\s+(\\d+) kB`).exec(meminfo)?.[1] ?? 0);
      const availableKb = kb("MemAvailable");
      if (availableKb > 0) used = totalBytes - availableKb * 1024;
    }
  } catch {
    // fall through with the total-free estimate
  }
  used = Math.max(0, Math.min(totalBytes, used));
  memCache = { at: now, usedBytes: used };
  return used;
}

// ---------------------------------------------------------------------------
// GPU: NVIDIA everywhere via nvidia-smi; Apple Silicon via the IOAccelerator
// performance statistics (no sudo needed, unlike powermetrics). Anything else
// reports no GPU and the UI hides the segment.

let gpuCache: { at: number; value: SystemStats["gpu"] } | null = null;

async function sampleGpu(): Promise<SystemStats["gpu"]> {
  const now = Date.now();
  if (gpuCache && now - gpuCache.at < PROBE_INTERVAL_MS) return gpuCache.value;

  let value: SystemStats["gpu"] = null;
  try {
    if (hasBinary("nvidia-smi")) {
      const { stdout } = await execFileP(
        "nvidia-smi",
        ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
        EXEC_OPTS,
      );
      const first = stdout.trim().split("\n")[0];
      if (first) {
        const [name, util, memUsed, memTotal] = first.split(",").map((s) => s.trim());
        value = {
          name: name || "NVIDIA GPU",
          utilizationPct: Number.isFinite(Number(util)) ? Number(util) : null,
          memUsedBytes: Number.isFinite(Number(memUsed)) ? Number(memUsed) * 1024 * 1024 : null,
          memTotalBytes: Number.isFinite(Number(memTotal)) ? Number(memTotal) * 1024 * 1024 : null,
        };
      }
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileP("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], EXEC_OPTS);
      const util = /"Device Utilization %"=(\d+)/.exec(stdout)?.[1];
      if (util !== undefined) {
        value = {
          name: "Apple GPU",
          utilizationPct: Number(util),
          // Unified memory -- no separate VRAM pool to report.
          memUsedBytes: null,
          memTotalBytes: null,
        };
      }
    }
  } catch {
    // keep whatever we last saw rather than flapping to null on a slow probe
    if (gpuCache) return gpuCache.value;
  }
  gpuCache = { at: now, value };
  return value;
}

// ---------------------------------------------------------------------------

async function sampleDisk(): Promise<SystemStats["disk"]> {
  try {
    const s = await fs.promises.statfs(PROJECTS_ROOT);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return null;
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  const totalBytes = os.totalmem();
  const cpu = sampleCpu();
  const [usedBytes, disk, gpu] = await Promise.all([
    usedMemoryBytes(totalBytes),
    sampleDisk(),
    sampleGpu(),
  ]);
  return {
    ts: Date.now(),
    cpu: { ...cpu, cores: os.cpus().length },
    memory: { totalBytes, usedBytes, processRssBytes: process.memoryUsage.rss() },
    disk,
    gpu,
  };
}
