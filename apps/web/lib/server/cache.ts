/* Small per-instance caches for route handlers. One request in flight per key; failures are not cached. */

export function ttlCache<T>(ttlMs: number, clock: () => number = Date.now) {
  const values = new Map<string, { at: number; v: T }>();
  const inflight = new Map<string, Promise<T>>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = values.get(key);
      if (hit && clock() - hit.at < ttlMs) return Promise.resolve(hit.v);
      const running = inflight.get(key);
      if (running) return running;
      const p = load()
        .then((v) => {
          values.set(key, { at: clock(), v });
          if (values.size > 500) values.delete(values.keys().next().value as string);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
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
