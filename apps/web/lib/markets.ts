/* The markets Ballast can open a credit line or a cover on, from config/bsc-mainnet.json, and the PancakeSwap v3
   route a Lista account's keeper may deleverage through (built from the configured pools). Client-safe. */
import { bscConfig, tickers } from "@ballast/risk";
import { writes } from "@ballast/sdk";
import { getAddress, type Address, type Hex } from "viem";

export type VenueName = "lista" | "venus";

export interface CatalogMarket {
  /** "lista:NVDAB_USD1" or "venus:vNVDAB" */
  id: string;
  venue: VenueName;
  label: string;
  /** Session Oracle ticker, e.g. NVDA */
  symbol: string;
  collateralSymbol: string;
  loanSymbol: string;
  collateralToken: Address;
  loanToken: Address;
  /** Liquidation LTV from config (Lista); Venus thresholds are read from the chain. */
  configLltvBps: number | null;
  lista?: { marketId: Hex };
  venus?: { vCollateral: Address; vDebt: Address };
}

export interface DeleveragePath {
  hex: Hex;
  label: string;
}

const tokens = bscConfig.tokens as Record<string, string>;
const pools = bscConfig.pancake.pools as Record<string, string>;

function tickerFor(token: string) {
  return tickers.find((t) => t.bStock.toLowerCase() === token.toLowerCase()) ?? null;
}

function listaMarkets(): CatalogMarket[] {
  const out: CatalogMarket[] = [];
  const markets = bscConfig.lista.markets as Record<string, { id: string; collateralToken: string; lltv: string }>;
  for (const [key, m] of Object.entries(markets)) {
    const [collateralSymbol, loanSymbol] = key.split("_") as [string, string];
    const t = tickerFor(m.collateralToken);
    const loan = tokens[loanSymbol];
    if (!t || !loan) continue;
    out.push({
      id: `lista:${key}`,
      venue: "lista",
      label: `Lista ${collateralSymbol} / ${loanSymbol}`,
      symbol: t.symbol,
      collateralSymbol,
      loanSymbol,
      collateralToken: getAddress(m.collateralToken),
      loanToken: getAddress(loan),
      configLltvBps: Math.round(Number(BigInt(m.lltv) / 10n ** 14n)),
      lista: { marketId: m.id as Hex },
    });
  }
  return out;
}

function venusMarkets(): CatalogMarket[] {
  const v = bscConfig.venus as Record<string, string>;
  const vDebt = v.vUSDT;
  const usdt = tokens.USDT;
  if (!vDebt || !usdt) return [];
  const out: CatalogMarket[] = [];
  for (const [key, addr] of Object.entries(v)) {
    if (!/^v[A-Z]+B$/.test(key)) continue; // vNVDAB, vTSLAB: bStock collateral markets
    const collateralSymbol = key.slice(1);
    const t = tickers.find((x) => `${x.symbol}B` === collateralSymbol);
    if (!t) continue;
    out.push({
      id: `venus:${key}`,
      venue: "venus",
      label: `Venus ${collateralSymbol} / USDT`,
      symbol: t.symbol,
      collateralSymbol,
      loanSymbol: "USDT",
      collateralToken: getAddress(t.bStock),
      loanToken: getAddress(usdt),
      configLltvBps: null,
      venus: { vCollateral: getAddress(addr), vDebt: getAddress(vDebt) },
    });
  }
  return out;
}

export const MARKETS: readonly CatalogMarket[] = [...listaMarkets(), ...venusMarkets()];

export const marketById = (id: string) => MARKETS.find((m) => m.id === id) ?? null;

/** Display symbol of a token the catalog knows ("NVDAB", "USD1"), else null. */
export function tokenSymbol(token: string): string | null {
  for (const [sym, a] of Object.entries(tokens)) if (a.toLowerCase() === token.toLowerCase()) return sym;
  const t = tickerFor(token);
  return t ? `${t.symbol}B` : null;
}

function pool(a: string, b: string): number | null {
  for (const name of Object.keys(pools)) {
    const [x, y, fee] = name.split("_");
    if (fee && ((x === a && y === b) || (x === b && y === a))) return Number(fee);
  }
  return null;
}

const feePct = (fee: number) => `${(fee / 10_000).toFixed(2)}%`;

/**
 * The route the owner fixes with setDeleveragePath: collateral -> loan token directly, or through USDT, using
 * the configured PancakeSwap v3 pools. Null when no configured pool connects them.
 */
export function deleveragePathFor(m: Pick<CatalogMarket, "collateralSymbol" | "loanSymbol" | "collateralToken" | "loanToken">): DeleveragePath | null {
  const direct = pool(m.collateralSymbol, m.loanSymbol);
  if (direct !== null) {
    return {
      hex: writes.encodeV3Path([m.collateralToken, m.loanToken], [direct]),
      label: `${m.collateralSymbol} to ${m.loanSymbol} (${feePct(direct)} pool)`,
    };
  }
  const usdt = tokens.USDT;
  if (!usdt || m.loanSymbol === "USDT") return null;
  const first = pool(m.collateralSymbol, "USDT");
  const second = pool("USDT", m.loanSymbol);
  if (first === null || second === null) return null;
  return {
    hex: writes.encodeV3Path([m.collateralToken, getAddress(usdt), m.loanToken], [first, second]),
    label: `${m.collateralSymbol} to USDT (${feePct(first)} pool) to ${m.loanSymbol} (${feePct(second)} pool)`,
  };
}
