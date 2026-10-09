/* Small per-instance caches for route handlers. One request in flight per key (single flight), so any number
   of visitors asking for the same thing at once cost one round of reads. A failure is remembered briefly too,
   so an outage is not multiplied by every caller retrying it. */

export interface TtlCacheOptions {
  /** how long a failure is replayed to callers (default: not at all) */
  errorTtlMs?: number;
  /** failures that say nothing about the source (e.g. "this instance is busy") are not replayed */
  replayError?: (err: unknown) => boolean;
  /** most entries kept; the oldest is dropped first (default 500) */
  max?: number;
  clock?: () => number;
}

export function ttlCache<T>(ttlMs: number, opts: TtlCacheOptions = {}) {
  const clock = opts.clock ?? (() => Date.now());
  const max = opts.max ?? 500;
  const errorTtlMs = opts.errorTtlMs ?? 0;
  const values = new Map<string, { at: number; v: T } | { at: number; err: unknown }>();
  const inflight = new Map<string, Promise<T>>();
  const put = (key: string, entry: { at: number; v: T } | { at: number; err: unknown }) => {
    values.delete(key);
    values.set(key, entry);
    while (values.size > max) values.delete(values.keys().next().value as string);
  };
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = values.get(key);
      if (hit) {
        const age = clock() - hit.at;
        if ("v" in hit && age < ttlMs) return Promise.resolve(hit.v);
        if ("err" in hit && age < errorTtlMs) return Promise.reject(hit.err);
      }
      const running = inflight.get(key);
      if (running) return running;
      const p = load()
        .then(
          (v) => {
            put(key, { at: clock(), v });
            return v;
          },
          (err) => {
            if (errorTtlMs > 0 && (opts.replayError?.(err) ?? true)) put(key, { at: clock(), err });
            else values.delete(key);
            throw err;
          },
        )
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    get size() {
      return values.size;
    },
    clear() {
      values.clear();
    },
  };
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
