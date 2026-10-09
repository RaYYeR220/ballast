// @vitest-environment jsdom
/* The explorer on screen: what it shows with every source answering, and what it says (instead of filling in)
   when the oracle is not deployed, Binance is not configured, or a read fails. Plus the oracle route's new
   on-chain fields. */
import { tickers } from "@ballast/risk";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BandChart, chartSummary, verdict } from "../components/oracle/BandChart";
import { OracleExplorer, type OracleInitial } from "../components/oracle/OracleExplorer";
import { DESK_ADDRESS, IDENTITY_REGISTRY } from "../lib/identity";
import { closureChart, type CandlesBody, type PricesBody } from "../lib/market-view";
import type { OracleView } from "../lib/oracle-view";
import { readOracle } from "../lib/server/handlers/oracle";
import type { DeploymentStatus } from "../lib/server/deployment";
import { addr, DEPLOYMENT, fakeReads } from "./helpers";

const THU_CLOSE = 1_791_489_600;
const THU_1800 = 1_791_496_800;
const FRI_OPEN = 1_791_552_600;
const NVDA = tickers.find((t) => t.symbol === "NVDA")!;

class RO {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  // the explorer reads the wall clock when it mounts: pin it to Thursday 18:00 New York, a closed market
  vi.useFakeTimers({ toFake: ["Date"], now: THU_1800 * 1000 });
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "unavailable", detail: "the test has no network" }))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const closure = { kind: "overnight" as const, closedAt: THU_CLOSE, opensAt: FRI_OPEN, inProgress: true };
const prints = [{ at: THU_CLOSE - 2473, price: 229.975 }];
const candle = (i: number, o: number, h: number, l: number, c: number) => ({ t: THU_CLOSE + i * 3600, o, h, l, c, v: 100 });
const CANDLES = [candle(-1, 231, 232, 230, 231.5), candle(0, 231.5, 233, 230.5, 232), candle(1, 232, 244, 231, 233), candle(2, 233, 234, 232, 232.5), candle(3, 232.5, 233, 231, 231.2), candle(4, 231.2, 232, 230, 231)];
const chart = closureChart(closure, 417, CANDLES, prints, 1.000778223752807865, 93_600, THU_CLOSE + 5 * 3600);

const candlesBody: CandlesBody = { status: "ok", symbol: "NVDA", token: NVDA.bStock, fetchedAt: THU_1800, source: "market-api", multiplier: 1.000778223752807865, maxRefAgeSec: 93_600, referenceSource: "chainlink", closures: [chart] };

const venue = (v: "bstock" | "ondo" | "xstock", perShare: number, o: Partial<PricesBody extends { symbols: (infer S)[] } ? never : object> = {}) => ({
  venue: v,
  token: addr(1),
  platform: v === "xstock" ? null : v,
  tokenPrice: perShare,
  referencePrice: perShare,
  updatedAt: THU_1800 - 10,
  multiplier: 1,
  multiplierSource: v === "xstock" ? ("rebasing" as const) : v === "ondo" ? ("ondo-shares-oracle" as const) : ("bstock-token" as const),
  perShare,
  stale: false,
  ...o,
});
const pricesBody: PricesBody = {
  status: "ok",
  fetchedAt: THU_1800,
  blockNumber: "1000",
  symbols: tickers.map((t, i) => ({
    symbol: t.symbol,
    venues: i === 0 ? [venue("bstock", 231.12), venue("ondo", 231.18), { ...venue("xstock", 237.46), updatedAt: THU_1800 - 28 * 3600, stale: true }] : [],
    reference: i === 0 ? { price: 229.975, updatedAt: THU_CLOSE - 2473, feed: NVDA.chainlink } : null,
  })),
};

const snapshot = {
  symbol: "NVDA",
  at: THU_1800,
  session: "POST",
  rawPrice: "23127409643",
  perShare: "23109425339",
  reference: "22997500000",
  referenceUpdatedAt: THU_CLOSE - 2473,
  converged: true,
  devBps: 48,
  convergedReason: "OK",
  canAddRisk: false,
  reason: "NOT_REGULAR",
  reasonText: "the US market is not in its regular session",
  windowAhead: { window: "WEEKEND", startsAt: FRI_OPEN + 23_400, endsAt: FRI_OPEN + 259_200, gapBps: 737 },
  currentWindow: { window: "OVERNIGHT", gapBps: 417, closedAt: THU_CLOSE },
  overlay: { validUntil: THU_1800 + 3600, nextEarnings: 0, flags: 0, flagNames: [], ondoMultiplier: "0", referencePrice: "0", postedAt: THU_1800 - 600, fresh: true },
  params: { restoreDelay: 5400, horizon: 10800, convergenceBps: 60, maxRefAge: 93600, maxOverlayTtl: 21600, maxOndoDriftBps: 100, maxRefDeviationBps: 300 },
  band: { ok: true, lo: "21972799706", hi: "24057994693", bandBps: 453 },
};
const oracleBody: OracleView = {
  status: "ok",
  chainId: 56,
  blockNumber: "126520751",
  at: THU_1800,
  session: { at: THU_1800, blockNumber: "126520751", session: "POST", nextClose: FRI_OPEN + 23_400, nextOpen: FRI_OPEN, window: { kind: "WEEKEND", startsAt: FRI_OPEN + 23_400, endsAt: FRI_OPEN + 259_200 }, current: { kind: "OVERNIGHT", closedAt: THU_CLOSE, opensAt: FRI_OPEN } },
  symbols: [snapshot, { symbol: "SPY", error: "snapshot unreadable: rpc timeout" }],
  contracts: { sessionOracle: addr(0xa2), sessionAwareFeed: addr(0xa3), calendar: addr(0xa1) },
  publisher: { address: DESK_ADDRESS, agentId: "368122", identity: { agentId: "368122", registry: IDENTITY_REGISTRY, owner: DESK_ADDRESS, wallet: DESK_ADDRESS, matchesDesk: true } },
};

const initial = (o: Partial<OracleInitial>): OracleInitial => ({ now: THU_1800, oracle: null, prices: null, rwa: null, candles: null, ...o });

describe("the band chart", () => {
  it("draws every candle, marks the hour that left the band and says so in words", () => {
    const { container } = render(<BandChart chart={chart} symbol="NVDA" now={THU_CLOSE + 5 * 3600} />);
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(CANDLES.length);
    expect(container.querySelectorAll('[data-candle="outside"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-candle="open"]')).toHaveLength(1);
    expect(chartSummary(chart)).toBe("5 full hours so far: 1 traded outside the band, 0 closed outside it. For those hours the feed reads the band's edge, not the wick.");
    expect(screen.getByText(chartSummary(chart))).toBeTruthy();
    expect(verdict(chart.candles[2]!)).toMatch(/^Traded 1\.\d\d% above the band, closed back inside\.$/);
    expect(verdict(chart.candles[0]!)).toContain("Regular session");
  });

  it("reads each hour from the keyboard and lists all of them in a table", () => {
    const { container } = render(<BandChart chart={chart} symbol="NVDA" now={THU_CLOSE + 5 * 3600} />);
    const plot = screen.getByRole("group", { name: /arrow keys/ });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(container.querySelector("p[aria-live]")!.textContent).toContain("Thu 15:00: open $231.00");
    fireEvent.keyDown(plot, { key: "End" });
    expect(container.querySelector("p[aria-live]")!.textContent).toContain("Thu 20:00");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(container.querySelector("p[aria-live]")!.textContent).toBe(chartSummary(chart));
    const table = container.querySelector("details table")!;
    expect(within(table as HTMLElement).getAllByRole("row")).toHaveLength(CANDLES.length + 1);
    expect(table.querySelectorAll("tr[data-outside]")).toHaveLength(1);
  });

  it("draws candles alone and gives the reason when the band cannot be anchored", () => {
    const bare = closureChart(closure, 417, CANDLES, [], 1, 93_600, THU_1800);
    const { container } = render(<BandChart chart={bare} symbol="MSTR" now={THU_1800} />);
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(CANDLES.length);
    expect(container.querySelectorAll('[data-candle="outside"]')).toHaveLength(0);
    expect(screen.getByText(/No reference print reaches back to this close/)).toBeTruthy();
  });
});

describe("/oracle", () => {
  it("shows live figures with their sources when everything answers", () => {
    render(<OracleExplorer initial={initial({ oracle: oracleBody, prices: pricesBody, candles: candlesBody, rwa: { status: "ok", market: { marketStatus: "postmarket", openState: true }, assets: [{ symbol: "NVDA", token: NVDA.bStock, status: { openState: true, marketStatus: null, reasonCode: "TRADING", reasonMsg: null } }] } })} />);
    expect(screen.getByRole("heading", { name: "NVDA across the closure in progress" })).toBeTruthy();
    const reading = screen.getByRole("region", { name: "Reading now for NVDA" });
    expect(within(reading).getByText("$229.98")).toBeTruthy();
    expect(within(reading).getByText("Reference per share, from the Session Oracle")).toBeTruthy();
    expect(within(reading).getByText(/band \u00b14\.5%, \$219\.73 to \$240\.58 per token/)).toBeTruthy();
    expect(within(reading).getByText("No: not regular")).toBeTruthy();
    expect(within(reading).getByText("bStocks, Ondo")).toBeTruthy();
    expect(within(reading).getByText(/worst 1% gap of the weekend: 7\.4%/)).toBeTruthy();
    const table = screen.getByRole("region", { name: "All symbols" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getByText("$231.12")).toBeTruthy();
    expect(within(row).getByText("$237.46").closest("td")!.textContent).toContain("old");
    expect(within(row).getByText("Agreeing")).toBeTruthy();
    // a symbol the oracle could not read is not given another symbol's state
    expect(within(within(table).getAllByRole("row")[2]!).getByText("unreadable")).toBeTruthy();
    const chain = screen.getByRole("region", { name: "The Session Oracle on chain" });
    expect(within(chain).getByText("Agent 368122").getAttribute("href")).toBe(`https://bscscan.com/nft/${IDENTITY_REGISTRY}/368122`);
    expect(within(chain).getByText("Same key as the publisher")).toBeTruthy();
    expect(within(chain).getByText(/1 of 1 valid/).textContent).toContain("1 unreadable");
    expect(screen.getByRole("status").textContent).toBe("2 of 3 venues fresh for NVDA");
  });

  it("says the oracle is not deployed and Binance is not configured, and shows no figure in their place", () => {
    render(
      <OracleExplorer
        initial={initial({
          oracle: { status: "not-deployed", detail: "no deployment file for chain 56" },
          prices: { status: "not-configured", detail: "the Binance Web3 API key is not configured on this server" },
          candles: { status: "unavailable", detail: "Binance candles unavailable: no API key on this server; keyless klines: fetch failed" },
          rwa: { status: "unavailable", detail: "fetch failed" },
        })}
      />,
    );
    expect(screen.getByText("The Session Oracle is not deployed on this chain yet")).toBeTruthy();
    expect(screen.getByText("Not deployed yet", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Binance key not configured")).toBeTruthy();
    expect(screen.getByText("No candles to draw")).toBeTruthy();
    expect(screen.getByText(/keyless klines: fetch failed/)).toBeTruthy();
    const reading = screen.getByRole("region", { name: "Reading now for NVDA" });
    expect(within(reading).getByText("No reference")).toBeTruthy();
    expect(within(reading).getByText("Status unavailable")).toBeTruthy();
    // closed at 18:00 on Thursday: the band is the contract's rule, labelled as such, never a made-up reading
    expect(within(reading).getByText(/by the contract's rule/)).toBeTruthy();
    const table = screen.getByRole("region", { name: "All symbols" });
    expect(table.querySelector("tbody")!.textContent).not.toMatch(/\$\d/);
    expect(screen.getByRole("status").textContent).toBe("Binance prices unavailable");
  });

  it("reports a failed chain read as a failure, not as an empty oracle", () => {
    render(<OracleExplorer initial={initial({ oracle: { status: "unavailable", detail: "chain read failed: no answer within 20 s" } })} />);
    expect(screen.getByText("The Session Oracle could not be read")).toBeTruthy();
    expect(screen.getByText(/no answer within 20 s/)).toBeTruthy();
    expect(screen.getByText("Loading NVDAB candles from Binance.")).toBeTruthy();
  });

  it("asks for another symbol's candles when it is picked and never shows the old symbol's chart under its name", async () => {
    render(<OracleExplorer initial={initial({ candles: candlesBody })} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Symbol" })).getByRole("button", { name: "TSLA" }));
    expect(screen.getByRole("heading", { name: "TSLA across the last closure" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/market/candles?symbol=TSLA")).toBe(true);
    expect(await screen.findByText("No candles to draw")).toBeTruthy();
    expect(screen.getByText("the test has no network")).toBeTruthy();
  });
});

describe("GET /api/oracle, on-chain additions", () => {
  const OK: DeploymentStatus = { ok: true, chainId: 31337, deployment: DEPLOYMENT, source: "test" };
  const base = {
    session: 6,
    nextClose: BigInt(FRI_OPEN + 23_400),
    nextOpen: BigInt(FRI_OPEN),
    nextWindow: [2, BigInt(FRI_OPEN + 23_400), BigInt(FRI_OPEN + 259_200)],
    [`currentWindow@${addr(0xa1).toLowerCase()}`]: [1, BigInt(THU_CLOSE), BigInt(FRI_OPEN)],
    rawPrice: [23_127_409_643n, true],
    perSharePrice: [23_109_425_339n, true],
    referenceFor: [22_997_500_000n, BigInt(THU_CLOSE - 2473), true],
    converged: [true, 48n, 0],
    canAddRisk: [false, 3],
    windowAhead: [2, BigInt(FRI_OPEN + 23_400), BigInt(FRI_OPEN + 259_200), 737],
    [`currentWindow@${addr(0xa2).toLowerCase()}`]: [1, 417, BigInt(THU_CLOSE)],
    overlay: { validUntil: BigInt(THU_1800 + 3600), nextEarnings: 0n, flags: 0, ondoMultiplier: 0n, referencePrice: 0n, postedAt: BigInt(THU_1800 - 600) },
    params: [5400, 10800, 60, 93600, 21600, 100, 300],
  };

  it("adds the feed's band per symbol and the publisher with its ERC-8004 record", async () => {
    const { client } = fakeReads(
      { ...base, band: [21_972_799_706n, 24_057_994_693n, 453n, true], publisher: DESK_ADDRESS, publisherAgentId: 368_122n, ownerOf: DESK_ADDRESS, getAgentWallet: DESK_ADDRESS },
      { timestamp: BigInt(THU_1800) },
    );
    const body = await readOracle(client, OK);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.symbols[0]).toMatchObject({ symbol: "NVDA", reason: "NOT_REGULAR", band: { ok: true, lo: "21972799706", hi: "24057994693", bandBps: 453 } });
    expect(body.publisher).toEqual({ address: DESK_ADDRESS, agentId: "368122", identity: { agentId: "368122", registry: IDENTITY_REGISTRY, owner: DESK_ADDRESS, wallet: DESK_ADDRESS, matchesDesk: true } });
    expect(body.contracts).toEqual({ sessionOracle: DEPLOYMENT.sessionOracle, sessionAwareFeed: DEPLOYMENT.sessionAwareFeed, calendar: DEPLOYMENT.calendar });
  });

  it("keeps the snapshots when the band or the publisher cannot be read, each with its own error", async () => {
    const { client } = fakeReads({ ...base, band: new Error("execution reverted"), publisher: new Error("rpc timeout"), publisherAgentId: 0n }, { timestamp: BigInt(THU_1800) });
    const body = await readOracle(client, OK);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.symbols).toHaveLength(tickers.length);
    expect(body.symbols[0]).toMatchObject({ symbol: "NVDA", canAddRisk: false, band: { error: expect.stringContaining("band unreadable") } });
    expect(body.publisher).toMatchObject({ address: null, agentId: null, error: expect.stringContaining("rpc timeout") });
  });

  it("flags an identity that belongs to another key", async () => {
    const { client } = fakeReads({ ...base, band: [0n, 0n, 0n, false], publisher: DESK_ADDRESS, publisherAgentId: 7n, ownerOf: addr(0x99), getAgentWallet: new Error("no wallet") }, { timestamp: BigInt(THU_1800) });
    const body = await readOracle(client, OK);
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.publisher!.identity).toMatchObject({ agentId: "7", owner: addr(0x99), wallet: null, matchesDesk: false });
    expect(body.symbols[0]).toMatchObject({ band: { ok: false } });
  });
});
