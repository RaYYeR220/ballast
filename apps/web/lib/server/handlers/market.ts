/* GET /api/market/prices and GET /api/market/candles?symbol=: the Binance-backed half of the Session Oracle
   explorer. Both work before Ballast is deployed, because they read only what the Session Oracle itself reads:
   - prices: the keyed Binance Web3 RWA price of every listed token (bStocks, Ondo, xStocks) in one call, each
     brought to a per-share price with the issuer's own on-chain multiplier, next to the Chainlink reference;
   - candles: the bStock's hourly candles from the keyed Market API over the latest closures, judged against the
     band SessionAwareFeed.band() would enforce, anchored on the Chainlink feed's own round history.
   Every answer is sized by the configured ticker list and fixed limits, cached with one read in flight, and says
   which source produced it. Keys stay on the server. */
import { market as marketApi, PublicRwaClient, rwa, Web3Client, type Kline } from "@ballast/binance";
import { bscConfig, tickers, type TickerConfig } from "@ballast/risk";
import { sessionOracleAbi, symbolToBytes32, type Deployment, type ReadClient } from "@ballast/sdk";
import { formatUnits, getAddress, parseAbi, type Address } from "viem";
import { recentClosures, type Closure } from "@/lib/closures";
import {
  closureChart,
  perShare,
  STALE_AFTER_SEC,
  type Candle,
  type CandlesBody,
  type ChainReference,
  type MultiplierSource,
  type PricesBody,
  type RefPrint,
  type SymbolPrices,
  type Venue,
  type VenuePrice,
} from "@/lib/market-view";
import { ttlCache } from "../cache";
import type { DeploymentStatus } from "../deployment";
import type { ServerEnv } from "../env";
import { BusyError, readGate, withDeadline } from "../guard";
import { LIMITS } from "../limits";
import { badRequest, query, symbolParam } from "../params";
import { head } from "../reads";
import { shortMessage } from "../simulate";

type RwaPrice = rwa.RwaPrice;

const BSC = "56";
const ZERO = "0x0000000000000000000000000000000000000000";
const NO_STORE = { "cache-control": "no-store" };

export const MARKET_LIMITS = {
  /** hourly candles asked for: ten days, enough to reach the last weekend from any moment of the week */
  candles: 240,
  /** Chainlink rounds read back from the latest one */
  rounds: 96,
  /** SessionOracle maxRefAge set by the deployment script, used until the contract can be read */
  maxRefAgeSec: 93_600,
} as const;

const issuerAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function getSValue(address token) view returns (uint128 sValue, bool paused)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const ONDO_SHARES: Address = getAddress(bscConfig.ondo.sharesOracle);
const isSet = (a: string) => a.toLowerCase() !== ZERO;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const e18 = (x: bigint) => Number(formatUnits(x, 18));
const e8 = (x: bigint) => Number(formatUnits(x, 8));

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** One Multicall3 round at a block; a call that fails answers null. */
async function multi(c: ReadClient, calls: readonly Call[], blockNumber: bigint): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const res = (await c.multicall({ contracts: calls as never, allowFailure: true, blockNumber, batchSize: 4096 } as never)) as { status: string; result?: unknown; error?: unknown }[];
  // every call failing is the RPC failing, not twelve contracts reverting at once: say so instead of answering "nothing"
  if (res.length > 0 && res.every((r) => r.status !== "success")) throw new Error(`chain read failed: ${shortMessage(res[0]!.error)}`);
  return res.map((r) => (r.status === "success" ? r.result : null));
}

// ------------------------------------------------------------------- prices

export interface PriceDeps {
  /** keyed Binance RWA price for a list of token addresses on BNB Chain */
  rwaPrice(addresses: string[]): Promise<RwaPrice[]>;
  chain: ReadClient;
  deployment: Deployment | null;
  now?: () => number;
}

interface ChainSide {
  blockNumber: bigint;
  at: number;
  /** shares per token by lower-case token address */
  multipliers: Map<string, { value: number; source: MultiplierSource }>;
  references: Map<string, ChainReference>;
}

export async function readChainSide(c: ReadClient, d: Deployment | null): Promise<ChainSide> {
  const h = await head(c);
  const calls: Call[] = [];
  const slots: { symbol: string; kind: "ui" | "sv" | "ref" | "overlay"; t: TickerConfig }[] = [];
  for (const t of tickers) {
    calls.push({ address: getAddress(t.bStock), abi: issuerAbi, functionName: "uiMultiplier" });
    slots.push({ symbol: t.symbol, kind: "ui", t });
    if (isSet(t.ondo)) {
      calls.push({ address: ONDO_SHARES, abi: issuerAbi, functionName: "getSValue", args: [getAddress(t.ondo)] });
      slots.push({ symbol: t.symbol, kind: "sv", t });
    }
    if (isSet(t.chainlink)) {
      calls.push({ address: getAddress(t.chainlink), abi: issuerAbi, functionName: "latestRoundData" });
      slots.push({ symbol: t.symbol, kind: "ref", t });
    }
    if (d && isSet(t.ondo)) {
      calls.push({ address: d.sessionOracle, abi: sessionOracleAbi, functionName: "overlay", args: [symbolToBytes32(t.symbol)] });
      slots.push({ symbol: t.symbol, kind: "overlay", t });
    }
  }
  const res = await multi(c, calls, h.blockNumber);
  const multipliers: ChainSide["multipliers"] = new Map();
  const references: ChainSide["references"] = new Map();
  res.forEach((r, i) => {
    const s = slots[i]!;
    if (r === null) return;
    if (s.kind === "ui") {
      const m = e18(r as bigint);
      if (m > 0) multipliers.set(s.t.bStock.toLowerCase(), { value: m, source: "bstock-token" });
    } else if (s.kind === "sv") {
      const [sv, paused] = r as readonly [bigint, boolean];
      // a paused shares oracle is left out, as SessionOracle.sharesPerToken() treats it as stale
      if (sv > 0n && !paused && !multipliers.has(s.t.ondo.toLowerCase())) multipliers.set(s.t.ondo.toLowerCase(), { value: e18(sv), source: "ondo-shares-oracle" });
    } else if (s.kind === "overlay") {
      const o = r as { validUntil: bigint; ondoMultiplier: bigint };
      // the publisher's live multiplier wins while its overlay is valid, as on chain
      if (o.ondoMultiplier > 0n && Number(o.validUntil) >= h.at) multipliers.set(s.t.ondo.toLowerCase(), { value: e18(o.ondoMultiplier), source: "session-oracle-overlay" });
    } else {
      const [, answer, , updatedAt] = r as readonly [bigint, bigint, bigint, bigint, bigint];
      if (answer > 0n) references.set(s.symbol, { price: e8(answer), updatedAt: Number(updatedAt), feed: getAddress(s.t.chainlink) });
    }
  });
  return { blockNumber: h.blockNumber, at: h.at, multipliers, references };
}

function venuePrice(venue: Venue, token: string, p: RwaPrice | undefined, chain: ChainSide | null, at: number): VenuePrice {
  const tokenPrice = p ? num(p.tokenPrice) : null;
  const updatedAt = p && Number.isFinite(p.tokenPriceUpdatedAt) && p.tokenPriceUpdatedAt > 0 ? Math.floor(p.tokenPriceUpdatedAt / 1000) : null;
  // xStocks rebase: a holder's balance already counts shares, so the token price is a per-share price
  const m = venue === "xstock" ? { value: 1, source: "rebasing" as const } : (chain?.multipliers.get(token.toLowerCase()) ?? null);
  const out: VenuePrice = {
    venue,
    token: getAddress(token),
    platform: p && typeof p.platformId === "string" ? p.platformId : null,
    tokenPrice,
    referencePrice: p ? num(p.referencePrice) : null,
    updatedAt,
    multiplier: m?.value ?? null,
    multiplierSource: m?.source ?? null,
    perShare: perShare(tokenPrice, m?.value ?? null),
    stale: updatedAt === null || at - updatedAt > STALE_AFTER_SEC,
  };
  if (!p) out.note = "Binance returned no price for this token";
  else if (tokenPrice === null) out.note = "Binance returned no usable price";
  else if (!m) out.note = chain ? "the share multiplier could not be read on chain" : "share multipliers unavailable: the chain read failed";
  return out;
}

export async function readPrices(deps: PriceDeps): Promise<PricesBody> {
  const now = deps.now ?? Date.now;
  const listed: { symbol: string; venue: Venue; token: string }[] = tickers.flatMap((t) =>
    ([["bstock", t.bStock], ["ondo", t.ondo], ["xstock", t.xStock]] as const).filter(([, a]) => isSet(a)).map(([venue, token]) => ({ symbol: t.symbol, venue, token })),
  );
  const [pricesR, chainR] = await Promise.allSettled([deps.rwaPrice(listed.map((l) => l.token)), readChainSide(deps.chain, deps.deployment)]);
  if (pricesR.status === "rejected") return { status: "unavailable", detail: `Binance RWA price unavailable: ${shortMessage(pricesR.reason)}` };
  const chain = chainR.status === "fulfilled" ? chainR.value : null;
  const fetchedAt = Math.floor(now() / 1000);
  const byToken = new Map<string, RwaPrice>();
  for (const p of Array.isArray(pricesR.value) ? pricesR.value : []) {
    if (p && typeof p.tokenContractAddress === "string") byToken.set(p.tokenContractAddress.toLowerCase(), p);
  }
  const symbols: SymbolPrices[] = tickers.map((t) => {
    const reference = chain?.references.get(t.symbol) ?? null;
    return {
      symbol: t.symbol,
      venues: listed.filter((l) => l.symbol === t.symbol).map((l) => venuePrice(l.venue, l.token, byToken.get(l.token.toLowerCase()), chain, fetchedAt)),
      reference,
      ...(reference
        ? {}
        : { referenceNote: !isSet(t.chainlink) ? "no Chainlink feed: the publisher posts this ticker's reference to the Session Oracle" : chain ? "the Chainlink feed could not be read" : "the chain read failed" }),
    };
  });
  return {
    status: "ok",
    fetchedAt,
    blockNumber: chain ? chain.blockNumber.toString() : null,
    ...(chain ? {} : { chainNote: `on-chain multipliers and references unavailable: ${shortMessage((chainR as PromiseRejectedResult).reason)}` }),
    symbols,
  };
}

function web3(e: ServerEnv, fetchImpl?: typeof fetch): Web3Client | null {
  if (!e.binance) return null;
  return new Web3Client({ apiKey: e.binance.apiKey, apiSecret: e.binance.apiSecret, probe: () => {}, fetch: fetchImpl, timeoutMs: LIMITS.rpcTimeoutMs, maxRetries: 1 });
}

const NOT_KEYED = "the Binance Web3 API key is not configured on this server (BINANCE_WEB3_API_KEY / BINANCE_WEB3_API_SECRET)";

export const PRICES_TTL_MS = 30_000;
const replayError = (err: unknown) => !(err instanceof BusyError);
const pricesCache = ttlCache<PricesBody>(PRICES_TTL_MS, { errorTtlMs: 5_000, replayError, max: 4 });

const busy = (err: BusyError) => Response.json({ error: err.message }, { status: 503, headers: { ...NO_STORE, "retry-after": "2" } });

export async function handlePrices(e: ServerEnv, s: DeploymentStatus, c: ReadClient, fetchImpl?: typeof fetch): Promise<Response> {
  const client = web3(e, fetchImpl);
  let body: PricesBody;
  if (!client) body = { status: "not-configured", detail: NOT_KEYED };
  else {
    try {
      body = await pricesCache.get(`${e.chainId}|${s.ok ? s.deployment.sessionOracle : "-"}`, () =>
        readGate.run(() =>
          withDeadline(
            readPrices({ rwaPrice: (a) => rwa.price(client, BSC, a), chain: c, deployment: s.ok ? s.deployment : null }).then((r) => {
              // an outage, or an answer missing its chain half, is replayed for a few seconds and then read again
              if (r.status !== "ok" || r.blockNumber === null) throw Object.assign(new Error(r.status === "ok" ? "partial" : r.detail), { body: r });
              return r;
            }),
          ),
        ),
      );
    } catch (err) {
      if (err instanceof BusyError) return busy(err);
      body = (err as { body?: PricesBody }).body ?? { status: "unavailable", detail: shortMessage(err) };
    }
  }
  return Response.json(body, { headers: { "cache-control": body.status === "ok" && body.blockNumber !== null ? "public, s-maxage=20, stale-while-revalidate=40" : "no-store" } });
}

// ------------------------------------------------------------------ candles

/** Market API candle rows: [open, high, low, close, volume, openTimeMs, trades]. Bad rows are dropped. */
export function parseCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const out = new Map<number, Candle>();
  for (const r of rows.slice(0, 1000)) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [o, h, l, c, v, ms] = r.map(num) as [number | null, number | null, number | null, number | null, number | null, number | null];
    if (o === null || h === null || l === null || c === null || ms === null || !(o > 0) || !(h >= l) || !(l > 0) || !(c > 0)) continue;
    const t = Math.floor(ms / 1000);
    out.set(t, { t, o, h, l, c, v });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

const fromKlines = (ks: readonly Kline[]): Candle[] =>
  parseCandles(ks.map((k) => [k.open, k.high, k.low, k.close, k.volume, k.openTime]));

export interface ReferenceHistory {
  prints: RefPrint[];
  multiplier: number | null;
  maxRefAgeSec: number;
}

/**
 * The Chainlink feed's rounds, newest first, read back from the latest one: at most MARKET_LIMITS.rounds of them
 * in one Multicall3 round, with the bStock's share multiplier (and the oracle's maxRefAge once it is deployed).
 */
export async function readReferenceHistory(c: ReadClient, t: TickerConfig, d: Deployment | null): Promise<ReferenceHistory> {
  const h = await head(c);
  const first: Call[] = [{ address: getAddress(t.bStock), abi: issuerAbi, functionName: "uiMultiplier" }];
  if (isSet(t.chainlink)) first.push({ address: getAddress(t.chainlink), abi: issuerAbi, functionName: "latestRoundData" });
  if (d) first.push({ address: d.sessionOracle, abi: sessionOracleAbi, functionName: "params" });
  const r0 = await multi(c, first, h.blockNumber);
  const ui = r0[0] as bigint | null;
  const latest = isSet(t.chainlink) ? (r0[1] as readonly [bigint, bigint, bigint, bigint, bigint] | null) : null;
  const params = d ? (r0[isSet(t.chainlink) ? 2 : 1] as readonly unknown[] | null) : null;
  const maxRefAgeSec = params && typeof params[3] === "number" && params[3] > 0 ? params[3] : MARKET_LIMITS.maxRefAgeSec;
  const multiplier = ui !== null && ui > 0n ? e18(ui) : null;
  if (!latest || latest[1] <= 0n) return { prints: [], multiplier, maxRefAgeSec };
  const prints: RefPrint[] = [{ at: Number(latest[3]), price: e8(latest[1]) }];
  // a proxy round id is phase << 64 | round: walk back inside the current phase only
  const roundId = latest[0];
  const inPhase = roundId & ((1n << 64n) - 1n);
  const back = Number(inPhase - 1n < BigInt(MARKET_LIMITS.rounds - 1) ? inPhase - 1n : BigInt(MARKET_LIMITS.rounds - 1));
  const calls: Call[] = [];
  for (let k = 1; k <= back; k++) calls.push({ address: getAddress(t.chainlink), abi: issuerAbi, functionName: "getRoundData", args: [roundId - BigInt(k)] });
  for (const r of await multi(c, calls, h.blockNumber)) {
    if (r === null) continue;
    const [, answer, , updatedAt] = r as readonly [bigint, bigint, bigint, bigint, bigint];
    if (answer > 0n && updatedAt > 0n) prints.push({ at: Number(updatedAt), price: e8(answer) });
  }
  return { prints, multiplier, maxRefAgeSec };
}

export interface CandleDeps {
  /** keyed Market API candles (rows as the API returns them); null when no key is configured */
  keyed: ((token: string, limit: number) => Promise<unknown>) | null;
  /** Binance's keyless RWA klines */
  keyless(token: string, limit: number): Promise<Kline[]>;
  chain: ReadClient;
  deployment: Deployment | null;
  now?: () => number;
}

const GAP_OF: Record<Closure["kind"], keyof TickerConfig["gapBps"]> = { overnight: "overnight", weekend: "weekend", holiday: "holiday" };

export async function readCandles(symbol: string, deps: CandleDeps): Promise<CandlesBody> {
  const t = tickers.find((x) => x.symbol === symbol);
  if (!t) return { status: "unavailable", detail: `${symbol} is not listed` };
  const now = Math.floor((deps.now ?? Date.now)() / 1000);

  let candles: Candle[] = [];
  let source: "market-api" | "public-klines" = "market-api";
  let sourceNote: string | undefined;
  let keyedError: string | null = deps.keyed ? null : "no API key on this server";
  if (deps.keyed) {
    try {
      candles = parseCandles(await deps.keyed(t.bStock, MARKET_LIMITS.candles));
      if (candles.length === 0) keyedError = "the Market API returned no candles";
    } catch (err) {
      keyedError = shortMessage(err);
    }
  }
  if (keyedError !== null) {
    try {
      candles = fromKlines(await deps.keyless(t.bStock, MARKET_LIMITS.candles));
      source = "public-klines";
      sourceNote = `Binance Web3 Market API candles unavailable (${keyedError}); Binance's keyless RWA klines are shown instead`;
    } catch (err) {
      return { status: "unavailable", detail: `Binance candles unavailable: ${keyedError}; keyless klines: ${shortMessage(err)}` };
    }
    if (candles.length === 0) return { status: "unavailable", detail: `Binance candles unavailable: ${keyedError}; the keyless klines were empty` };
  }

  let history: ReferenceHistory = { prints: [], multiplier: null, maxRefAgeSec: MARKET_LIMITS.maxRefAgeSec };
  let referenceNote: string | undefined;
  let partial = false;
  try {
    history = await readReferenceHistory(deps.chain, t, deps.deployment);
    if (!isSet(t.chainlink)) referenceNote = "This ticker has no Chainlink feed. Its reference is the publisher's last print on the Session Oracle, so its band can be drawn only from the contract.";
    else if (history.prints.length === 0) referenceNote = "The Chainlink feed returned no rounds.";
  } catch (err) {
    referenceNote = `The reference history could not be read on chain: ${shortMessage(err)}`;
    partial = true;
  }

  const closures = recentClosures(now).map((cl) => closureChart(cl, t.gapBps[GAP_OF[cl.kind]], candles, history.prints, history.multiplier, history.maxRefAgeSec, now));
  return {
    status: "ok",
    symbol: t.symbol,
    token: getAddress(t.bStock),
    fetchedAt: now,
    source,
    ...(sourceNote ? { sourceNote } : {}),
    multiplier: history.multiplier,
    maxRefAgeSec: history.maxRefAgeSec,
    referenceSource: history.prints.length > 0 ? "chainlink" : "none",
    ...(referenceNote ? { referenceNote } : {}),
    ...(partial ? { partial } : {}),
    closures,
  };
}

export const CANDLES_TTL_MS = 120_000;
const candlesCache = ttlCache<CandlesBody>(CANDLES_TTL_MS, { errorTtlMs: 5_000, replayError, max: 32 });
const publicRwa = new PublicRwaClient({ probe: () => {}, timeoutMs: LIMITS.rpcTimeoutMs });

export interface CandleRouteDeps {
  fetch?: typeof fetch;
  keyless?: CandleDeps["keyless"];
  now?: () => number;
}

export async function handleCandles(req: Request, e: ServerEnv, s: DeploymentStatus, c: ReadClient, o: CandleRouteDeps = {}): Promise<Response> {
  const q = query(req);
  if (q instanceof Response) return q;
  const sym = symbolParam(q, "symbol");
  if (sym instanceof Response) return sym;
  if (sym === null) return badRequest("symbol is required");
  if (!tickers.some((t) => t.symbol === sym)) return badRequest("symbol is not listed", 404);
  const client = web3(e, o.fetch);
  let body: CandlesBody;
  try {
    body = await candlesCache.get(`${e.chainId}|${s.ok ? s.deployment.sessionOracle : "-"}|${sym}`, () =>
      readGate.run(() =>
        withDeadline(
          readCandles(sym, {
            keyed: client ? (token, limit) => marketApi.candles(client, { binanceChainId: BSC, tokenContractAddress: token, bar: "1h", limit }) : null,
            keyless: o.keyless ?? ((token, limit) => publicRwa.klines(BSC, token, "1h", limit)),
            chain: c,
            deployment: s.ok ? s.deployment : null,
            now: o.now,
          }).then((r) => {
            if (r.status !== "ok" || r.partial) throw Object.assign(new Error(r.status === "ok" ? "partial" : r.detail), { body: r });
            return r;
          }),
        ),
      ),
    );
  } catch (err) {
    if (err instanceof BusyError) return busy(err);
    body = (err as { body?: CandlesBody }).body ?? { status: "unavailable", detail: shortMessage(err) };
  }
  return Response.json(body, { headers: { "cache-control": body.status === "ok" && !body.partial ? "public, s-maxage=60, stale-while-revalidate=120" : "no-store" } });
}
