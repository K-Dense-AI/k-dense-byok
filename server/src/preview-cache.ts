/** Bounded, success-only LRU and shared work queue for disposable previews. */
export class PreviewCache<T> {
  private cache = new Map<string, { value: T; bytes: number; expires: number }>();
  private bytes = 0;
  private active = 0;
  private jobs = new Map<string, {
    controller: AbortController;
    consumers: Set<{ resolve: (value: T) => void; reject: (error: unknown) => void }>;
    load: (signal: AbortSignal) => Promise<T>;
    started: boolean;
  }>();

  constructor(private options: {
    concurrency: number;
    maxBytes: number;
    maxEntries: number;
    ttlMs: number;
    size: (value: T) => number;
    cacheable: (value: T) => boolean;
  }) {}

  get(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted());
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      if (hit.expires > Date.now()) {
        this.cache.set(key, hit);
        return Promise.resolve(hit.value);
      }
      this.bytes -= hit.bytes;
    }
    let job = this.jobs.get(key);
    if (!job) {
      job = { controller: new AbortController(), consumers: new Set(), load, started: false };
      this.jobs.set(key, job);
    }
    const current = job;
    const promise = new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const consumer = {
        resolve: (value: T) => { cleanup(); resolve(value); },
        reject: (error: unknown) => { cleanup(); reject(error); },
      };
      const onAbort = () => {
        current.consumers.delete(consumer);
        consumer.reject(aborted());
        if (current.consumers.size === 0) {
          // A later caller must get a fresh job, not join a dying process.
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          current.controller.abort();
          this.drain();
        }
      };
      current.consumers.add(consumer);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.drain();
    return promise;
  }

  private drain() {
    for (const [key, job] of this.jobs) {
      if (this.active >= this.options.concurrency) break;
      if (job.started || job.controller.signal.aborted) continue;
      job.started = true;
      this.active++;
      void Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw aborted();
        return job.load(job.controller.signal);
      }).then((value) => {
        if (!job.controller.signal.aborted && this.options.cacheable(value)) {
          const bytes = this.options.size(value);
          if (bytes <= this.options.maxBytes) {
            this.cache.set(key, { value, bytes, expires: Date.now() + this.options.ttlMs });
            this.bytes += bytes;
            while (this.bytes > this.options.maxBytes || this.cache.size > this.options.maxEntries) {
              const oldest = this.cache.keys().next().value!;
              this.bytes -= this.cache.get(oldest)!.bytes;
              this.cache.delete(oldest);
            }
          }
        }
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        for (const consumer of job.consumers) consumer.resolve(value);
      }, (error) => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        for (const consumer of job.consumers) consumer.reject(error);
      }).finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        this.active--;
        this.drain();
      });
    }
  }
}

function aborted() { return new DOMException("Preview request cancelled", "AbortError"); }
