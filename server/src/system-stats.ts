/**
 * System-resource sampling for the header resource monitor.
 *
 * One cheap snapshot per call: CPU from `os.cpus()` tick deltas between calls,
 * memory with platform-aware "used" (macOS `vm_stat`, Linux `MemAvailable`,
 * else total-free), disk from `statfs` on the projects volume, and GPU from the
 * first vendor tool that answers (`nvidia-smi`, `amd-smi`, `rocm-smi`, or
 * `ioreg` on Apple Silicon). External probes are throttled and fall back to the
 * last good reading, so a 2-3s UI poll stays negligible.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { hasBinary } from "./binaries.ts";
import { PROJECTS_ROOT } from "./config.ts";

const execFileP = promisify(execFile);
const EXEC_OPTS = { timeout: 2000, windowsHide: true } as const;
/** Minimum spacing between external probe runs (vm_stat / ioreg / *-smi). */
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
// GPU: vendor tools are tried in a fixed order -- nvidia-smi, AMD's amd-smi,
// the older rocm-smi, then Apple Silicon's IOAccelerator performance
// statistics (no sudo needed, unlike powermetrics). The first tool that
// answers wins, so a machine with both vendors installed keeps reporting
// NVIDIA exactly as it did before AMD support existed. Anything else reports
// no GPU and the UI hides the segment.
//
// The AMD parsers look keys up by substring rather than exact name and treat
// every field as independently optional. Both tools rename fields between ROCm
// releases ("Card Series" -> "Market Name", bare numbers -> {value, unit}), and
// on Windows several counters come back "N/A" -- a rename or an unsupported
// counter should cost one field, not the whole GPU.

const NVIDIA_SMI_ARGS = [
  "--query-gpu=name,utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];
/** rocm-smi wants each field named, and exits 1 on a flag it doesn't know.
 *  Utilization is requested before memory because ambiguous key matches below
 *  are settled by document order. */
const ROCM_SMI_ARGS = [
  "--showuse",
  "--showmeminfo",
  "vram",
  "--showproductname",
  "--json",
];
/** amd-smi is asked for whole groups instead of named fields: the field flags
 *  have churned across releases where the JSON keys mostly haven't, and one
 *  2s-cached call can afford the extra output. */
const AMD_SMI_METRIC_ARGS = ["metric", "--json"];
const AMD_SMI_STATIC_ARGS = ["static", "--json"];

type GpuFields = Omit<NonNullable<SystemStats["gpu"]>, "name">;

/** First JSON value in a tool's stdout. ROCm builds sometimes print a warning
 *  line ahead of the JSON, so a bare JSON.parse is not enough. */
export function firstJsonValue(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the brace/bracket slice
  }
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Flatten probe JSON to leaf [key, value] pairs in document order. An object
 *  carrying a "value" key is a leaf, not a branch: amd-smi wraps every number
 *  as {value, unit}. */
function leafEntries(node: unknown, out: [string, unknown][] = []): [string, unknown][] {
  if (!node || typeof node !== "object") return out;
  for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
    if (v && typeof v === "object" && !("value" in (v as object))) leafEntries(v, out);
    else out.push([key, v]);
  }
  return out;
}

/** First entry whose key contains all of `include` and none of `exclude`,
 *  case-insensitively. */
function pickEntry(
  entries: [string, unknown][],
  include: string[],
  exclude: string[] = [],
): [string, unknown] | undefined {
  return entries.find(([key]) => {
    const k = key.toLowerCase();
    return include.every((n) => k.includes(n)) && !exclude.some((n) => k.includes(n));
  });
}

/** A metric's numeric part: bare number, decimal string, or {value, unit}.
 *  Anything non-numeric ("N/A" on unsupported counters) reads as absent. */
function metricNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null;
  }
  if (raw && typeof raw === "object" && "value" in (raw as object)) {
    return metricNumber((raw as { value: unknown }).value);
  }
  return null;
}

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/** Bytes from a memory entry. amd-smi states the unit in the value object
 *  ({value: 16368, unit: "MB"}); rocm-smi states it in the key ("VRAM Total
 *  Memory (B)"). With neither, assume bytes -- both tools' historical default. */
function metricBytes(entry: [string, unknown] | undefined): number | null {
  if (!entry) return null;
  const n = metricNumber(entry[1]);
  if (n === null) return null;
  const [key, raw] = entry;
  const stated =
    raw && typeof raw === "object" && typeof (raw as { unit?: unknown }).unit === "string"
      ? (raw as { unit: string }).unit
      : /\(([A-Za-z]+)\)\s*$/.exec(key)?.[1];
  return n * (UNIT_BYTES[(stated ?? "b").toLowerCase()] ?? 1);
}

/** True for a name worth showing in the UI over the generic vendor label. */
function usableName(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && !/^(n\/?a|unknown|null)$/i.test(v.trim());
}

/** Utilization + VRAM out of flattened AMD probe output. Both tools' spellings
 *  are tried in turn: rocm-smi says "GPU use (%)" and "VRAM Total Used Memory
 *  (B)", amd-smi says "gfx_activity" and "used_vram". */
function amdGpuFields(entries: [string, unknown][]): GpuFields {
  return {
    utilizationPct:
      metricNumber(pickEntry(entries, ["gpu", "use"], ["mem", "vram"])?.[1]) ??
      metricNumber(pickEntry(entries, ["gfx", "activity"])?.[1]),
    memUsedBytes: metricBytes(pickEntry(entries, ["vram", "used"], ["visible"])),
    memTotalBytes: metricBytes(
      pickEntry(entries, ["vram", "total"], ["used", "free", "visible"]),
    ),
  };
}

/** Null unless at least one field came back -- a tool that ran but reported
 *  nothing usable must not claim a GPU the UI would then render blank. */
function gpuFieldsOrNull(fields: GpuFields): GpuFields | null {
  return fields.utilizationPct === null && fields.memTotalBytes === null ? null : fields;
}

export function parseNvidiaSmi(stdout: string): SystemStats["gpu"] {
  const first = stdout.trim().split("\n")[0];
  if (!first) return null;
  const [name, util, memUsed, memTotal] = first.split(",").map((s) => s.trim());
  return {
    name: name || "NVIDIA GPU",
    utilizationPct: Number.isFinite(Number(util)) ? Number(util) : null,
    memUsedBytes: Number.isFinite(Number(memUsed)) ? Number(memUsed) * 1024 * 1024 : null,
    memTotalBytes: Number.isFinite(Number(memTotal)) ? Number(memTotal) * 1024 * 1024 : null,
  };
}

/** amd-smi (ROCm >= 6) prints a JSON array, one object per GPU. Report the
 *  first, as the nvidia-smi branch reports the first CSV row. */
export function parseAmdSmiMetric(stdout: string): GpuFields | null {
  const root = firstJsonValue(stdout);
  const first = Array.isArray(root) ? root[0] : root;
  if (!first || typeof first !== "object") return null;
  return gpuFieldsOrNull(amdGpuFields(leafEntries(first)));
}

export function parseAmdSmiName(stdout: string): string | null {
  const root = firstJsonValue(stdout);
  const first = Array.isArray(root) ? root[0] : root;
  if (!first || typeof first !== "object") return null;
  const entries = leafEntries(first);
  for (const include of [["market", "name"], ["product", "name"], ["asic", "name"]]) {
    const v = pickEntry(entries, include)?.[1];
    if (usableName(v)) return v.trim();
  }
  return null;
}

/** rocm-smi --json prints one object per card, keyed "card0", "card1", ... */
export function parseRocmSmi(stdout: string): SystemStats["gpu"] {
  const root = firstJsonValue(stdout);
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const card = Object.entries(root as Record<string, unknown>)
    .filter(([key, v]) => /^card\d+$/i.test(key) && !!v && typeof v === "object")
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))[0]?.[1];
  if (!card) return null;
  const entries = leafEntries(card);
  const fields = gpuFieldsOrNull(amdGpuFields(entries));
  if (!fields) return null;
  // "Card Model" is deliberately not a candidate: it is a PCI device id
  // ("0x744c"), which reads worse in the UI than the generic label.
  const name = [["market", "name"], ["device", "name"], ["card", "series"]]
    .map((include) => pickEntry(entries, include)?.[1])
    .find(usableName);
  return { name: name?.trim() ?? "AMD GPU", ...fields };
}

let gpuCache: { at: number; value: SystemStats["gpu"] } | null = null;

async function probeAmdSmi(): Promise<SystemStats["gpu"]> {
  const { stdout } = await execFileP("amd-smi", AMD_SMI_METRIC_ARGS, EXEC_OPTS);
  const fields = parseAmdSmiMetric(stdout);
  if (!fields) return null;
  // The model name sits behind a second subcommand. Losing it costs the label
  // only, so it must never fail the probe.
  let name: string | null = null;
  try {
    const asic = await execFileP("amd-smi", AMD_SMI_STATIC_ARGS, EXEC_OPTS);
    name = parseAmdSmiName(asic.stdout);
  } catch {
    // keep the generic label
  }
  return { name: name ?? "AMD GPU", ...fields };
}

async function probeAppleGpu(): Promise<SystemStats["gpu"]> {
  const { stdout } = await execFileP("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], EXEC_OPTS);
  const util = /"Device Utilization %"=(\d+)/.exec(stdout)?.[1];
  if (util === undefined) return null;
  return {
    name: "Apple GPU",
    utilizationPct: Number(util),
    // Unified memory -- no separate VRAM pool to report.
    memUsedBytes: null,
    memTotalBytes: null,
  };
}

async function sampleGpu(): Promise<SystemStats["gpu"]> {
  const now = Date.now();
  if (gpuCache && now - gpuCache.at < PROBE_INTERVAL_MS) return gpuCache.value;

  let value: SystemStats["gpu"] = null;
  try {
    if (hasBinary("nvidia-smi")) {
      const { stdout } = await execFileP("nvidia-smi", NVIDIA_SMI_ARGS, EXEC_OPTS);
      value = parseNvidiaSmi(stdout);
    } else if (hasBinary("amd-smi")) {
      value = await probeAmdSmi();
    } else if (hasBinary("rocm-smi")) {
      const { stdout } = await execFileP("rocm-smi", ROCM_SMI_ARGS, EXEC_OPTS);
      value = parseRocmSmi(stdout);
    } else if (process.platform === "darwin") {
      value = await probeAppleGpu();
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
