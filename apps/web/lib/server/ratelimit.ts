/* A per-client budget on every API route (chain reads, the desk proxy, simulation). Counts live in memory,
   so on serverless hosts each instance keeps its own: a brake, not a guarantee. The caches, the read gate and
   the page caps bound what gets through. */

export interface RateLimiter {
  /** null when the request may go ahead, else a 429 answer */
  check(req: Request): Response | null;
  /** clients currently remembered */
  readonly size: number;
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** clients remembered at once; beyond it the oldest are forgotten (they start a fresh minute) */
const MAX_CLIENTS = 5000;

export function rateLimiter(perMinute: number, clock: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { start: number; n: number }>();
  return {
    get size() {
      return hits.size;
    },
    check(req) {
      const now = clock();
      const key = clientKey(req);
      const h = hits.get(key);
      if (!h || now - h.start >= 60_000) {
        hits.delete(key);
        if (hits.size >= MAX_CLIENTS) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
        while (hits.size >= MAX_CLIENTS) hits.delete(hits.keys().next().value as string);
        hits.set(key, { start: now, n: 1 });
        return null;
      }
      h.n++;
      if (h.n <= perMinute) return null;
      const retry = Math.max(1, Math.ceil((h.start + 60_000 - now) / 1000));
      return Response.json({ error: "too many requests, try again shortly" }, { status: 429, headers: { "retry-after": String(retry), "cache-control": "no-store" } });
    },
  };
}
