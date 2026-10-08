/* What the keyed Binance Web3 API tells the app about a wallet: the tokenized stocks it holds (Wallet API) and
   its lending positions on Lista and Venus (DeFi API). Both answers are read defensively (the shapes are
   Binance's, not ours), matched only against the configured tickers and markets, and bounded in size. */
import { defi, wallet, type Web3Client } from "@ballast/binance";
import { bscConfig, tickers } from "@ballast/risk";
import { getAddress, isAddress, type Address } from "viem";
import { MARKETS } from "@/lib/markets";
import type { DefiLending, HeldStock } from "@/lib/views";
import { BINANCE_BSC } from "./binance";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max = 64) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : "");
const decimal = (v: unknown) => (/^\d+(\.\d+)?$/.test(text(v)) ? text(v) : null);

const ISSUERS = ["bStock", "ondo", "xStock"] as const;
const ISSUER_NAME = { bStock: "bStock", ondo: "Ondo", xStock: "xStock" } as const;

/** Every configured stock token by address: its ticker, issuer and, for a bStock with one, its market. */
export const STOCK_TOKENS: ReadonlyMap<string, { symbol: string; issuer: HeldStock["issuer"]; token: Address; market: HeldStock["market"] }> = new Map(
  tickers.flatMap((t) =>
    ISSUERS.map((k) => {
      const token = getAddress(t[k]);
      const m = k === "bStock" ? MARKETS.filter((x) => x.collateralToken === token) : [];
      return [token.toLowerCase(), { symbol: t.symbol, issuer: ISSUER_NAME[k], token, market: m[0] ? { id: m[0].id, label: m.map((x) => x.label).join(", ") } : null }] as const;
    }),
  ),
);

/** Pages of the Wallet API balance list read per request, and rows per page. */
const BALANCE_PAGES = 3;
const BALANCE_PAGE_SIZE = 50;

/** The tokenized stocks among Wallet API balance rows (configured tickers only), largest value first. */
export function matchStocks(assets: readonly unknown[]): HeldStock[] {
  const out: HeldStock[] = [];
  for (const a of assets) {
    if (!isObj(a) || !isAddress(text(a.tokenContractAddress), { strict: false })) continue;
    const known = STOCK_TOKENS.get(text(a.tokenContractAddress).toLowerCase());
    const raw = text(a.rawBalance, 80);
    if (!known || !/^\d+$/.test(raw) || BigInt(raw) === 0n) continue;
    out.push({ ...known, tokenSymbol: text(a.symbol, 16) || `${known.symbol}`, rawBalance: raw, priceUsd: decimal(a.tokenPrice) });
  }
  const value = (s: HeldStock) => (Number(s.rawBalance) / 1e18) * Number(s.priceUsd ?? 0);
  return out.sort((x, y) => value(y) - value(x)).slice(0, STOCK_TOKENS.size);
}

/** Wallet API all-token-balances for one address on BNB Chain, at most BALANCE_PAGES pages. */
export async function walletStocks(web3: Web3Client, user: Address): Promise<HeldStock[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= BALANCE_PAGES; page++) {
    const data = await wallet.allTokenBalances(web3, { address: user, chains: BINANCE_BSC, page, pageSize: BALANCE_PAGE_SIZE });
    const pages = Array.isArray(data) ? data : [data];
    let got = 0;
    for (const p of pages) {
      const assets = list(isObj(p) ? p.tokenAssets : undefined);
      got += assets.length;
      rows.push(...assets.slice(0, BALANCE_PAGE_SIZE));
    }
    if (got < BALANCE_PAGE_SIZE) break;
  }
  return matchStocks(rows);
}

const LENDING: Record<string, DefiLending["venue"]> = { helio: "lista", venus: "venus", venusflux: "venus" };
const LENDING_NAME: Record<string, string> = { helio: "Lista", venus: "Venus", venusflux: "Venus Flux" };

function tokens(tokenList: unknown): { borrowed: string[]; supplied: string[] } {
  const borrowed: string[] = [];
  const supplied: string[] = [];
  const add = (role: string, t: unknown) => {
    if (!isObj(t)) return;
    const symbol = text(t.tokenSymbol ?? t.symbol, 16);
    const n = Number(decimal(t.tokenAmount ?? t.amount ?? t.balance) ?? "NaN");
    if (!symbol) return;
    const label = Number.isFinite(n) ? `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })} ${symbol}` : symbol;
    if (/borrow|debt/i.test(role)) borrowed.push(label);
    else if (/suppl|collateral|deposit/i.test(role)) supplied.push(label);
  };
  // the breakdown is { supply: [...], borrow: [...] } (seen live); rows that name their own role are read too
  if (isObj(tokenList)) for (const [role, rows] of Object.entries(tokenList)) for (const t of list(rows).slice(0, 8)) add(role, t);
  else for (const t of list(tokenList).slice(0, 16)) add(isObj(t) ? text(t.type ?? t.role ?? t.tokenType) : "", t);
  return { borrowed, supplied };
}

/** the contracts a lending pool of ours is reported under: the Lista market contract and the Venus comptroller */
const KNOWN_POOLS = new Set([bscConfig.lista.moolah, bscConfig.venus.comptroller].map((a) => a.toLowerCase()));

/**
 * Lista and Venus lending pools in a DeFi API position list (addressList > protocolList > poolList >
 * positionCollectionList > positionList > tokenList). Staking and other pool types are left out; a protocol
 * is listed when it has a lending pool or reports a borrow.
 */
export function lendingPositions(data: unknown): DefiLending[] {
  const out: DefiLending[] = [];
  for (const a of list(isObj(data) ? data.addressList : undefined).slice(0, 2)) {
    for (const p of list(isObj(a) ? a.protocolList : undefined).slice(0, 50)) {
      if (!isObj(p)) continue;
      const id = text(p.defiProtocolId).toLowerCase();
      const venue = LENDING[id];
      if (!venue) continue;
      const borrowed: string[] = [];
      const supplied: string[] = [];
      let onOurMarkets = false;
      for (const pool of list(p.poolList).slice(0, 20)) {
        if (!isObj(pool)) continue;
        const t = { borrowed: [] as string[], supplied: [] as string[] };
        for (const col of list(pool.positionCollectionList).slice(0, 20)) {
          for (const pos of list(isObj(col) ? col.positionList : undefined).slice(0, 20)) {
            const x = tokens(isObj(pos) ? pos.tokenList : undefined);
            t.borrowed.push(...x.borrowed);
            t.supplied.push(...x.supplied);
          }
        }
        if (!/lend/i.test(text(pool.poolType)) && t.borrowed.length === 0) continue;
        if (KNOWN_POOLS.has(text(pool.poolCa).toLowerCase())) onOurMarkets = true;
        borrowed.push(...t.borrowed);
        supplied.push(...t.supplied);
      }
      if (borrowed.length === 0 && supplied.length === 0) continue;
      out.push({ venue, protocol: LENDING_NAME[id] ?? id, valueUsd: decimal(p.protocolTotalValue), borrowed: borrowed.slice(0, 6), supplied: supplied.slice(0, 6), onOurMarkets });
    }
  }
  return out.slice(0, 10);
}

/** DeFi API positions of one wallet on BNB Chain, reduced to its Lista and Venus lending positions. */
export async function walletLending(web3: Web3Client, user: Address): Promise<DefiLending[]> {
  return lendingPositions(await defi.positions(web3, [user], [BINANCE_BSC]));
}
