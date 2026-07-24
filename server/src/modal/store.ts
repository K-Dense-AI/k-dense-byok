import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import {
  isTerminalModalState,
  ModalJobError,
  type ModalJob,
  type ModalJobEvent,
  type ModalJobState,
} from "./types.ts";

export const MAX_MODAL_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_LOG_READ_BYTES = 1024 * 1024;
const JOB_ID_RE = /^[a-z0-9][a-z0-9_-]{5,80}$/;

export interface ModalJobFiles {
  dir: string;
  job: string;
  events: string;
  stdout: string;
  stderr: string;
  staging: string;
}

export const MAX_EVENT_ROWS = 2_000;
export const EVENT_TRIM_INTERVAL = 200;

function assertJobId(jobId: string): void {
  if (!JOB_ID_RE.test(jobId)) {
    throw new ModalJobError("INVALID_JOB_ID", `Invalid Modal job id "${jobId}"`, 400);
  }
}

export function modalJobFiles(projectId: string, jobId: string): ModalJobFiles {
  assertJobId(jobId);
  const dir = path.join(resolvePaths(projectId).modalJobsDir, jobId);
  return {
    dir,
    job: path.join(dir, "job.json"),
    events: path.join(dir, "events.jsonl"),
    stdout: path.join(dir, "stdout.log"),
    stderr: path.join(dir, "stderr.log"),
    staging: path.join(dir, "staging"),
  };
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export class ModalJobStore {
  create(job: ModalJob): ModalJob {
    const files = modalJobFiles(job.projectId, job.id);
    if (fs.existsSync(files.job)) {
      throw new ModalJobError("JOB_EXISTS", `Modal job already exists: ${job.id}`, 409);
    }
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.events, "", { mode: 0o600 });
    fs.writeFileSync(files.stdout, "", { mode: 0o600 });
    fs.writeFileSync(files.stderr, "", { mode: 0o600 });
    atomicJson(files.job, job);
    this.appendEvent(job.projectId, job.id, {
      type: "created",
      state: "queued",
      message: "Job queued",
    });
    return this.read(job.projectId, job.id)!;
  }

  read(projectId: string, jobId: string): ModalJob | null {
    const files = modalJobFiles(projectId, jobId);
    try {
      const value = JSON.parse(fs.readFileSync(files.job, "utf-8")) as ModalJob;
      if (!value || value.id !== jobId || value.projectId !== projectId) return null;
      return value;
    } catch {
      return null;
    }
  }

  require(projectId: string, jobId: string): ModalJob {
    const job = this.read(projectId, jobId);
    if (!job) throw new ModalJobError("JOB_NOT_FOUND", `No such Modal job: ${jobId}`, 404);
    return job;
  }

  write(job: ModalJob): ModalJob {
    job.updatedAt = Date.now();
    atomicJson(modalJobFiles(job.projectId, job.id).job, job);
    return job;
  }

  update(
    projectId: string,
    jobId: string,
    mutate: (job: ModalJob) => void,
  ): ModalJob {
    const job = this.require(projectId, jobId);
    mutate(job);
    return this.write(job);
  }

  transition(
    projectId: string,
    jobId: string,
    state: ModalJobState,
    extra?: (job: ModalJob) => void,
  ): ModalJob {
    const job = this.update(projectId, jobId, (current) => {
      if (isTerminalModalState(current.state) && current.state !== state) {
        throw new ModalJobError(
          "JOB_TERMINAL",
          `Cannot transition terminal job ${jobId} from ${current.state} to ${state}`,
          409,
        );
      }
      current.state = state;
      const now = Date.now();
      if (state === "preparing") current.preparingAt ??= now;
      if (state === "running") current.runningAt ??= now;
      if (state === "collecting") current.collectingAt ??= now;
      if (isTerminalModalState(state)) current.finishedAt ??= now;
      extra?.(current);
    });
    this.appendEvent(projectId, jobId, {
      type: "state",
      state,
      message: `Job ${state}`,
    });
    return job;
  }

  appendEvent(
    projectId: string,
    jobId: string,
    event: Omit<ModalJobEvent, "seq" | "ts">,
  ): ModalJobEvent {
    const job = this.require(projectId, jobId);
    const full: ModalJobEvent = {
      ...event,
      seq: job.eventSeq + 1,
      ts: Date.now(),
    };
    fs.appendFileSync(
      modalJobFiles(projectId, jobId).events,
      JSON.stringify(full) + "\n",
      "utf-8",
    );
    job.eventSeq = full.seq;
    this.write(job);
    // Checked periodically rather than every append: events are low-frequency,
    // but a long-lived job that retries or falls back repeatedly would grow
    // this file without bound.
    if (full.seq % EVENT_TRIM_INTERVAL === 0) this.trimEvents(projectId, jobId);
    return full;
  }

  /** Drop the oldest rows once the log grows past MAX_EVENT_ROWS. */
  private trimEvents(projectId: string, jobId: string): void {
    const file = modalJobFiles(projectId, jobId).events;
    try {
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
      if (lines.length <= MAX_EVENT_ROWS) return;
      const kept = lines.slice(-MAX_EVENT_ROWS).join("\n") + "\n";
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, kept, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // Trimming is housekeeping; never fail the job over it.
    }
  }

  events(projectId: string, jobId: string, after = 0): ModalJobEvent[] {
    const file = modalJobFiles(projectId, jobId).events;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return [];
    }
    const out: ModalJobEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        // A single torn row must not hide the whole job's history.
        const event = JSON.parse(line) as ModalJobEvent;
        if (event.seq > after) out.push(event);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  list(projectId: string): ModalJob[] {
    const root = resolvePaths(projectId).modalJobsDir;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        try {
          return this.read(projectId, name);
        } catch {
          return null;
        }
      })
      .filter((job): job is ModalJob => job !== null)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  appendLog(
    projectId: string,
    jobId: string,
    stream: "stdout" | "stderr",
    chunk: string | Uint8Array,
  ): void {
    const files = modalJobFiles(projectId, jobId);
    const file = stream === "stdout" ? files.stdout : files.stderr;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    if (bytes.length === 0) return;
    fs.appendFileSync(file, bytes);
    const job = this.require(projectId, jobId);
    const bytesKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
    const baseKey = stream === "stdout" ? "stdoutBaseCursor" : "stderrBaseCursor";
    job[bytesKey] += bytes.length;
    let size = fs.statSync(file).size;
    if (size > MAX_MODAL_LOG_BYTES) {
      const keep = fs.readFileSync(file).subarray(size - MAX_MODAL_LOG_BYTES);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep, { mode: 0o600 });
      fs.renameSync(tmp, file);
      const removed = size - keep.length;
      job[baseKey] += removed;
      size = keep.length;
    }
    // The retained file size and logical byte count intentionally differ after
    // truncation; cursor APIs use the monotonic logical count.
    void size;
    this.write(job);
  }

  replaceLog(
    projectId: string,
    jobId: string,
    stream: "stdout" | "stderr",
    content: string,
  ): void {
    const job = this.require(projectId, jobId);
    const currentBytes = stream === "stdout" ? job.stdoutBytes : job.stderrBytes;
    if (Buffer.byteLength(content) <= currentBytes) return;
    this.appendLog(projectId, jobId, stream, Buffer.from(content).subarray(currentBytes));
  }

  readLog(
    projectId: string,
    jobId: string,
    stream: "stdout" | "stderr",
    cursor = 0,
    limit = 64 * 1024,
  ): { data: string; cursor: number; nextCursor: number; baseCursor: number; reset: boolean; eof: boolean } {
    const job = this.require(projectId, jobId);
    const files = modalJobFiles(projectId, jobId);
    const file = stream === "stdout" ? files.stdout : files.stderr;
    const baseCursor = stream === "stdout" ? job.stdoutBaseCursor : job.stderrBaseCursor;
    const endCursor = stream === "stdout" ? job.stdoutBytes : job.stderrBytes;
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_LOG_READ_BYTES);
    const start = Math.max(Math.floor(cursor), baseCursor);
    const reset = cursor < baseCursor;
    const offset = start - baseCursor;
    let data = Buffer.alloc(0);
    try {
      const fd = fs.openSync(file, "r");
      try {
        const available = Math.max(0, Math.min(safeLimit, endCursor - start));
        data = Buffer.alloc(available);
        fs.readSync(fd, data, 0, available, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      data = Buffer.alloc(0);
    }
    const nextCursor = start + data.length;
    return {
      data: data.toString("utf-8"),
      cursor: start,
      nextCursor,
      baseCursor,
      reset,
      eof: nextCursor >= endCursor && isTerminalModalState(job.state),
    };
  }
}
