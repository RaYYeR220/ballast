/* A small per-client budget for the routes that spend a keyed quota (Binance simulate, DeFi positions).
   Counts live in memory, so on serverless hosts each instance keeps its own: a brake, not a guarantee. */

export interface RateLimiter {
  /** null when the request may go ahead, else a 429 answer */
  check(req: Request): Response | null;
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function rateLimiter(perMinute: number, clock: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { start: number; n: number }>();
  return {
    check(req) {
      const now = clock();
      const key = clientKey(req);
      const h = hits.get(key);
      if (!h || now - h.start >= 60_000) {
        if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
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
