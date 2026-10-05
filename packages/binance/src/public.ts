import { Web3ApiError, isSuccessCode } from "./errors";
import { createProbe, type ProbeRecord } from "./probe";

const BASE = "https://www.binance.com/bapi/defi";
const W = "/public/wallet-direct/buw/wallet";

export interface RwaStockRow { chainId: string; contractAddress: string; symbol: string; ticker: string; type: number; assetType?: number; multiplier?: string; d?: number; cs?: string }
export interface AssetStatus { openState: boolean; marketStatus: string | null; reasonCode: string | null; reasonMsg: string | null; nextOpenTime?: number | null; nextCloseTime?: number | null }
export interface MarketStatus extends AssetStatus { offhours?: { openState: boolean; nextOpenTime: number; nextCloseTime: number } }
export interface RwaDynamic {
  symbol: string;
  ticker: string;
  type: number;
  tokenInfo: { price: string; sharesMultiplier?: string; [k: string]: unknown };
  stockInfo: { price: string | null; [k: string]: unknown } | null;
  statusInfo: AssetStatus | null;
  limitInfo: unknown;
}
export interface Kline { openTime: number; open: number; high: number; low: number; close: number; volume: number | null; closeTime: number }

export class PublicRwaClient {
  private readonly f: typeof fetch;
  private readonly probe: (r: ProbeRecord) => void;
  private readonly ua: string;

  constructor(o: { fetch?: typeof fetch; probe?: (r: ProbeRecord) => void; userAgent?: string } = {}) {
    this.f = o.fetch ?? fetch;
    this.probe = o.probe ?? createProbe();
    this.ua = o.userAgent ?? "ballast/0.1";
  }

  stockList(type?: number) {
    return this.call<RwaStockRow[]>("v1", "/market/token/rwa/stock/detail/list/ai", { type });
  }
  meta(chainId: string, contractAddress: string) {
    return this.call<unknown>("v1", "/market/token/rwa/meta/ai", { chainId, contractAddress });
  }
  marketStatus() {
    return this.call<MarketStatus>("v1", "/market/token/rwa/market/status/ai", {});
  }
  assetStatus(chainId: string, contractAddress: string) {
    return this.call<AssetStatus>("v1", "/market/token/rwa/asset/market/status/ai", { chainId, contractAddress });
  }
  dynamic(chainId: string, contractAddress: string) {
    return this.call<RwaDynamic>("v2", "/market/token/rwa/dynamic/ai", { chainId, contractAddress });
  }
  async klines(chainId: string, contractAddress: string, interval: "1m" | "5m" | "15m" | "1h" | "4h" | "12h" | "1d", limit = 300): Promise<Kline[]> {
    const data = await this.call<{ klineInfos: (string | number)[][]; decimals?: number }>("v1", "/dex/market/token/kline/ai", { chainId, contractAddress, interval, limit });
    const rows = data.klineInfos ?? [];
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: r[5] === undefined || r[5] === "reserved" ? null : Number(r[5]),
      closeTime: Number(r[6]),
    }));
  }

  private async call<T>(version: "v1" | "v2", path: string, q: Record<string, string | number | undefined>): Promise<T> {
    const search = Object.entries(q)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const endpoint = `/${version}${W}${path}`;
    const started = performance.now();
    const res = await this.f(`${BASE}${endpoint}${search ? `?${search}` : ""}`, {
      headers: { "Accept-Encoding": "identity", "User-Agent": this.ua, Accept: "application/json" },
    });
    const text = await res.text();
    const env = (text ? JSON.parse(text) : {}) as { code?: string; message?: string; msg?: string; data?: T };
    const ok = res.status < 400 && isSuccessCode(env.code);
    this.probe({
      ts: new Date().toISOString(),
      surface: "public",
      method: "GET",
      endpoint,
      status: res.status,
      code: String(env.code ?? ""),
      ok,
      latencyMs: Math.round(performance.now() - started),
      attempt: 1,
    });
    if (!ok) throw new Web3ApiError(endpoint, res.status, String(env.code ?? res.status), env.message ?? env.msg ?? text.slice(0, 200), res.status >= 500);
    return env.data as T;
  }
}
