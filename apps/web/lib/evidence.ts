/* The tables of the evidence page. Every figure is computed here from data/liquidations-week.json,
   data/backtest-lltv75.json, config/bsc-mainnet.json and the NYSE calendar; nothing is typed in. */
import { tickers } from "@ballast/risk";
import backtest from "../../../data/backtest-lltv75.json";
import { SAMPLE_CLOCK } from "./clock";
import { LIQUIDATIONS } from "./liquidations";
import type { ShareKind } from "./planisphere/sessions";
import type { Liquidation } from "./planisphere/types";

export interface SessionRow {
  key: ShareKind | "total";
  name: string;
  /** share of the sample period's clock, from the calendar */
  clockShare: number;
  /** bStock-collateral liquidations */
  count: number;
  /** of them from real borrowers */
  organic: number;
  /** USD repaid in the organic ones */
  organicUsd: number;
  /** USD repaid in all of them */
  usd: number;
  /** share of all USD repaid */
  usdShare: number;
}

const GROUP_OF: Record<Liquidation["s"], ShareKind> = { regular: "regular", pre: "prePost", post: "prePost", overnight: "overnight", holiday: "holiday", weekend: "weekend" };
const NAMES: [ShareKind, string][] = [
  ["regular", "Regular session"],
  ["prePost", "Pre-market and after hours"],
  ["overnight", "Overnight"],
  ["holiday", "Holiday"],
  ["weekend", "Weekend"],
];

const sum = (xs: readonly Liquidation[]) => xs.reduce((a, r) => a + r.usd, 0);

/** One row per session group over the bStock-collateral liquidations, and a total row. */
export function sessionRows(data: readonly Liquidation[] = LIQUIDATIONS, clock: Record<ShareKind, number> = SAMPLE_CLOCK): SessionRow[] {
  const collateral = data.filter((r) => r.g !== "loan");
  const all = sum(collateral);
  const row = (key: SessionRow["key"], name: string, rows: readonly Liquidation[], clockShare: number): SessionRow => {
    const organic = rows.filter((r) => r.g === "organic");
    return { key, name, clockShare, count: rows.length, organic: organic.length, organicUsd: sum(organic), usd: sum(rows), usdShare: all ? sum(rows) / all : 0 };
  };
  return [...NAMES.map(([key, name]) => row(key, name, collateral.filter((r) => GROUP_OF[r.s] === key), clock[key])), row("total", "All sessions", collateral, 1)];
}

export interface TimingRow {
  name: string;
  count: number;
  usd: number;
  share: number;
}

/** Where inside the day real borrowers lost money: the first 90 minutes after an open against everything else. */
export function timingRows(data: readonly Liquidation[] = LIQUIDATIONS): TimingRow[] {
  const organic = data.filter((r) => r.g === "organic");
  const total = sum(organic);
  const mk = (name: string, rows: readonly Liquidation[]): TimingRow => ({ name, count: rows.length, usd: sum(rows), share: total ? sum(rows) / total : 0 });
  const afterLong = organic.filter((r) => r.afterLongClose);
  const first90 = organic.filter((r) => r.first90 && !r.afterLongClose);
  const laterRegular = organic.filter((r) => r.s === "regular" && !r.first90);
  const closed = organic.filter((r) => r.s !== "regular");
  return [
    mk("First 90 minutes after a weekend or holiday", afterLong),
    mk("First 90 minutes after an ordinary night", first90),
    mk("Later in the regular session", laterRegular),
    mk("While New York was closed", closed),
    mk("All organic liquidations", organic),
  ];
}

/** The largest liquidations of real borrowers, largest first. */
export const largestOrganic = (n: number, data: readonly Liquidation[] = LIQUIDATIONS): Liquidation[] =>
  data
    .filter((r) => r.g === "organic")
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n);

export interface BacktestRow {
  startLtv: number;
  windows: number;
  unprotectedLiquidations: number;
  protectedLiquidations: number;
  shieldsTriggered: number;
  avgRepayShareOfDebt: number;
  byType: Record<string, { windows: number; unprotected: number; protected: number }>;
}

export const BACKTEST: { lltv: number; targetHfAfterGap: number; results: BacktestRow[] } = backtest;

export const BACKTEST_TYPES: [string, string][] = [
  ["overnight", "Overnight"],
  ["weekend", "Weekend"],
  ["long_weekend_holiday", "Holiday"],
];

/** The gap each ticker's loans are sized for, as configured and set on the Session Oracle (bps). */
export const GAP_TABLE = tickers.map((t) => ({ symbol: t.symbol, ...t.gapBps }));
