import { describe, expect, it, vi } from "vitest";
import { Web3Client } from "../src/client";
import { rwa, trading, transaction, defi, wallet, b402 } from "../src";

function capture() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ method: init!.method!, path: u.pathname + u.search, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Web3Client({ apiKey: "k", apiSecret: "s", fetch: f, probe: () => {}, sleep: async () => {} });
  return { c, calls };
}

describe("module request shapes", () => {
  it("rwa.price joins addresses", async () => {
    const { c, calls } = capture();
    await rwa.price(c, "56", ["0xa", "0xb"]);
    expect(calls[0]).toEqual({ method: "GET", path: "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xa%2C0xb" });
  });

  it("rwa.underlyingMarket / tokens / underlyingProfile paths", async () => {
    const { c, calls } = capture();
    await rwa.underlyingMarket(c, "56", "0xa");
    await rwa.tokens(c, { binanceChainId: "56", platformId: "bstock" });
    await rwa.underlyingProfile(c, "56", "0xa");
    expect(calls.map((x) => x.path)).toEqual([
      "/build/api/v1/dex/market/rwa/underlying-market?binanceChainId=56&tokenContractAddress=0xa",
      "/build/api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock",
      "/build/api/v1/dex/market/rwa/underlying-profile?binanceChainId=56&tokenContractAddress=0xa",
    ]);
  });

  it("trading.quote sends required fields", async () => {
    const { c, calls } = capture();
    await trading.quote(c, { binanceChainId: "56", amount: "1000000000000000000", fromTokenAddress: "0xu", toTokenAddress: "0xs", userWalletAddress: "0xw" });
    expect(calls[0]!.path).toBe(
      "/build/api/v1/dex/aggregator/quote?binanceChainId=56&amount=1000000000000000000&fromTokenAddress=0xu&toTokenAddress=0xs&userWalletAddress=0xw",
    );
  });

  it("transaction.simulate and broadcast are POSTs with the documented bodies", async () => {
    const { c, calls } = capture();
    await transaction.simulate(c, { binanceChainId: "56", evmTx: { from: "0x1", to: "0x2", value: "0", data: "0x" } });
    await transaction.broadcast(c, { binanceChainId: "56", signedTransaction: "0xdead", address: "0x1", enableMevProtection: true });
    expect(calls[0]).toEqual({ method: "POST", path: "/build/api/v1/dex/pre-transaction/simulate", body: { binanceChainId: "56", evmTx: { from: "0x1", to: "0x2", value: "0", data: "0x" } } });
    expect(calls[1]!.path).toBe("/build/api/v1/dex/pre-transaction/broadcast-transaction");
    expect(calls[1]!.body).toEqual({ binanceChainId: "56", signedTransaction: "0xdead", address: "0x1", enableMevProtection: true });
  });

  it("defi.positions posts addresses", async () => {
    const { c, calls } = capture();
    await defi.positions(c, ["0xabc"], ["56"]);
    expect(calls[0]).toEqual({ method: "POST", path: "/build/api/v1/defi/data/position/list", body: { addresses: ["0xabc"], binanceChainIds: ["56"] } });
  });

  it("wallet and b402 paths", async () => {
    const { c, calls } = capture();
    await wallet.allTokenBalances(c, { address: "0x1", chains: "56" });
    await b402.supported(c);
    expect(calls[0]!.path).toBe("/build/api/v1/dex/balance/all-token-balances-by-address?address=0x1&chains=56");
    expect(calls[1]).toEqual({ method: "POST", path: "/build/api/v2/b402/supported", body: { body: {} } });
  });
});

describe("trading.order id validation", () => {
  it("rejects path-injection ids without calling fetch", () => {
    const { c, calls } = capture();
    expect(() => trading.order(c, "../x")).toThrow(/invalid orderId/);
    expect(calls).toHaveLength(0);
  });
  it("accepts a normal id", async () => {
    const { c, calls } = capture();
    await trading.order(c, "abc-123_X");
    expect(calls[0]!.path).toBe("/build/api/v1/dex/aggregator/order/abc-123_X");
  });
});
