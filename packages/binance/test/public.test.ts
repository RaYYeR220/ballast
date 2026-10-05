import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PublicRwaClient } from "../src/public";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

function fetchFor(map: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const hit = Object.entries(map).find(([k]) => u.includes(k));
    if (!hit) throw new Error(`unexpected ${u}`);
    return new Response(hit[1], { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("PublicRwaClient", () => {
  it("reads the global market status including the undocumented offhours block", async () => {
    const c = new PublicRwaClient({ fetch: fetchFor({ "rwa/market/status/ai": fx("rwa-market-status") }), probe: () => {} });
    const s = await c.marketStatus();
    expect(typeof s.openState).toBe("boolean");
    expect(s.offhours?.nextOpenTime).toBeGreaterThan(1_700_000_000_000);
  });

  it("reads per-asset status and dynamic data for bStocks and Ondo", async () => {
    const c = new PublicRwaClient({
      fetch: fetchFor({
        "asset/market/status/ai": fx("rwa-assetstatus-NVDA-bstocks"),
        "0xa9ee28c80f960b889dfbd1902055218cba016f75": fx("rwa-dynamic-NVDA-ondo"),
        "0x02fca66c1d1afb4e2a7884261eb00f63598a7436": fx("rwa-dynamic-NVDA-bstocks"),
      }),
      probe: () => {},
    });
    const st = await c.assetStatus("56", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
    expect(st.reasonCode).toBe("TRADING");
    const ondo = await c.dynamic("56", "0xa9ee28c80f960b889dfbd1902055218cba016f75");
    expect(Number(ondo.tokenInfo.price)).toBeGreaterThan(100);
    expect(Number(ondo.tokenInfo.sharesMultiplier)).toBeGreaterThan(1);
    const b = await c.dynamic("56", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
    expect(b.stockInfo?.price ?? null).toBeNull(); // bStocks carry no underlying price here
  });

  it("parses klines into numbers", async () => {
    const c = new PublicRwaClient({ fetch: fetchFor({ "kline/ai": fx("kline-1h-NVDA-bstocks") }), probe: () => {} });
    const k = await c.klines("56", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "1h", 72);
    expect(k.length).toBeGreaterThan(10);
    expect(k[0]!.closeTime).toBeGreaterThan(k[0]!.openTime);
    expect(k[0]!.close).toBeGreaterThan(0);
  });

  it("throws a typed error on a non-success envelope", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "000002", message: "illegal parameter", success: false }))) as unknown as typeof fetch;
    const c = new PublicRwaClient({ fetch: f, probe: () => {} });
    await expect(c.marketStatus()).rejects.toThrow(/000002/);
  });
});
