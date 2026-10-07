import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, getAddress, toHex, type Address, type Hex } from "viem";
import { bytes32ToSymbol, parseDeployment, sessionOracleAbi, type TxRequest } from "@ballast/sdk";
import type { AssetStatus, RwaDynamic } from "@ballast/binance";
import { regularCloseAt, regularOpenAt } from "@ballast/risk";
import { Feed } from "../src/desk/feed";
import {
  BACKOFF_SEC,
  HEARTBEAT_SEC,
  Publisher,
  TICK_SEC,
  VALIDITY_SEC,
  flagsFromStatus,
  loadEarnings,
  nextEarningsFor,
  parseEarnings,
  publisherDelaySec,
  type PublisherSnapshot,
  type TickerOnChain,
} from "../src/desk/publisher";
import { GasWatch, revertError, type SendResult, type TxBuilder, type TxSender } from "../src/desk/tx";

const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));
const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
const d = parseDeployment(31337, {
  calendar: addr(0xa1),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
});
const params = { restoreDelay: 5400, horizon: 10_800, convergenceBps: 60, maxRefAge: 93_600, maxOverlayTtl: 21_600, maxOndoDriftBps: 100, maxRefDeviationBps: 300 };

// Wednesday 2026-10-07 (EDT): regular session 13:30-20:00 UTC.
const WED = Date.UTC(2026, 9, 7) / 86_400_000;
const REGULAR_AT = Date.UTC(2026, 9, 7, 15, 0) / 1000;
const POST_AT = Date.UTC(2026, 9, 7, 21, 0) / 1000;

const TOKENS: Record<string, { bStock: Address; ondo: Address }> = {
  NVDA: { bStock: addr(0x101), ondo: addr(0x201) },
  CRCL: { bStock: addr(0x102), ondo: addr(0x202) },
  SPY: { bStock: addr(0x103), ondo: addr(0x203) },
};

function ticker(symbol: string, o: Partial<TickerOnChain> = {}): TickerOnChain {
  const t = TOKENS[symbol]!;
  return {
    symbol,
    bStock: t.bStock,
    ondo: t.ondo,
    hasChainlink: symbol !== "CRCL",
    overlay: { validUntil: 0, nextEarnings: 0, flags: 0, ondoMultiplier: 0n, referencePrice: 0n, postedAt: 0 },
    ondoSValue: E18,
    perShare: 100n * E8,
    lastReference: { price: 0n, postedAt: 0 },
    ...o,
  };
}

const trading: AssetStatus = { openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null };

function dynamic(o: { multiplier?: string; price?: string | null; status?: AssetStatus } = {}): RwaDynamic {
  return {
    symbol: "Xon",
    ticker: "X",
    type: 1,
    tokenInfo: { price: "100", sharesMultiplier: o.multiplier ?? "1.004" },
    stockInfo: { price: o.price === undefined ? "100.25" : o.price },
    statusInfo: o.status ?? trading,
    limitInfo: null,
  };
}

/** Records simulations and sends; rejects any batch containing a symbol in `failing`. */
class StubSender implements TxSender {
  readonly address = addr(0xee);
  dryRun = false;
  failing = new Map<string, Hex>();
  sims: string[][] = [];
  sent: { symbols: string[]; overlays: readonly { validUntil: bigint; nextEarnings: bigint; flags: number; ondoMultiplier: bigint; referencePrice: bigint }[] }[] = [];

  decode(tx: TxRequest) {
    const { functionName, args } = decodeFunctionData({ abi: sessionOracleAbi, data: tx.data });
    if (functionName !== "postOverlays") throw new Error(`unexpected ${functionName}`);
    return { symbols: (args[0] as readonly Hex[]).map(bytes32ToSymbol), overlays: args[1] };
  }

  async simulate(tx: TxRequest) {
    const { symbols } = this.decode(tx);
    this.sims.push(symbols);
    const bad = symbols.find((s) => this.failing.has(s));
    if (bad) return { via: "rpc" as const, ok: false, error: revertError(this.failing.get(bad)!)! };
    if (this.disagree) return { via: "rpc" as const, ok: true, disagree: true, note: "binance simulate reported FAILED" };
    return { via: "rpc" as const, ok: true };
  }

  /** What the next sends return (or throw); default: mined successfully. */
  outcomes: (SendResult | Error)[] = [];
  /** Simulations that report a Binance / eth_call disagreement (eth_call wins). */
  disagree = false;

  async send(tx: TxRequest | TxBuilder): Promise<SendResult> {
    if (typeof tx === "function") throw new Error("the publisher sends plain transactions");
    this.sent.push(this.decode(tx));
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    return next ?? { ok: true, txHash: `0x${"ab".repeat(32)}`, via: "rpc", status: "success", nonce: 1, gasPrice: 1n };
  }

  async balance() {
    return 10n ** 18n;
  }
}

interface Harness {
  publisher: Publisher;
  sender: StubSender;
  feed: Feed;
  state: { at: number; session: PublisherSnapshot["session"]; tickers: TickerOnChain[] };
  status: Map<Address, AssetStatus | Error>;
  dyn: Map<Address, RwaDynamic | Error>;
  earnings: { json: unknown; broken: boolean };
}

async function harness(tickers: TickerOnChain[], at = REGULAR_AT, session: PublisherSnapshot["session"] = "REGULAR"): Promise<Harness> {
  const state = { at, session, tickers };
  const status = new Map<Address, AssetStatus | Error>();
  const dyn = new Map<Address, RwaDynamic | Error>();
  for (const t of tickers) {
    status.set(t.bStock, trading);
    if (t.ondo) dyn.set(t.ondo, dynamic());
  }
  const earnings = { json: { earnings: {} } as unknown, broken: false };
  const sender = new StubSender();
  const feed = new Feed({ dir: await mkdtemp(path.join(tmpdir(), "desk-pub-")), secrets: [], clock: () => state.at });
  const answer = <T>(m: Map<Address, T | Error>, a: string) => {
    const v = m.get(getAddress(a));
    if (v === undefined) throw new Error(`no stub for ${a}`);
    if (v instanceof Error) throw v;
    return v;
  };
  const publisher = new Publisher({
    deployment: d,
    reads: { snapshot: async () => ({ at: state.at, session: state.session, params, tickers: state.tickers }) },
    rwa: {
      assetStatus: async (_chain, a) => answer(status, a),
      dynamic: async (_chain, a) => answer(dyn, a),
    },
    sender,
    feed,
    earnings: async () => {
      if (earnings.broken) throw new Error("Unexpected token } in JSON");
      return parseEarnings(earnings.json);
    },
  });
  return { publisher, sender, feed, state, status, dyn, earnings };
}

describe("flagsFromStatus", () => {
  const s = (reasonCode: string | null, reasonMsg: string | null = null): AssetStatus => ({ openState: false, marketStatus: null, reasonCode, reasonMsg });
  it.each([
    ["TRADING", null, 0],
    ["MARKET_CLOSED", null, 0],
    ["ASSET_PAUSED", null, 1],
    ["MARKET_PAUSED", "Paused for session transition", 1],
    ["ASSET_PAUSED", "maintenance", 1],
    ["ASSET_PAUSED", "cash_dividend", 1 | 2],
    ["ASSET_PAUSED", "stock_dividend", 1 | 2],
    ["ASSET_PAUSED", "stock_split", 1 | 2],
    ["ASSET_PAUSED", "merger", 1 | 2],
    ["ASSET_PAUSED", "acquisition", 1 | 2],
    ["ASSET_PAUSED", "spinoff", 1 | 2],
    ["ASSET_PAUSED", "corporate action", 1 | 2],
    ["ASSET_PAUSED", " Corporate Action ", 1 | 2],
    ["ASSET_PAUSED", "Stock-Split", 1 | 2],
    ["ASSET_LIMITED", "earnings", 8 | 4],
    ["ASSET_LIMITED", "EARNINGS", 8 | 4],
    ["ASSET_LIMITED", "other", 8],
    [null, null, 0],
  ])("%s / %s -> %i", (code, msg, flags) => {
    expect(flagsFromStatus(s(code, msg))).toBe(flags);
  });

  it("treats a missing status as no flags", () => {
    expect(flagsFromStatus(null)).toBe(0);
    expect(flagsFromStatus(undefined)).toBe(0);
  });
});

describe("earnings schedule", () => {
  it("turns dates and timing into the regular open at which the gap is realised", () => {
    const s = parseEarnings({
      earnings: {
        NVDA: [{ date: "2026-10-07", timing: "amc" }], // Wednesday after the close -> Thursday's open
        TSLA: [{ date: "2026-10-08", timing: "bmo" }], // Thursday before the open -> Thursday's open
        META: [{ date: "2026-10-10", timing: "bmo" }], // a Saturday -> Monday's open
        AAPL: [{ realisedAt: 1_800_000_000 }],
      },
    });
    expect(nextEarningsFor(s, "NVDA", REGULAR_AT)).toBe(regularOpenAt(WED + 1));
    expect(nextEarningsFor(s, "TSLA", REGULAR_AT)).toBe(regularOpenAt(WED + 1));
    expect(nextEarningsFor(s, "META", REGULAR_AT)).toBe(regularOpenAt(WED + 5));
    expect(nextEarningsFor(s, "AAPL", REGULAR_AT)).toBe(1_800_000_000);
    expect(nextEarningsFor(s, "SPY", REGULAR_AT)).toBe(0);
  });

  it("picks the earliest date still ahead and forgets the past", () => {
    const s = parseEarnings({ earnings: { NVDA: [{ date: "2027-02-24", timing: "amc" }, { date: "2026-10-07", timing: "amc" }] } });
    expect(nextEarningsFor(s, "NVDA", REGULAR_AT)).toBe(regularOpenAt(WED + 1));
    expect(nextEarningsFor(s, "NVDA", regularOpenAt(WED + 1))).toBeGreaterThan(regularOpenAt(WED + 100));
  });

  it("loads the shipped schedule and rejects a missing file (an operator error, not an empty schedule)", async () => {
    expect(await loadEarnings(path.resolve(__dirname, "../../../config/earnings.json"))).toBeInstanceOf(Map);
    await expect(loadEarnings(path.join(tmpdir(), "no-such-earnings.json"))).rejects.toThrow(/earnings schedule/);
  });

  it("maps the shipped Q3 dates to the regular open where the gap lands, across the DST change", async () => {
    const s = await loadEarnings(path.resolve(__dirname, "../../../config/earnings.json"));
    const now = Date.UTC(2026, 9, 7) / 1000;
    expect(nextEarningsFor(s, "TSLA", now)).toBe(1_792_675_800); // amc Oct 21 -> Oct 22 09:30 EDT
    expect(nextEarningsFor(s, "AAPL", now)).toBe(1_793_367_000); // amc Oct 29 -> Oct 30 09:30 EDT
    expect(nextEarningsFor(s, "NVDA", now)).toBe(1_795_098_600); // amc Nov 18 -> Nov 19 09:30 EST
    expect(nextEarningsFor(s, "CRCL", now)).toBe(1_794_580_200); // bmo Nov 13 -> Nov 13 09:30 EST
    expect(nextEarningsFor(s, "SPY", now)).toBe(0);
  });

  it("rejects malformed files", () => {
    expect(() => parseEarnings({ earnings: { NVDA: [{ date: "07/10/2026" }] } })).toThrow(/NVDA/);
    expect(() => parseEarnings({ earnings: { NVDA: [{ date: "2026-10-07", timing: "noon" }] } })).toThrow(/timing/);
    expect(() => parseEarnings([])).toThrow();
  });
});

describe("Publisher", () => {
  let h: Harness;

  describe("overlay contents", () => {
    beforeEach(async () => {
      h = await harness([ticker("NVDA"), ticker("CRCL")]);
    });

    it("posts every listed symbol once, batched, with validUntil now + 5.5 h", async () => {
      const r = await h.publisher.tick();
      expect(h.sender.sims).toEqual([["NVDA", "CRCL"]]);
      expect(h.sender.sent).toHaveLength(1);
      const [nvda, crcl] = h.sender.sent[0]!.overlays;
      expect(nvda!.validUntil).toBe(BigInt(REGULAR_AT + VALIDITY_SEC));
      expect(VALIDITY_SEC).toBe(19_800);
      expect(nvda!.flags).toBe(0);
      expect(nvda!.ondoMultiplier).toBe(1_004n * 10n ** 15n);
      expect(crcl!.ondoMultiplier).toBe(1_004n * 10n ** 15n);
      expect(r.posted).toEqual(["NVDA", "CRCL"]);
      const ev = h.feed.list({ kind: "publish" })[0]!;
      expect(ev).toMatchObject({ source: "publisher", symbols: ["NVDA", "CRCL"], txHash: `0x${"ab".repeat(32)}`, sim: { via: "rpc", ok: true } });
    });

    it("sends a reference only for tickers without Chainlink, in the regular session", async () => {
      await h.publisher.tick();
      const [nvda, crcl] = h.sender.sent[0]!.overlays;
      expect(nvda!.referencePrice).toBe(0n);
      expect(crcl!.referencePrice).toBe(10_025_000_000n);
    });

    it("sends a zero reference outside the regular session", async () => {
      h = await harness([ticker("CRCL")], POST_AT, "POST");
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.referencePrice).toBe(0n);
    });

    it("holds the reference back in the last minutes before the close, where the tx could land after it", async () => {
      h = await harness([ticker("CRCL")], regularCloseAt(WED) - 120);
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.referencePrice).toBe(0n);
    });

    it("omits a reference too far from the on-chain per-share price and records a finding", async () => {
      h = await harness([ticker("CRCL", { perShare: 90n * E8 })]);
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.referencePrice).toBe(0n);
      expect(h.feed.list({ kind: "finding" })[0]).toMatchObject({ symbol: "CRCL", reason: expect.stringMatching(/reference/) });
    });

    it.each([
      ["1", "1000000000000000000"],
      ["1.01", "1010000000000000000"],
      ["0.999", "0"],
      ["1.0101", "0"],
    ])("bounds the Ondo multiplier %s to [sValue, sValue * 1.01] (posts %s)", async (m, posted) => {
      h.dyn.set(TOKENS.NVDA!.ondo, dynamic({ multiplier: m }));
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.ondoMultiplier).toBe(BigInt(posted));
      const findings = h.feed.list({ kind: "finding", account: undefined }).filter((e) => e.symbol === "NVDA");
      expect(findings.length).toBe(posted === "0" ? 1 : 0);
      if (posted === "0") expect(findings[0]!.reason).toMatch(/stale Ondo multiplier/);
    });

    it("omits the multiplier when the on-chain sValue is unreadable", async () => {
      h = await harness([ticker("NVDA", { ondoSValue: null })]);
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.ondoMultiplier).toBe(0n);
    });

    it("maps the bStock and Ondo statuses into flags", async () => {
      h.status.set(TOKENS.NVDA!.bStock, { openState: false, marketStatus: "pause", reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split" });
      h.dyn.set(TOKENS.CRCL!.ondo, dynamic({ status: { openState: true, marketStatus: "regular", reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" } }));
      await h.publisher.tick();
      const [nvda, crcl] = h.sender.sent[0]!.overlays;
      expect(nvda!.flags).toBe(1 | 2);
      expect(crcl!.flags).toBe(8 | 4);
    });

    it("re-sends nextEarnings on every post and clears it once the open has passed", async () => {
      h.earnings.json = { earnings: { NVDA: [{ date: "2026-10-07", timing: "amc" }] } };
      const realised = regularOpenAt(WED + 1);
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.nextEarnings).toBe(BigInt(realised));
      // A flags change five minutes later re-posts NVDA, again with the earnings timestamp.
      h.state.at += 300;
      h.status.set(TOKENS.NVDA!.bStock, { openState: false, marketStatus: null, reasonCode: "MARKET_PAUSED", reasonMsg: null });
      await h.publisher.tick();
      expect(h.sender.sent[1]!.symbols).toEqual(["NVDA"]);
      expect(h.sender.sent[1]!.overlays[0]!.nextEarnings).toBe(BigInt(realised));
      // After the open the schedule has nothing ahead: the post carries 0, which clears it on-chain.
      h.state.at = realised + 60;
      await h.publisher.tick();
      const last = h.sender.sent.at(-1)!;
      expect(last.symbols).toContain("NVDA");
      expect(last.overlays[last.symbols.indexOf("NVDA")]!.nextEarnings).toBe(0n);
    });
  });

  describe("change and heartbeat", () => {
    beforeEach(async () => {
      h = await harness([ticker("NVDA"), ticker("SPY")]);
      await h.publisher.tick();
      h.sender.sims = [];
      h.sender.sent = [];
    });

    it("sends nothing while nothing changed and the heartbeat is not due", async () => {
      for (const dt of [600, 3600, HEARTBEAT_SEC - 1]) {
        h.state.at = REGULAR_AT + dt;
        const r = await h.publisher.tick();
        expect(r.posted).toEqual([]);
      }
      expect(h.sender.sims).toEqual([]);
    });

    it("posts only the symbol that changed", async () => {
      h.state.at += 600;
      h.status.set(TOKENS.SPY!.bStock, { openState: false, marketStatus: null, reasonCode: "ASSET_PAUSED", reasonMsg: "cash_dividend" });
      await h.publisher.tick();
      expect(h.sender.sent.map((s) => s.symbols)).toEqual([["SPY"]]);
    });

    it("posts every symbol again at the 5 h heartbeat", async () => {
      h.state.at = REGULAR_AT + HEARTBEAT_SEC;
      await h.publisher.tick();
      expect(h.sender.sent.map((s) => s.symbols)).toEqual([["NVDA", "SPY"]]);
    });

    it("compares against the overlay on-chain after a restart", async () => {
      const posted = { validUntil: REGULAR_AT + VALIDITY_SEC, nextEarnings: 0, flags: 0, ondoMultiplier: 1_004n * 10n ** 15n, referencePrice: 0n, postedAt: REGULAR_AT };
      const fresh = await harness([ticker("NVDA", { overlay: posted })], REGULAR_AT + 600);
      await fresh.publisher.tick();
      expect(fresh.sender.sims).toEqual([]);
      fresh.state.tickers = [ticker("NVDA", { overlay: { ...posted, flags: 1 } })];
      await fresh.publisher.tick();
      expect(fresh.sender.sent.map((s) => s.symbols)).toEqual([["NVDA"]]);
    });

    it("skips a symbol whose RWA status is unavailable and records one finding", async () => {
      h.state.at = REGULAR_AT + HEARTBEAT_SEC;
      h.status.set(TOKENS.SPY!.bStock, new Error("HTTP 503"));
      await h.publisher.tick();
      h.state.at += 600;
      await h.publisher.tick();
      expect(h.sender.sent.map((s) => s.symbols)).toEqual([["NVDA"]]);
      expect(h.feed.list({ kind: "finding" }).filter((e) => e.symbol === "SPY")).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    const refOut = encodeErrorResult({ abi: sessionOracleAbi, errorName: "ReferenceOutOfBounds", args: [1n, 2n] });

    it("isolates the symbol that makes the batch revert, posts the rest and backs it off 30 min", async () => {
      h = await harness([ticker("NVDA"), ticker("CRCL"), ticker("SPY")]);
      h.sender.failing.set("CRCL", refOut);
      const r = await h.publisher.tick();
      expect(r.posted).toEqual(["NVDA", "SPY"]);
      expect(r.refused).toEqual(["CRCL"]);
      expect(h.sender.sent.map((s) => s.symbols)).toEqual([["NVDA", "SPY"]]);
      const refused = h.feed.list({ kind: "refused" });
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ symbol: "CRCL", error: { name: "ReferenceOutOfBounds" }, sim: { ok: false } });

      // Not retried inside the back-off, even though it is still due.
      h.sender.sims = [];
      h.state.at += 600;
      await h.publisher.tick();
      expect(h.sender.sims).toEqual([]);
      h.state.at = REGULAR_AT + BACKOFF_SEC;
      h.sender.failing.clear();
      await h.publisher.tick();
      expect(h.sender.sent.at(-1)!.symbols).toEqual(["CRCL"]);
    });

    it("re-isolates after an on-chain revert: the culprit backs off 30 min, the rest one tick", async () => {
      h = await harness([ticker("NVDA"), ticker("CRCL")]);
      h.sender.outcomes = [{ ok: true, txHash: `0x${"cd".repeat(32)}`, via: "rpc", status: "reverted", nonce: 1, gasPrice: 1n }];
      // The batch simulated fine but reverted when mined; now CRCL fails alone (the session closed meanwhile).
      const realSend = h.sender.send.bind(h.sender);
      h.sender.send = async (tx) => {
        h.sender.send = realSend;
        const r = await realSend(tx);
        h.sender.failing.set("CRCL", refOut);
        return r;
      };
      const r = await h.publisher.tick();
      expect(r.refused.sort()).toEqual(["CRCL", "NVDA"]);
      expect(h.feed.list({ kind: "refused" }).reverse().map((e) => [e.symbol, e.error?.name, e.txHash])).toEqual([
        ["NVDA", "Reverted", `0x${"cd".repeat(32)}`],
        ["CRCL", "ReferenceOutOfBounds", undefined],
      ]);
      h.sender.failing.clear();
      h.sender.sims = [];
      h.state.at += TICK_SEC;
      await h.publisher.tick();
      expect(h.sender.sent.at(-1)!.symbols).toEqual(["NVDA"]);
      h.state.at = REGULAR_AT + BACKOFF_SEC;
      await h.publisher.tick();
      expect(h.sender.sent.at(-1)!.symbols).toEqual(["CRCL"]);
    });

    it("re-isolates after a revert at gas estimation", async () => {
      h = await harness([ticker("NVDA"), ticker("CRCL")]);
      h.sender.outcomes = [{ ok: false, stage: "estimate", error: revertError(refOut)! }];
      const realSend = h.sender.send.bind(h.sender);
      h.sender.send = async (tx) => {
        const r = await realSend(tx);
        h.sender.failing.set("CRCL", refOut);
        return r;
      };
      await h.publisher.tick();
      expect(h.feed.list({ kind: "refused" }).reverse().map((e) => [e.symbol, e.data?.backoffUntil])).toEqual([
        ["NVDA", REGULAR_AT + TICK_SEC],
        ["CRCL", REGULAR_AT + BACKOFF_SEC],
      ]);
    });

    it("records a thrown broadcast failure as a refusal and retries next tick", async () => {
      h = await harness([ticker("NVDA")]);
      h.sender.outcomes = [new Error("broadcast failed: insufficient funds for gas")];
      const r = await h.publisher.tick();
      expect(r.refused).toEqual(["NVDA"]);
      expect(h.feed.list({ kind: "refused" })[0]).toMatchObject({ symbol: "NVDA", error: { name: "BroadcastFailed", message: expect.stringMatching(/insufficient funds/) } });
      h.state.at += TICK_SEC;
      await h.publisher.tick();
      expect(h.sender.sent).toHaveLength(2);
      expect(h.feed.list({ kind: "publish" })).toHaveLength(1);
    });

    it("records an unmined post as pending and posts again next tick (the send replaces it)", async () => {
      h = await harness([ticker("NVDA")]);
      h.sender.outcomes = [{ ok: true, txHash: `0x${"ef".repeat(32)}`, via: "rpc", status: "pending", nonce: 4, gasPrice: 1n, note: "not mined yet" }];
      await h.publisher.tick();
      expect(h.feed.list({ kind: "pending" })[0]).toMatchObject({ source: "publisher", symbols: ["NVDA"], txHash: `0x${"ef".repeat(32)}` });
      expect(h.feed.list({ kind: "publish" })).toEqual([]);
      h.state.at += TICK_SEC;
      await h.publisher.tick();
      expect(h.sender.sent).toHaveLength(2);
      expect(h.feed.list({ kind: "publish" })).toHaveLength(1);
    });

    it("records repeated simulator disagreements as a finding", async () => {
      h = await harness([ticker("NVDA")]);
      h.sender.disagree = true;
      for (let i = 0; i < 3; i++) {
        h.state.at = REGULAR_AT + i * HEARTBEAT_SEC;
        await h.publisher.tick();
      }
      expect(h.sender.sent).toHaveLength(3); // posts go with eth_call
      expect(h.feed.list({ kind: "finding" }).filter((e) => /disagreed/.test(e.reason ?? ""))).toHaveLength(1);
    });
  });

  describe("earnings source", () => {
    it("carries the on-chain nextEarnings forward until the schedule has loaded once", async () => {
      const onChain = regularOpenAt(WED + 1);
      const posted = { validUntil: REGULAR_AT + 600, nextEarnings: onChain, flags: 0, ondoMultiplier: 1_004n * 10n ** 15n, referencePrice: 0n, postedAt: REGULAR_AT - HEARTBEAT_SEC };
      h = await harness([ticker("NVDA", { overlay: posted })]);
      h.earnings.broken = true; // a broken file at startup
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.nextEarnings).toBe(BigInt(onChain));
      expect(h.feed.list({ kind: "finding" })[0]!.reason).toMatch(/earnings schedule unreadable/);
      // Fixed: the schedule now decides (here: nothing ahead clears it).
      h.earnings.broken = false;
      h.state.at += 600;
      await h.publisher.tick();
      expect(h.sender.sent.at(-1)!.overlays[0]!.nextEarnings).toBe(0n);
    });

    it("keeps the last good schedule when the file breaks later", async () => {
      h = await harness([ticker("NVDA")]);
      h.earnings.json = { earnings: { NVDA: [{ date: "2026-10-07", timing: "amc" }] } };
      await h.publisher.tick();
      h.earnings.broken = true;
      h.state.at = REGULAR_AT + HEARTBEAT_SEC;
      await h.publisher.tick();
      expect(h.sender.sent[1]!.overlays[0]!.nextEarnings).toBe(BigInt(regularOpenAt(WED + 1)));
    });
  });

  describe("Ondo data", () => {
    it("posts the bStock flags with no multiplier or reference when the Ondo feed fails", async () => {
      h = await harness([ticker("CRCL")]);
      h.status.set(TOKENS.CRCL!.bStock, { openState: false, marketStatus: null, reasonCode: "ASSET_PAUSED", reasonMsg: "merger" });
      h.dyn.set(TOKENS.CRCL!.ondo, new Error("HTTP 503"));
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]).toMatchObject({ flags: 1 | 2, ondoMultiplier: 0n, referencePrice: 0n });
      expect(h.feed.list({ kind: "finding" })[0]).toMatchObject({ symbol: "CRCL", reason: expect.stringMatching(/Ondo/) });
    });

    it("refreshes a reference after half the oracle's maxRefAge, not before", async () => {
      h = await harness([ticker("CRCL")]);
      await h.publisher.tick();
      expect(h.sender.sent[0]!.overlays[0]!.referencePrice).toBe(10_025_000_000n);
      h.state.at = REGULAR_AT + 3600; // an hour later, same print: no post
      await h.publisher.tick();
      expect(h.sender.sent).toHaveLength(1);
      const short = { ...params, maxRefAge: 3600 };
      const h2 = await harness([ticker("CRCL")]);
      h2.publisher = new Publisher({
        deployment: d,
        reads: { snapshot: async () => ({ at: h2.state.at, session: h2.state.session, params: short, tickers: h2.state.tickers }) },
        rwa: { assetStatus: async () => trading, dynamic: async () => dynamic() },
        sender: h2.sender,
        feed: h2.feed,
        earnings: async () => new Map(),
      });
      await h2.publisher.tick();
      h2.state.at += 1800; // maxRefAge / 2
      await h2.publisher.tick();
      expect(h2.sender.sent).toHaveLength(2);
    });
  });

  describe("loop hygiene", () => {
    it("skips a tick while the previous one is still running", async () => {
      h = await harness([ticker("NVDA")]);
      const [a, b] = await Promise.all([h.publisher.tick(), h.publisher.tick()]);
      expect([a.busy, b.busy]).toEqual([undefined, true]);
      expect(h.sender.sims).toHaveLength(1);
      expect((await h.publisher.tick()).busy).toBeUndefined();
    });

    it("alerts once when the desk key runs low on BNB", async () => {
      h = await harness([ticker("NVDA")]);
      h.sender.balance = async () => 10n ** 15n;
      const gas = new GasWatch({ sender: h.sender, feed: h.feed, minWei: 3n * 10n ** 15n });
      const p = new Publisher({
        deployment: d,
        reads: { snapshot: async () => ({ at: h.state.at, session: h.state.session, params, tickers: h.state.tickers }) },
        rwa: { assetStatus: async () => trading, dynamic: async () => dynamic() },
        sender: h.sender,
        feed: h.feed,
        earnings: async () => new Map(),
        gas,
      });
      await p.tick();
      h.state.at += 600;
      await p.tick();
      expect(h.feed.list({ kind: "alert" })).toMatchObject([{ source: "publisher", reason: expect.stringMatching(/below 0\.003 BNB/) }]);
    });
  });

  it("only simulates in DRY_RUN and does not repeat an unchanged dry-run post", async () => {
    h = await harness([ticker("NVDA")]);
    h.sender.dryRun = true;
    await h.publisher.tick();
    h.state.at += 600;
    await h.publisher.tick();
    expect(h.sender.sims).toEqual([["NVDA"]]);
    expect(h.sender.sent).toEqual([]);
    expect(h.feed.list({ kind: "publish" })).toMatchObject([{ dryRun: true, symbols: ["NVDA"] }]);
  });
});

describe("publisherDelaySec", () => {
  it("runs every 10 min and 3 min after a regular open or close (after the transition pause)", () => {
    expect(publisherDelaySec(REGULAR_AT)).toBe(600);
    expect(publisherDelaySec(regularCloseAt(WED) - 700)).toBe(600);
    expect(publisherDelaySec(regularCloseAt(WED) - 100)).toBe(280);
    expect(publisherDelaySec(regularOpenAt(WED) - 1)).toBe(181);
  });

  it("never lands a regular tick inside the transition pause", () => {
    const close = regularCloseAt(WED);
    for (const before of [600, 599, 500, 420, 300, 1]) {
      const next = close - before + publisherDelaySec(close - before);
      expect(next < close || next >= close + 180).toBe(true);
      expect(next).toBe(close + 180);
    }
  });
});
