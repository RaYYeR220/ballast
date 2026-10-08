// Session Oracle overlay publisher. Every 10 min (and 3 min after each regular open and close) it reads the
// keyless Binance RWA status for each listed bStock and its Ondo token, builds the overlay the contract
// accepts, and posts the symbols whose overlay changed or whose 5 h heartbeat is due, in one batched
// postOverlays. Simulated first; a symbol the contract refuses is recorded and backed off for 30 min.
import { readFile } from "node:fs/promises";
import { nextClose, nextOpen, regularCloseAt } from "@ballast/risk";
import {
  OVERLAY_FLAGS,
  bytes32ToSymbol,
  isRevert,
  sessionCalendarAbi,
  sessionName,
  sessionOracleAbi,
  writes,
  type Deployment,
  type OracleParams,
  type OverlayInput,
  type ReadClient,
  type SessionName,
} from "@ballast/sdk";
import type { AssetStatus, RwaDynamic } from "@ballast/binance";
import { parseAbi, parseUnits, zeroAddress, type Address } from "viem";
import { DisagreementWatch, type Feed, type FeedError, type FeedSim } from "./feed";
import { safeMessage, type GasWatch, type TxSender } from "./tx";

export const TICK_SEC = 600;
/** Re-post an unchanged overlay after this long (validity is 5.5 h, so 30 min of slack). */
export const HEARTBEAT_SEC = 5 * 3600;
export const VALIDITY_SEC = 5.5 * 3600;
export const BACKOFF_SEC = 30 * 60;
/** During the regular session, refresh the reference of a ticker without Chainlink after half the oracle's maxRefAge (at least one tick)... */
export const refRefreshSec = (maxRefAge: number) => Math.max(TICK_SEC, Math.floor(maxRefAge / 2));
/** ...or as soon as the print moved this far from the last one (a third of the oracle's convergence band). */
export const REF_MOVE_BPS = 20;
/** No reference this close to the regular close: the transaction could land after it and revert the batch. */
export const REF_CLOSE_MARGIN_SEC = 300;
/** Binance's chain id for the bStock and Ondo token addresses (also used on a fork of BSC). */
const RWA_CHAIN = "56";

// ------------------------------------------------------------------ flags

const CORPORATE_ACTIONS = new Set(["cash_dividend", "stock_dividend", "stock_split", "merger", "acquisition", "spinoff", "corporate_action"]);
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Overlay flag bits for one RWA asset status: ASSET_PAUSED / MARKET_PAUSED halt the symbol, a corporate
 * action reason marks it, and ASSET_LIMITED is passed through (with EARNINGS_WINDOW when the reason is earnings).
 */
export function flagsFromStatus(s: AssetStatus | null | undefined): number {
  if (!s) return 0;
  const code = (s.reasonCode ?? "").trim().toUpperCase();
  const msg = norm(s.reasonMsg);
  let f = 0;
  if (code === "ASSET_PAUSED" || code === "MARKET_PAUSED") f |= OVERLAY_FLAGS.HALTED;
  if (CORPORATE_ACTIONS.has(msg)) f |= OVERLAY_FLAGS.CORPORATE_ACTION;
  if (code === "ASSET_LIMITED") {
    f |= OVERLAY_FLAGS.ASSET_LIMITED;
    if (msg === "earnings") f |= OVERLAY_FLAGS.EARNINGS_WINDOW;
  }
  return f;
}

// --------------------------------------------------------------- earnings

/** Per symbol, ascending: the regular-open timestamps at which an earnings gap is realised. */
export type EarningsSchedule = ReadonlyMap<string, readonly number[]>;

const DAY_MS = 86_400_000;

/**
 * Regular open at which an announcement's gap is realised: before the open ("bmo") the same day's open,
 * after the close ("amc") the next open after that day's close. Weekends and holidays roll forward.
 */
function realisedAtFor(sym: string, e: unknown): number {
  if (!e || typeof e !== "object") throw new Error(`earnings ${sym}: entry must be an object`);
  const { date, timing, realisedAt } = e as { date?: unknown; timing?: unknown; realisedAt?: unknown };
  if (realisedAt !== undefined) {
    if (typeof realisedAt !== "number" || !Number.isSafeInteger(realisedAt) || realisedAt <= 0) throw new Error(`earnings ${sym}: realisedAt must be a unix timestamp`);
    return realisedAt;
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`earnings ${sym}: date must be YYYY-MM-DD`);
  const day = Date.parse(`${date}T00:00:00Z`) / DAY_MS;
  if (!Number.isInteger(day)) throw new Error(`earnings ${sym}: invalid date ${date}`);
  const t = timing ?? "amc";
  if (t !== "amc" && t !== "bmo") throw new Error(`earnings ${sym}: timing must be "bmo" or "amc"`);
  // bmo: the first regular open at or after that local day starts; amc: the first open after its close.
  const at = t === "bmo" ? nextOpen(regularCloseAt(day - 1)) : nextOpen(regularCloseAt(day));
  if (!at) throw new Error(`earnings ${sym}: ${date} is outside the session calendar`);
  return at;
}

/**
 * Parses config/earnings.json: `{ "earnings": { "NVDA": [{ "date": "2026-11-18", "timing": "amc" }, ...] } }`
 * (or `{ "realisedAt": <unix> }` entries). Throws on anything malformed.
 */
export function parseEarnings(json: unknown): EarningsSchedule {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("earnings: expected an object");
  const book = (json as { earnings?: unknown }).earnings ?? {};
  if (!book || typeof book !== "object" || Array.isArray(book)) throw new Error("earnings: `earnings` must map symbols to lists");
  const out = new Map<string, number[]>();
  for (const [sym, list] of Object.entries(book as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`earnings ${sym}: expected a list`);
    out.set(sym.toUpperCase(), list.map((e) => realisedAtFor(sym, e)).sort((a, b) => a - b));
  }
  return out;
}

/** Reads and parses the schedule. A missing file is an error (the repo ships one), not an empty schedule. */
export async function loadEarnings(file: string): Promise<EarningsSchedule> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`earnings schedule ${file} is missing`);
    throw err;
  }
  return parseEarnings(JSON.parse(text));
}

/** The next realised-at timestamp strictly after `now`, or 0 (which clears it on-chain). */
export function nextEarningsFor(s: EarningsSchedule, symbol: string, now: number): number {
  return s.get(symbol.toUpperCase())?.find((t) => t > now) ?? 0;
}

// ------------------------------------------------------------------ chain

export interface OverlayOnChain {
  validUntil: number;
  nextEarnings: number;
  flags: number;
  ondoMultiplier: bigint;
  referencePrice: bigint;
  postedAt: number;
}

export interface TickerOnChain {
  symbol: string;
  bStock: Address;
  /** Null when the ticker has no Ondo token. */
  ondo: Address | null;
  hasChainlink: boolean;
  overlay: OverlayOnChain;
  /** Ondo's on-chain sValue (1e18); null when unreadable or there is no Ondo token. */
  ondoSValue: bigint | null;
  /** SessionOracle.perSharePrice (1e8); null when unavailable. */
  perShare: bigint | null;
  /** Last accepted reference print (tickers without Chainlink). */
  lastReference: { price: bigint; postedAt: number };
}

export interface PublisherSnapshot {
  /** Head block timestamp. */
  at: number;
  session: SessionName;
  params: OracleParams;
  tickers: TickerOnChain[];
}

export interface PublisherReads {
  snapshot(): Promise<PublisherSnapshot>;
}

async function orNullOnRevert<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isRevert(err)) return null;
    throw err;
  }
}

const ondoSharesAbi = parseAbi(["function getSValue(address token) view returns (uint128 sValue, bool paused)"]);

/** Reads every listed ticker's overlay inputs from the deployment, pinned to the head block. */
export function chainPublisherReads(c: ReadClient, d: Deployment): PublisherReads {
  return {
    async snapshot() {
      const head = await c.getBlock({ blockTag: "latest" });
      const blockNumber = head.number as bigint;
      const or = { address: d.sessionOracle, abi: sessionOracleAbi, blockNumber } as const;
      const [session, p, count, ondoShares] = await Promise.all([
        c.readContract({ address: d.calendar, abi: sessionCalendarAbi, blockNumber, functionName: "session", args: [head.timestamp] }),
        c.readContract({ ...or, functionName: "params" }),
        c.readContract({ ...or, functionName: "symbolCount" }),
        c.readContract({ ...or, functionName: "ondoShares" }),
      ]);
      const syms = await Promise.all(Array.from({ length: Number(count) }, (_, i) => c.readContract({ ...or, functionName: "symbols", args: [BigInt(i)] })));
      const tickers = await Promise.all(
        syms.map(async (sym): Promise<TickerOnChain> => {
          const [t, ov, ps, lr] = await Promise.all([
            c.readContract({ ...or, functionName: "ticker", args: [sym] }),
            c.readContract({ ...or, functionName: "overlay", args: [sym] }),
            c.readContract({ ...or, functionName: "perSharePrice", args: [sym] }),
            c.readContract({ ...or, functionName: "lastReference", args: [sym] }),
          ]);
          const ondo = t.ondo === zeroAddress ? null : t.ondo;
          const sv = ondo
            ? await orNullOnRevert(c.readContract({ address: ondoShares, abi: ondoSharesAbi, blockNumber, functionName: "getSValue", args: [ondo] }))
            : null;
          return {
            symbol: bytes32ToSymbol(sym),
            bStock: t.bStock,
            ondo,
            hasChainlink: t.chainlink !== zeroAddress,
            overlay: {
              validUntil: Number(ov.validUntil),
              nextEarnings: Number(ov.nextEarnings),
              flags: ov.flags,
              ondoMultiplier: ov.ondoMultiplier,
              referencePrice: ov.referencePrice,
              postedAt: Number(ov.postedAt),
            },
            ondoSValue: sv && sv[0] > 0n ? sv[0] : null,
            perShare: ps[1] ? ps[0] : null,
            lastReference: { price: lr.price, postedAt: Number(lr.postedAt) },
          };
        }),
      );
      return {
        at: Number(head.timestamp),
        session: sessionName(session),
        params: {
          restoreDelay: p[0],
          horizon: p[1],
          convergenceBps: p[2],
          maxRefAge: p[3],
          maxOverlayTtl: p[4],
          maxOndoDriftBps: p[5],
          maxRefDeviationBps: p[6],
        },
        tickers,
      };
    },
  };
}

/** The keyless RWA calls the publisher makes (PublicRwaClient satisfies it). */
export interface RwaReads {
  assetStatus(chainId: string, contractAddress: string): Promise<AssetStatus>;
  dynamic(chainId: string, contractAddress: string): Promise<RwaDynamic>;
}

// ---------------------------------------------------------------- overlay

const DECIMAL = /^\d+(\.\d+)?$/;

/** A non-negative decimal string at `decimals` (extra digits are truncated), or null. */
export function parseDecimal(s: unknown, decimals: number): bigint | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!DECIMAL.test(t)) return null;
  const [int, frac = ""] = t.split(".");
  return parseUnits(`${int}.${frac.slice(0, decimals) || "0"}`, decimals);
}

const devBps = (a: bigint, b: bigint) => (b === 0n ? Number.POSITIVE_INFINITY : Number(((a > b ? a - b : b - a) * 10_000n) / b));

interface Finding {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

interface Built {
  overlay: OverlayInput & { validUntil: number; nextEarnings: number };
  findings: Finding[];
}

/** `nextEarnings` is decided by the caller: from the schedule, or carried forward while none has loaded. */
function buildOverlay(t: TickerOnChain, status: AssetStatus, ondo: RwaDynamic | null, snap: PublisherSnapshot, nextEarnings: number): Built {
  const findings: Finding[] = [];
  const flags = flagsFromStatus(status) | flagsFromStatus(ondo?.statusInfo);

  let ondoMultiplier = 0n;
  if (t.ondo && ondo) {
    const m = parseDecimal(ondo.tokenInfo?.sharesMultiplier, 18);
    const sv = t.ondoSValue;
    if (m === null || m === 0n) {
      findings.push({ type: "ondo-multiplier", message: "stale Ondo multiplier: the RWA feed returned none, omitted" });
    } else if (sv === null) {
      findings.push({ type: "ondo-multiplier", message: "stale Ondo multiplier: the on-chain sValue is unreadable, omitted", data: { posted: m } });
    } else if (m < sv || m > (sv * BigInt(10_000 + snap.params.maxOndoDriftBps)) / 10_000n) {
      findings.push({
        type: "ondo-multiplier",
        message: `stale Ondo multiplier: ${m} is outside [sValue ${sv}, +${snap.params.maxOndoDriftBps} bps], omitted`,
        data: { posted: m, sValue: sv },
      });
    } else {
      ondoMultiplier = m;
    }
  }

  // The contract accepts a reference only for tickers without Chainlink and only in the regular session;
  // any other nonzero reference reverts the whole batch. Zero keeps the last stored print.
  let referencePrice = 0n;
  const closeIn = nextClose(snap.at) - snap.at;
  if (!t.hasChainlink && snap.session === "REGULAR" && closeIn > REF_CLOSE_MARGIN_SEC && ondo) {
    const p = parseDecimal(ondo.stockInfo?.price, 8);
    if (p === null || p === 0n) {
      findings.push({ type: "reference", message: "reference unavailable: the Ondo feed has no underlying price" });
    } else if (t.perShare === null) {
      findings.push({ type: "reference", message: "reference omitted: the on-chain per-share price is unavailable", data: { reference: p } });
    } else if (devBps(p, t.perShare) > snap.params.maxRefDeviationBps) {
      findings.push({
        type: "reference",
        message: `reference ${p} is more than ${snap.params.maxRefDeviationBps} bps from the per-share price ${t.perShare}, omitted`,
        data: { reference: p, perShare: t.perShare },
      });
    } else {
      referencePrice = p;
    }
  }

  const validity = Math.min(VALIDITY_SEC, snap.params.maxOverlayTtl - 300);
  return {
    overlay: { validUntil: snap.at + validity, nextEarnings, flags, ondoMultiplier, referencePrice },
    findings,
  };
}

/** What a symbol last carried: the on-chain overlay, or this process's own newer post. */
interface Last {
  postedAt: number;
  validUntil: number;
  nextEarnings: number;
  flags: number;
  ondoMultiplier: bigint;
  refPrice: bigint;
  refAt: number;
}

function dueReason(last: Last, o: Built["overlay"], at: number, refreshSec: number): string | null {
  if (last.postedAt === 0) return "first post";
  if (o.flags !== last.flags) return `flags ${last.flags} -> ${o.flags}`;
  if (o.nextEarnings !== last.nextEarnings) return `nextEarnings ${last.nextEarnings} -> ${o.nextEarnings}`;
  if (o.ondoMultiplier !== last.ondoMultiplier) return "ondo multiplier changed";
  if (o.referencePrice !== 0n) {
    if (last.refPrice === 0n) return "first reference";
    if (at - last.refAt >= refreshSec) return "reference refresh";
    if (devBps(o.referencePrice, last.refPrice) > REF_MOVE_BPS) return "reference moved";
  }
  if (at - last.postedAt >= HEARTBEAT_SEC) return "heartbeat";
  if (last.validUntil - at < 1800) return "expiring";
  return null;
}

// -------------------------------------------------------------- publisher

export interface PublisherOptions {
  deployment: Deployment;
  reads: PublisherReads;
  rwa: RwaReads;
  sender: TxSender;
  feed: Feed;
  /** The current earnings schedule (read each tick so operator edits apply without a restart). */
  earnings: () => Promise<EarningsSchedule>;
  /** Shared low-BNB alert (one per process). */
  gas?: GasWatch;
  log?: (line: string) => void;
}

export interface PublishReport {
  at: number;
  posted: string[];
  refused: string[];
  /** Symbols skipped this tick, with why. */
  skipped: Record<string, string>;
  txHash?: string;
  /** The previous tick was still running: this one did nothing. */
  busy?: true;
}

type Entry = { symbol: string; overlay: Built["overlay"]; reason: string };

export class Publisher {
  readonly #o: PublisherOptions;
  readonly #backoff = new Map<string, number>();
  readonly #last = new Map<string, Last>();
  #findings = new Set<string>();
  /** Null until the schedule has loaded once: until then each symbol carries its last nextEarnings forward. */
  #earnings: EarningsSchedule | null = null;
  #running = false;
  /** `since` of the sender halt already reported. */
  #haltSeen: number | null = null;
  readonly #disagreements: DisagreementWatch;

  constructor(o: PublisherOptions) {
    this.#o = o;
    this.#disagreements = new DisagreementWatch(o.feed, "publisher");
  }

  async tick(): Promise<PublishReport> {
    if (this.#running) return { at: 0, posted: [], refused: [], skipped: {}, busy: true };
    this.#running = true;
    try {
      return await this.#tick();
    } finally {
      this.#running = false;
    }
  }

  async #tick(): Promise<PublishReport> {
    const { reads, sender } = this.#o;
    await this.#o.gas?.check("publisher");
    const snap = await reads.snapshot();
    const report: PublishReport = { at: snap.at, posted: [], refused: [], skipped: {} };
    const seen = new Set<string>();
    const finding = async (symbol: string, f: Finding) => {
      const key = `${symbol}:${f.type}`;
      seen.add(key);
      if (this.#findings.has(key)) return;
      await this.#o.feed.record({ kind: "finding", source: "publisher", symbol, reason: f.message, ...(f.data ? { data: f.data } : {}) });
    };

    try {
      this.#earnings = await this.#o.earnings();
    } catch (err) {
      const keep = this.#earnings ? "keeping the last good one" : "carrying each symbol's on-chain nextEarnings forward";
      await finding("*", { type: "earnings", message: `earnings schedule unreadable, ${keep}: ${safeMessage(err)}` });
    }

    const due: Entry[] = [];
    for (const t of snap.tickers) {
      const until = this.#backoff.get(t.symbol) ?? 0;
      if (until > snap.at) {
        report.skipped[t.symbol] = `backing off until ${until}`;
        continue;
      }
      // The bStock status is required; the Ondo data is optional (no multiplier, no reference without it).
      const [bStock, ondoRes] = await Promise.allSettled([
        this.#o.rwa.assetStatus(RWA_CHAIN, t.bStock),
        t.ondo ? this.#o.rwa.dynamic(RWA_CHAIN, t.ondo) : Promise.resolve(null),
      ]);
      if (bStock.status === "rejected") {
        report.skipped[t.symbol] = "RWA status unavailable";
        await finding(t.symbol, { type: "rwa", message: `RWA status unavailable, not posting: ${safeMessage(bStock.reason)}` });
        continue;
      }
      let ondo: RwaDynamic | null = null;
      if (ondoRes.status === "fulfilled") ondo = ondoRes.value;
      else await finding(t.symbol, { type: "ondo", message: `Ondo RWA data unavailable, posting without a multiplier or reference: ${safeMessage(ondoRes.reason)}` });
      const last = this.#lastFor(t);
      const nextEarnings = this.#earnings ? nextEarningsFor(this.#earnings, t.symbol, snap.at) : last.nextEarnings;
      const built = buildOverlay(t, bStock.value, ondo, snap, nextEarnings);
      for (const f of built.findings) await finding(t.symbol, f);
      const reason = dueReason(last, built.overlay, snap.at, refRefreshSec(snap.params.maxRefAge));
      if (reason) due.push({ symbol: t.symbol, overlay: built.overlay, reason });
    }
    this.#findings = seen;
    if (due.length === 0) return report;

    // Simulate the batch; if it reverts, find the symbols that revert alone and post the rest.
    let batch = due;
    let sim = await this.#simulate(batch, snap.at);
    if (!sim.ok) {
      const ok: Entry[] = [];
      for (const e of batch) {
        const one = await this.#simulate([e], snap.at);
        if (one.ok) ok.push(e);
        else await this.#refuse([e], snap.at, one, one.error, report);
      }
      if (ok.length === batch.length) {
        await this.#refuse(batch, snap.at, sim, sim.error, report); // reverts only together: back off all of it
        return report;
      }
      batch = ok;
      if (batch.length === 0) return report;
      sim = await this.#simulate(batch, snap.at);
      if (!sim.ok) {
        await this.#refuse(batch, snap.at, sim, sim.error, report);
        return report;
      }
    }

    const data = {
      reasons: Object.fromEntries(batch.map((e) => [e.symbol, e.reason])),
      overlays: Object.fromEntries(batch.map((e) => [e.symbol, e.overlay])),
    };
    const symbols = batch.map((e) => e.symbol);
    if (sender.dryRun) {
      await this.#o.feed.record({ kind: "publish", source: "publisher", symbols, sim, dryRun: true, data });
      this.#remember(batch, snap.at);
      report.posted = symbols;
      return report;
    }

    let sent;
    try {
      sent = await sender.send(writes.postOverlays(this.#o.deployment, batch));
    } catch (err) {
      // Not a contract refusal (RPC down, out of gas money, nonce race): try again next tick.
      await this.#refuse(batch, snap.at, sim, { name: "BroadcastFailed", message: safeMessage(err) }, report, { backoffSec: TICK_SEC });
      return report;
    }
    if (!sent.ok && sent.stage === "halted") {
      // The sender signs nothing until its halt clears: say so once per halt and look again next tick.
      for (const e of batch) this.#backoff.set(e.symbol, snap.at + TICK_SEC);
      report.refused.push(...symbols);
      if (this.#haltSeen !== sent.halt.since) {
        this.#haltSeen = sent.halt.since;
        await this.#o.feed.record({
          kind: "refused",
          source: "publisher",
          symbols,
          sim,
          error: { name: "SENDER_HALTED", message: sent.halt.message },
          reason: `SENDER_HALTED (${sent.halt.reason}): ${sent.halt.message}`,
          data: { sender: "halted", halt: sent.halt },
        });
      }
      return report;
    }
    if (!sent.ok) {
      const error: FeedError = sent.stage === "estimate" ? sent.error : { name: "Aborted", message: "the send was aborted" };
      await this.#isolate(batch, snap.at, sim, error, report);
      return report;
    }
    if (sent.status === "reverted") {
      await this.#isolate(batch, snap.at, sim, { name: "Reverted", message: "postOverlays reverted on-chain" }, report, sent.txHash);
      return report;
    }
    if (sent.status === "dropped") {
      await this.#refuse(batch, snap.at, sim, { name: "Dropped", message: sent.note ?? "replaced before it was mined" }, report, { txHash: sent.txHash, backoffSec: 0 });
      return report;
    }
    if (sent.status === "pending") {
      // Only when the sender halted on it. Not remembered: the symbols stay due and are posted again once
      // the sender has settled this nonce.
      await this.#o.feed.record({
        kind: "pending",
        source: "publisher",
        symbols,
        sim,
        txHash: sent.txHash,
        reason: sent.note ?? "not mined yet",
        data: { ...data, nonce: sent.nonce, ...(sent.halted ? { sender: "halted", halt: sent.halted } : {}) },
      });
      return report;
    }
    await this.#o.feed.record({
      kind: "publish",
      source: "publisher",
      symbols,
      sim,
      txHash: sent.txHash,
      data: { ...data, via: sent.via, gasUsed: sent.gasUsed },
    });
    this.#remember(batch, snap.at);
    for (const s of symbols) this.#backoff.delete(s);
    report.posted = symbols;
    report.txHash = sent.txHash;
    this.#o.log?.(`published ${symbols.join(",")} in ${sent.txHash}`);
    return report;
  }

  #lastFor(t: TickerOnChain): Last {
    const chain: Last = {
      postedAt: t.overlay.postedAt,
      validUntil: t.overlay.validUntil,
      nextEarnings: t.overlay.nextEarnings,
      flags: t.overlay.flags,
      ondoMultiplier: t.overlay.ondoMultiplier,
      refPrice: t.lastReference.price,
      refAt: t.lastReference.postedAt,
    };
    const mine = this.#last.get(t.symbol);
    if (!mine) return chain;
    const last = mine.postedAt >= chain.postedAt ? { ...mine } : { ...chain };
    if (mine.refAt > chain.refAt) {
      last.refPrice = mine.refPrice;
      last.refAt = mine.refAt;
    } else {
      last.refPrice = chain.refPrice;
      last.refAt = chain.refAt;
    }
    return last;
  }

  #remember(batch: Entry[], at: number) {
    for (const e of batch) {
      const prev = this.#last.get(e.symbol);
      this.#last.set(e.symbol, {
        postedAt: at,
        validUntil: e.overlay.validUntil,
        nextEarnings: e.overlay.nextEarnings,
        flags: e.overlay.flags,
        ondoMultiplier: e.overlay.ondoMultiplier,
        refPrice: e.overlay.referencePrice !== 0n ? e.overlay.referencePrice : (prev?.refPrice ?? 0n),
        refAt: e.overlay.referencePrice !== 0n ? at : (prev?.refAt ?? 0),
      });
    }
  }

  async #simulate(batch: Entry[], at: number): Promise<FeedSim> {
    const sim = await this.#o.sender.simulate(writes.postOverlays(this.#o.deployment, batch));
    await this.#disagreements.note(sim, at, { symbols: batch.map((e) => e.symbol) });
    return sim;
  }

  /**
   * After a revert at estimation or on-chain: simulate each symbol alone at the new head. The ones that fail
   * alone back off 30 min; the rest back off one tick only.
   */
  async #isolate(batch: Entry[], at: number, sim: FeedSim, error: FeedError, report: PublishReport, txHash?: `0x${string}`) {
    const culprits: { e: Entry; sim: FeedSim }[] = [];
    const rest: Entry[] = [];
    for (const e of batch) {
      const one = await this.#simulate([e], at);
      if (one.ok) rest.push(e);
      else culprits.push({ e, sim: one });
    }
    if (rest.length) await this.#refuse(rest, at, sim, error, report, { txHash, backoffSec: TICK_SEC });
    for (const c of culprits) await this.#refuse([c.e], at, c.sim, c.sim.error, report);
  }

  async #refuse(
    batch: Entry[],
    at: number,
    sim: FeedSim,
    error: FeedError | undefined,
    report: PublishReport,
    o: { txHash?: `0x${string}`; backoffSec?: number } = {},
  ) {
    const backoff = o.backoffSec ?? BACKOFF_SEC;
    for (const e of batch) {
      if (backoff > 0) this.#backoff.set(e.symbol, at + backoff);
      report.refused.push(e.symbol);
      await this.#o.feed.record({
        kind: "refused",
        source: "publisher",
        symbol: e.symbol,
        sim,
        ...(error ? { error, reason: error.message } : {}),
        ...(o.txHash ? { txHash: o.txHash } : {}),
        data: { overlay: e.overlay, due: e.reason, backoffUntil: at + backoff },
      });
    }
  }
}

/**
 * Run after a regular open or close once Binance's two-minute session-transition pause (MARKET_PAUSED, which
 * maps to HALTED) is over, so the boundary run does not post a halt for a scheduled transition.
 */
export const BOUNDARY_DELAY_SEC = 180;

/**
 * Seconds until the next publisher run: every TICK_SEC, except that a run due at or after a regular open or
 * close within the next tick moves to BOUNDARY_DELAY_SEC after it (never inside the transition pause).
 */
export function publisherDelaySec(now: number): number {
  const soon = [nextOpen(now), nextClose(now)].filter((b) => b > now && b <= now + TICK_SEC);
  const next = soon.length ? Math.min(...soon) + BOUNDARY_DELAY_SEC : now + TICK_SEC;
  return Math.max(5, next - now);
}
