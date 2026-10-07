/* The 121 Lista (Moolah) bStock liquidations, 18 June to 22 September 2026, placed on the New York week.
   Provenance: data/README.md. Every figure quoted on the landing page is derived here, not typed in. */
import rows from "../../../data/liquidations-week.json";
import type { Liquidation } from "./planisphere/types";

export const LIQUIDATIONS = rows as readonly Liquidation[];

const sum = (xs: readonly Liquidation[]) => xs.reduce((a, r) => a + r.usd, 0);

export function liquidationFacts(data: readonly Liquidation[] = LIQUIDATIONS) {
  const organic = data.filter((r) => r.g === "organic");
  const seeds = data.filter((r) => r.g === "seed");
  const organicUsd = sum(organic);
  const firstWindow = organic.filter((r) => r.t.includes("first 90"));
  const mondayOpen = data.filter((r) => r.t.includes("after weekend"));
  const mondayUsd = sum(mondayOpen);
  return {
    total: data.length,
    organic: organic.length,
    seeds: seeds.length,
    loans: data.filter((r) => r.g === "loan").length,
    bStockCollateral: data.length - data.filter((r) => r.g === "loan").length,
    weekend: data.filter((r) => r.s === "weekend").length,
    organicUsd,
    firstWindowUsd: sum(firstWindow),
    firstWindowShare: organicUsd ? sum(firstWindow) / organicUsd : 0,
    seedMinUsd: Math.min(...seeds.map((r) => r.usd)),
    seedMaxUsd: Math.max(...seeds.map((r) => r.usd)),
    mondayOpen,
    mondayUsd,
    mondayShare: organicUsd ? mondayUsd / organicUsd : 0,
  };
}

export const FACTS = liquidationFacts();

/** "$24.8k" */
export const kUsd = (usd: number) => `$${(usd / 1000).toFixed(1)}k`;
export const pct = (x: number) => `${Math.round(x * 100)}%`;
