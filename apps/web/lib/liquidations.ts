/* The 121 Lista (Moolah) bStock liquidations, 18 June to 22 September 2026, placed on the New York week.
   Provenance: data/README.md. Every liquidation figure on the landing page is computed here from that file. */
import rows from "../../../data/liquidations-week.json";
import { dayNumber, holidayFor, typicalWeekSectors, type ShareKind } from "./planisphere/sessions";
import type { Liquidation, LiquidationRow } from "./planisphere/types";

/** Derive the fields the page reads from a stored row. */
export function withDerived(r: LiquidationRow): Liquidation {
  const first90 = r.g === "organic" && r.t.startsWith("regular: first 90");
  const date = /\d{4}-\d{2}-\d{2}/.exec(r.et)?.[0];
  return {
    ...r,
    first90,
    afterLongClose: first90 && r.t.includes("after weekend/holiday"),
    holiday: r.s === "holiday" && date ? holidayFor(dayNumber(date)) : null,
  };
}

export const LIQUIDATIONS: readonly Liquidation[] = (rows as readonly LiquidationRow[]).map(withDerived);

const PLAIN_WEEK = typicalWeekSectors();
const WEEKEND = PLAIN_WEEK.find((s) => s.kind === "weekend")!;

const SHARE_OF_ROW: Record<LiquidationRow["s"], ShareKind> = {
  regular: "regular",
  pre: "prePost",
  post: "prePost",
  overnight: "overnight",
  holiday: "holiday",
  weekend: "weekend",
};

const sum = (xs: readonly Liquidation[]) => xs.reduce((a, r) => a + r.usd, 0);

export function liquidationFacts(data: readonly Liquidation[] = LIQUIDATIONS) {
  const organic = data.filter((r) => r.g === "organic");
  const seeds = data.filter((r) => r.g === "seed");
  const collateral = data.filter((r) => r.g !== "loan");
  const organicUsd = sum(organic);
  const firstWindow = organic.filter((r) => r.first90);
  const mondayOpen = organic.filter((r) => r.afterLongClose);
  const mondayUsd = sum(mondayOpen);
  const collateralUsd = sum(collateral);
  const dollarShares: Record<ShareKind, number> = { regular: 0, prePost: 0, overnight: 0, holiday: 0, weekend: 0 };
  for (const r of collateral) dollarShares[SHARE_OF_ROW[r.s]] += collateralUsd ? r.usd / collateralUsd : 0;
  return {
    total: data.length,
    organic: organic.length,
    seeds: seeds.length,
    loans: data.length - collateral.length,
    bStockCollateral: collateral.length,
    /** bStock-collateral rows between Friday 20:00 and Sunday 20:00 New York, by hour of the week */
    weekend: collateral.filter((r) => r.h >= WEEKEND.h0 && r.h < WEEKEND.h1).length,
    organicUsd,
    firstWindowUsd: sum(firstWindow),
    firstWindowShare: organicUsd ? sum(firstWindow) / organicUsd : 0,
    seedMinUsd: Math.min(...seeds.map((r) => r.usd)),
    seedMaxUsd: Math.max(...seeds.map((r) => r.usd)),
    mondayOpen,
    mondayUsd,
    mondayShare: organicUsd ? mondayUsd / organicUsd : 0,
    collateralUsd,
    /** share of bStock-collateral dollars repaid in each session */
    dollarShares,
  };
}

export const FACTS = liquidationFacts();

/** "$24.8k" */
export const kUsd = (usd: number) => `$${(usd / 1000).toFixed(1)}k`;
export const pct = (x: number) => `${Math.round(x * 100)}%`;
/** one decimal, as the chart labels print it: "18.4" */
export const pct1 = (x: number) => (Math.round(x * 1000) / 10).toFixed(1);
