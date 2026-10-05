import { describe, expect, it, vi } from "vitest";
import { Web3Client, Web3ApiError, isGeoBlocked } from "../src/client";
import { signWeb3 } from "../src/sign";

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function client(fetchImpl: typeof fetch, probe = vi.fn()) {
  return {
    probe,
    c: new Web3Client({
      apiKey: "key",
      apiSecret: "secret",
      fetch: fetchImpl,
      probe,
      now: () => new Date("2026-05-11T10:08:57.715Z"),
      sleep: async () => {},
    }),
  };
}

describe("Web3Client", () => {
  it("signs exactly the path+query it sends and unwraps data", async () => {
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = init!.headers as Record<string, string>;
      expect(u.pathname + u.search).toBe("/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xabc");
      expect(h["X-OC-SIGN"]).toBe(signWeb3("secret", "2026-05-11T10:08:57.715Z", "GET", u.pathname + u.search, ""));
      return res(200, { code: 0, msg: "success", data: [{ tokenPrice: "1" }] });
    }) as unknown as typeof fetch;
    const { c, probe } = client(f);
    const data = await c.get<{ tokenPrice: string }[]>("/api/v1/dex/market/rwa/price", {
      binanceChainId: "56",
      tokenContractAddresses: "0xabc",
      ignored: undefined,
    });
    expect(data[0]!.tokenPrice).toBe("1");
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/api/v1/dex/market/rwa/price", ok: true, status: 200 }));
  });

  it("posts the exact JSON it signs", async () => {
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const h = init!.headers as Record<string, string>;
      expect(h["X-OC-SIGN"]).toBe(signWeb3("secret", "2026-05-11T10:08:57.715Z", "POST", u.pathname, String(init!.body)));
      expect(h["Content-Type"]).toBe("application/json");
      return res(200, { code: "0", data: { status: "SUCCESS" } });
    }) as unknown as typeof fetch;
    const { c } = client(f);
    expect(await c.post("/api/v1/dex/pre-transaction/simulate", { binanceChainId: "56" })).toEqual({ status: "SUCCESS" });
  });

  it("retries 429 using Retry-After, then succeeds", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? res(429, { code: 42900, msg: "rate" }, { "retry-after": "1" }) : res(200, { code: 0, data: 7 })));
    const { c, probe } = client(f as unknown as typeof fetch);
    expect(await c.get<number>("/api/v1/x")).toBe(7);
    expect(f).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ status: 429, ok: false, attempt: 1 }));
  });

  it("never retries a geo-block and surfaces it typed", async () => {
    const f = vi.fn(async () => res(200, { code: 40304, msg: "compliance restriction", data: null }));
    const { c } = client(f as unknown as typeof fetch);
    const err = await c.get("/api/v1/dex/aggregator/quote").catch((e) => e);
    expect(err).toBeInstanceOf(Web3ApiError);
    expect(isGeoBlocked(err)).toBe(true);
    expect((err as Web3ApiError).endpoint).toBe("/api/v1/dex/aggregator/quote");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maps a business error with the server message", async () => {
    const f = vi.fn(async () => res(200, { code: 40367, msg: "ONDO_MARKET_STATE_NOT_TRADABLE" }));
    const { c } = client(f as unknown as typeof fetch);
    const err = (await c.get("/api/v1/dex/aggregator/quote").catch((e) => e)) as Web3ApiError;
    expect(err.code).toBe("40367");
    expect(err.serverMessage).toBe("ONDO_MARKET_STATE_NOT_TRADABLE");
    expect(err.retryable).toBe(false);
  });

  it("refuses keyed calls without credentials", async () => {
    const c = new Web3Client({ fetch: vi.fn() as unknown as typeof fetch });
    await expect(c.get("/api/v1/x")).rejects.toThrow(/BINANCE_WEB3_API_KEY/);
  });
});

describe("retry policy for state-changing requests", () => {
  const boom = () => Promise.reject(new TypeError("fetch failed"));

  it("POST + network error throws after one call", async () => {
    const f = vi.fn(boom);
    const { c } = client(f as unknown as typeof fetch);
    const err = (await c.post("/api/v1/x", {}).catch((e) => e)) as Web3ApiError;
    expect(err).toBeInstanceOf(Web3ApiError);
    expect(err.code).toBe("NETWORK");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("POST + 503 makes one call and surfaces a retryable typed error", async () => {
    const f = vi.fn(async () => res(503, { code: 50300, msg: "unavailable" }));
    const { c } = client(f as unknown as typeof fetch);
    const err = (await c.post("/api/v1/x", {}).catch((e) => e)) as Web3ApiError;
    expect(err).toBeInstanceOf(Web3ApiError);
    expect(err.retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("idempotent POST retries network errors", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? boom() : res(200, { code: 0, data: "ok" })));
    const { c } = client(f as unknown as typeof fetch);
    expect(await c.post("/api/v1/x", {}, { idempotent: true })).toBe("ok");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("POST retries 429, GET retries network errors", async () => {
    let n = 0;
    const f429 = vi.fn(async () => (++n === 1 ? res(429, { code: 42900, msg: "rate" }) : res(200, { code: 0, data: 1 })));
    expect(await client(f429 as unknown as typeof fetch).c.post<number>("/api/v1/x", {})).toBe(1);
    expect(f429).toHaveBeenCalledTimes(2);
    let m = 0;
    const fNet = vi.fn(async () => (++m === 1 ? boom() : res(200, { code: 0, data: 2 })));
    expect(await client(fNet as unknown as typeof fetch).c.get<number>("/api/v1/x")).toBe(2);
    expect(fNet).toHaveBeenCalledTimes(2);
  });
});

describe("hardening", () => {
  const html = (status: number, headers: Record<string, string> = {}) => new Response("<html>blocked</html>", { status, headers });
  const timeout = () => Promise.reject(new DOMException("timed out", "TimeoutError"));

  it("business error is not retried (one fetch)", async () => {
    const f = vi.fn(async () => res(200, { code: 40367, msg: "ONDO_MARKET_STATE_NOT_TRADABLE" }));
    const { c } = client(f as unknown as typeof fetch);
    await expect(c.get("/api/v1/x")).rejects.toBeInstanceOf(Web3ApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("GET 403 HTML gives a typed error with the real status and no retry", async () => {
    const f = vi.fn(async () => html(403));
    const { c, probe } = client(f as unknown as typeof fetch);
    const err = (await c.get("/api/v1/x").catch((e) => e)) as Web3ApiError;
    expect(err).toBeInstanceOf(Web3ApiError);
    expect(err.httpStatus).toBe(403);
    expect(err.code).toBe("403");
    expect(err.serverMessage).toContain("blocked");
    expect(f).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ status: 403, ok: false }));
  });

  it("GET 503 HTML is retried", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? html(503) : res(200, { code: 0, data: 5 })));
    const { c } = client(f as unknown as typeof fetch);
    expect(await c.get<number>("/api/v1/x")).toBe(5);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("POST timeout is an unknown-outcome error after one call", async () => {
    const f = vi.fn(timeout);
    const { c } = client(f as unknown as typeof fetch);
    const err = (await c.post("/api/v1/x", {}).catch((e) => e)) as Web3ApiError;
    expect(err.code).toBe("TIMEOUT_OUTCOME_UNKNOWN");
    expect(err.retryable).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("GET timeout is retried", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? timeout() : res(200, { code: 0, data: 9 })));
    const { c } = client(f as unknown as typeof fetch);
    expect(await c.get<number>("/api/v1/x")).toBe(9);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("caps Retry-After at 30s", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? res(429, { code: 42900 }, { "retry-after": "3600" }) : res(200, { code: 0, data: 1 })));
    const sleep = vi.fn(async () => {});
    const c = new Web3Client({ apiKey: "k", apiSecret: "s", fetch: f as unknown as typeof fetch, probe: () => {}, sleep });
    await c.get("/api/v1/x");
    expect(sleep).toHaveBeenCalledWith(30000);
  });

  it("does not leak the secret through serialization", () => {
    const c = new Web3Client({ apiKey: "k", apiSecret: "super-secret-value" });
    expect(JSON.stringify(c)).not.toContain("super-secret-value");
    expect(Object.values(c as unknown as Record<string, unknown>).map(String).join()).not.toContain("super-secret-value");
  });
});
