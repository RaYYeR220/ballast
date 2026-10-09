/* Chain reads behind the app's routes: a wallet's Ballast accounts and covers, its own Lista/Venus loans (for a
   cover), the configured markets with their live parameters, and one token's balance and allowance. Every read
   in one answer is pinned to one block, and every answer is bounded: by the configuration (markets, tickers,
   tokens) or by LIMITS, never by how much state exists on chain or by a range the caller supplies. */
import { listaDebt } from "@ballast/risk";
import {
  accountState,
  bytes32ToSymbol,
  comptrollerAbi,
  cushionVaultAbi,
  listAccounts,
  moolahAbi,
  oracleSnapshot,
  vTokenAbi,
  venueName,
  venusOracleAbi,
  type Deployment,
  type ExternalAddresses,
  type OracleSnapshot,
  type ReadClient,
} from "@ballast/sdk";
import { encodeAbiParameters, erc20Abi, formatUnits, getAddress, keccak256, type Address, type Hex } from "viem";
import { deleveragePathFor, MARKETS, tokenSymbol, type CatalogMarket } from "@/lib/markets";
import type { AccountView, CoverView, HeldStock, LoanView, MarketParamsView, MarketView, TokenView } from "@/lib/views";
import { STOCK_TOKENS } from "./binance-data";
import { LIMITS } from "./limits";
import { shortMessage } from "./simulate";
import { accountView } from "./views";

type Client = ReadClient;

export interface Head {
  blockNumber: bigint;
  /** unix seconds of that block */
  at: number;
}

const heads = new WeakMap<object, { at: number; v?: Head; inflight?: Promise<Head> }>();

/**
 * The head block, re-read at most every LIMITS.headTtlMs per client with one request in flight. Per-wallet
 * answers are cached by this block, so identical requests inside one head cost one round of reads.
 */
export function head(c: Client, clock: () => number = Date.now): Promise<Head> {
  const memo = heads.get(c);
  if (memo?.v && clock() - memo.at < LIMITS.headTtlMs) return Promise.resolve(memo.v);
  if (memo?.inflight) return memo.inflight;
  const inflight = c
    .getBlock({ blockTag: "latest" })
    .then((b) => {
      const v = { blockNumber: b.number as bigint, at: Number(b.timestamp) };
      heads.set(c, { at: clock(), v });
      return v;
    })
    .catch((err) => {
      heads.delete(c);
      throw err;
    });
  heads.set(c, { at: memo?.at ?? 0, v: memo?.v, inflight });
  return inflight;
}

/** A memo map that never grows past LIMITS.memoEntries (oldest dropped first). */
function boundedMemo<V>() {
  const m = new Map<string, V>();
  return {
    get: (k: string) => m.get(k),
    set(k: string, v: V) {
      m.set(k, v);
      while (m.size > LIMITS.memoEntries) m.delete(m.keys().next().value as string);
    },
  };
}

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

const decimalsMemo = boundedMemo<number>();
async function decimalsOf(c: Client, token: Address): Promise<number> {
  const k = token.toLowerCase();
  const hit = decimalsMemo.get(k);
  if (hit !== undefined) return hit;
  const d = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  decimalsMemo.set(k, d);
  return d;
}

type Mp = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };

const mpView = (mp: Mp): MarketParamsView => ({
  loanToken: mp.loanToken,
  collateralToken: mp.collateralToken,
  oracle: mp.oracle,
  irm: mp.irm,
  lltv: mp.lltv.toString(),
});

/** CushionVault cover key of a Lista loan: keccak256(abi.encode(VENUE_LISTA, marketParams)). */
export const listaCoverKey = (mp: Mp): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] }],
      [1, [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv]],
    ),
  );

/** CushionVault cover key of a Venus loan: keccak256(abi.encode(VENUE_VENUS, vDebt)). */
export const venusCoverKey = (vDebt: Address): Hex => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [2, vDebt]));

const paramsMemo = boundedMemo<Mp>();
async function listaParams(c: Client, moolah: Address, id: Hex): Promise<Mp> {
  const hit = paramsMemo.get(id);
  if (hit) return hit;
  const r = await c.readContract({ address: moolah, abi: moolahAbi, functionName: "idToMarketParams", args: [id] });
  const mp = { loanToken: r[0], collateralToken: r[1], oracle: r[2], irm: r[3], lltv: r[4] };
  if (mp.loanToken === "0x0000000000000000000000000000000000000000") throw new Error(`Lista market ${id} is not created`);
  paramsMemo.set(id, mp);
  return mp;
}

// ----------------------------------------------------------------- accounts

/**
 * The wallet's covers on the configured markets, read by key. A cover's key is derived from its market, so each
 * is one `cover(user, key)` read: the vault's whole cover list (which anyone can grow) is never walked.
 */
export async function readCovers(c: Client, d: Deployment, user: Address, blockNumber: bigint, errors: string[]): Promise<CoverView[]> {
  const keys = new Set<Hex>();
  await Promise.all(
    MARKETS.map(async (m) => {
      try {
        if (m.lista) keys.add(listaCoverKey(await listaParams(c, d.external.moolah, m.lista.marketId)));
        else if (m.venus) keys.add(venusCoverKey(m.venus.vDebt));
      } catch (err) {
        errors.push(`the cover on ${m.label} could not be looked up: ${shortMessage(err)}`);
      }
    }),
  );
  const found = await Promise.all(
    [...keys].map(async (key) => {
      try {
        const cv = await c.readContract({ address: d.cushionVault, abi: cushionVaultAbi, blockNumber, functionName: "cover", args: [user, key] });
        return cv.venue === 0 ? null : { key, cv };
      } catch (err) {
        errors.push(`a cover could not be read: ${shortMessage(err)}`);
        return null;
      }
    }),
  );
  return Promise.all(
    found
      .flatMap((f) => (f ? [f] : []))
      .map(async ({ key, cv }): Promise<CoverView> => {
        const venue = venueName(cv.venue);
        const symbol = bytes32ToSymbol(cv.symbol);
        const label =
          venue === "lista"
            ? `Lista ${tokenSymbol(cv.mp.collateralToken) ?? `${symbol}B`} / ${tokenSymbol(cv.mp.loanToken) ?? "loan"}`
            : `Venus ${symbol}B / ${tokenSymbol(cv.token) ?? "loan"}`;
        return {
          user,
          key,
          venue,
          symbol,
          token: cv.token,
          tokenSymbol: tokenSymbol(cv.token) ?? "tokens",
          tokenDecimals: await decimalsOf(c, cv.token),
          keeper: cv.keeper,
          capPerDay: cv.capPerDay.toString(),
          balance: cv.balance.toString(),
          dayStart: Number(cv.dayStart),
          usedToday: cv.usedToday.toString(),
          label,
        };
      }),
  );
}

export interface AccountsPage {
  blockNumber: string;
  at: number;
  accounts: AccountView[];
  /** credit lines the owner has in all */
  total: number;
  offset: number;
  /** older credit lines exist beyond this page */
  more: boolean;
  covers: CoverView[];
  errors: string[];
}

/**
 * One page of the owner's credit lines, newest first: at most LIMITS.accountsPerPage accounts are read however
 * many the owner has opened, LIMITS.accountConcurrency at a time.
 */
export async function readAccounts(c: Client, d: Deployment, owner: Address, o: { offset?: number; head?: Head } = {}): Promise<AccountsPage> {
  const { blockNumber, at } = o.head ?? (await head(c));
  const offset = Math.max(0, Math.min(LIMITS.maxAccountOffset, Math.floor(o.offset ?? 0)));
  const errors: string[] = [];
  const [all, covers] = await Promise.all([listAccounts(c, d, { owner, blockNumber }), readCovers(c, d, owner, blockNumber, errors)]);
  const end = Math.max(0, all.length - offset);
  const start = Math.max(0, end - LIMITS.accountsPerPage);
  const page = all.slice(start, end).reverse();
  const states = await mapLimit(page, LIMITS.accountConcurrency, (a) =>
    accountState(c, d, a, { blockNumber }).catch((err) => {
      errors.push(`account ${a} could not be read: ${shortMessage(err)}`);
      return null;
    }),
  );
  const symbols = [...new Set(states.flatMap((st) => (st ? [st.symbol] : [])))];
  const oracles = new Map<string, OracleSnapshot | string>();
  await mapLimit(symbols, LIMITS.accountConcurrency, async (sym) => {
    try {
      oracles.set(sym, await oracleSnapshot(c, d, sym, { blockNumber }));
    } catch (err) {
      oracles.set(sym, `the Session Oracle could not be read for ${sym}: ${shortMessage(err)}`);
    }
  });
  const accounts: AccountView[] = states.flatMap((st) => {
    if (!st) return [];
    const snap = oracles.get(st.symbol);
    return [typeof snap === "string" || snap === undefined ? accountView(st, null, snap) : accountView(st, snap)];
  });
  return { blockNumber: blockNumber.toString(), at, accounts, total: all.length, offset, more: start > 0, covers, errors };
}

// -------------------------------------------------------------------- loans

const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10_000) : null);

async function listaLoan(c: Client, ext: ExternalAddresses, m: CatalogMarket, user: Address, blockNumber: bigint): Promise<LoanView | null> {
  const id = m.lista!.marketId;
  const mp = await listaParams(c, ext.moolah, id);
  const at = { address: ext.moolah, abi: moolahAbi, blockNumber } as const;
  const [pos, mkt] = await Promise.all([
    c.readContract({ ...at, functionName: "position", args: [id, user] }),
    c.readContract({ ...at, functionName: "market", args: [id] }),
  ]);
  const borrowShares = BigInt(pos[1]);
  const collateral = BigInt(pos[2]);
  if (borrowShares === 0n && collateral === 0n) return null;
  const debt = listaDebt(borrowShares, { totalBorrowAssets: BigInt(mkt[2]), totalBorrowShares: BigInt(mkt[3]), lltv: mp.lltv });
  const [ld, cd, price] = await Promise.all([
    decimalsOf(c, mp.loanToken),
    decimalsOf(c, mp.collateralToken),
    c.readContract({ ...at, functionName: "getPrice", args: [mp] }).catch(() => null),
  ]);
  // Moolah price: collateral units * price / 1e36 = loan units
  const value = price ? Number(formatUnits((collateral * price) / 10n ** 36n, ld)) : 0;
  return {
    venue: "lista",
    key: listaCoverKey(mp),
    label: m.label,
    symbol: m.symbol,
    collateralSymbol: m.collateralSymbol,
    loanSymbol: m.loanSymbol,
    loanToken: mp.loanToken,
    collateral: collateral.toString(),
    collateralDecimals: cd,
    debt: debt.toString(),
    loanDecimals: ld,
    ltvBps: price ? ratio(Number(formatUnits(debt, ld)), value) : null,
    lltvBps: Math.round(Number(mp.lltv / 10n ** 14n)),
    marketParams: mpView(mp),
  };
}

async function venusLoans(c: Client, ext: ExternalAddresses, user: Address, blockNumber: bigint): Promise<LoanView[]> {
  const venus = MARKETS.filter((m) => m.venus);
  const vDebt = venus[0]?.venus?.vDebt;
  if (!vDebt) return [];
  const debt = await c.readContract({ address: vDebt, abi: vTokenAbi, blockNumber, functionName: "borrowBalanceStored", args: [user] });
  if (debt === 0n) return [];
  const debtToken = venus[0]!.loanToken;
  const ld = await decimalsOf(c, debtToken);
  const price = (v: Address) =>
    c.readContract({ address: ext.venusOracle, abi: venusOracleAbi, blockNumber, functionName: "getUnderlyingPrice", args: [v] }).catch(() => null);
  const debtPrice = await price(vDebt);
  const out: LoanView[] = [];
  for (const m of venus) {
    const v = m.venus!.vCollateral;
    const [bal, rate, cp, mk] = await Promise.all([
      c.readContract({ address: v, abi: vTokenAbi, blockNumber, functionName: "balanceOf", args: [user] }),
      c.readContract({ address: v, abi: vTokenAbi, blockNumber, functionName: "exchangeRateStored" }),
      price(v),
      c.readContract({ address: ext.comptroller, abi: comptrollerAbi, blockNumber, functionName: "markets", args: [v] }),
    ]);
    if (bal === 0n) continue;
    const collateral = (bal * rate) / 10n ** 18n;
    const cd = await decimalsOf(c, m.collateralToken);
    // Venus oracle prices are scaled 1e36 / 10^underlyingDecimals: amount * price / 1e36 = USD
    const collUsd = cp ? Number(formatUnits(collateral * cp, 36)) : 0;
    const debtUsd = debtPrice ? Number(formatUnits(debt * debtPrice, 36)) : 0;
    const threshold = mk[3] > 0n ? mk[3] : mk[1];
    out.push({
      venue: "venus",
      key: venusCoverKey(vDebt),
      label: m.label,
      symbol: m.symbol,
      collateralSymbol: m.collateralSymbol,
      loanSymbol: m.loanSymbol,
      loanToken: debtToken,
      collateral: collateral.toString(),
      collateralDecimals: cd,
      debt: debt.toString(),
      loanDecimals: ld,
      ltvBps: cp && debtPrice ? ratio(debtUsd, collUsd) : null,
      lltvBps: Math.round(Number(threshold / 10n ** 14n)),
      vDebt,
    });
  }
  return out;
}

/**
 * The wallet's own loans on the configured Lista markets and Venus (the ones a CushionVault cover can protect).
 * The markets come from the configuration, so the number of reads does not depend on the caller.
 */
export async function readLoans(c: Client, ext: ExternalAddresses, user: Address, o: { head?: Head } = {}) {
  const { blockNumber, at } = o.head ?? (await head(c));
  const errors: string[] = [];
  const lista = await Promise.all(
    MARKETS.filter((m) => m.lista).map((m) =>
      listaLoan(c, ext, m, user, blockNumber).catch((err) => {
        errors.push(`${m.label}: ${shortMessage(err)}`);
        return null;
      }),
    ),
  );
  const venus = await venusLoans(c, ext, user, blockNumber).catch((err) => {
    errors.push(`Venus: ${shortMessage(err)}`);
    return [] as LoanView[];
  });
  return { blockNumber: blockNumber.toString(), at, loans: [...lista.flatMap((l) => (l ? [l] : [])), ...venus], errors };
}

// ------------------------------------------------------------------ markets

export async function readMarkets(c: Client, ext: ExternalAddresses): Promise<MarketView[]> {
  return Promise.all(
    MARKETS.map(async (m): Promise<MarketView> => {
      const base: MarketView = {
        id: m.id,
        venue: m.venue,
        label: m.label,
        symbol: m.symbol,
        collateralSymbol: m.collateralSymbol,
        loanSymbol: m.loanSymbol,
        collateralToken: m.collateralToken,
        loanToken: m.loanToken,
        lltvBps: m.configLltvBps,
        marketParams: null,
        path: m.venue === "lista" ? deleveragePathFor(m) : null,
        ...(m.venus ? { vCollateral: m.venus.vCollateral, vDebt: m.venus.vDebt } : {}),
      };
      try {
        if (m.lista) {
          const mp = await listaParams(c, ext.moolah, m.lista.marketId);
          if (getAddress(mp.collateralToken) !== m.collateralToken || getAddress(mp.loanToken) !== m.loanToken) {
            return { ...base, error: "the market on chain does not match the configured tokens" };
          }
          return { ...base, marketParams: mpView(mp), lltvBps: Math.round(Number(mp.lltv / 10n ** 14n)) };
        }
        const v = m.venus!.vCollateral;
        const [mk, underlying] = await Promise.all([
          c.readContract({ address: ext.comptroller, abi: comptrollerAbi, functionName: "markets", args: [v] }),
          c.readContract({ address: v, abi: vTokenAbi, functionName: "underlying" }),
        ]);
        if (getAddress(underlying) !== m.collateralToken) return { ...base, error: "the Venus market's underlying is not the configured bStock" };
        const threshold = mk[3] > 0n ? mk[3] : mk[1];
        return { ...base, lltvBps: Math.round(Number(threshold / 10n ** 14n)) };
      } catch (err) {
        return { ...base, error: `could not be read: ${shortMessage(err)}` };
      }
    }),
  );
}

// -------------------------------------------------------------------- token

/** Tokens the app deals in: the configured stablecoins and bStocks. No other contract is read on a caller's word. */
export const isKnownToken = (token: string) => tokenSymbol(token) !== null;

export async function readToken(c: Client, token: Address, owner: Address, spender: Address | null, o: { head?: Head } = {}): Promise<TokenView> {
  if (!isKnownToken(token)) throw new Error("not a token this app uses");
  const { blockNumber } = o.head ?? (await head(c));
  const [decimals, balance, allowance] = await Promise.all([
    decimalsOf(c, token),
    c.readContract({ address: token, abi: erc20Abi, blockNumber, functionName: "balanceOf", args: [owner] }),
    spender ? c.readContract({ address: token, abi: erc20Abi, blockNumber, functionName: "allowance", args: [owner, spender] }) : Promise.resolve(null),
  ]);
  return { token, symbol: tokenSymbol(token) ?? "token", decimals, balance: balance.toString(), allowance: allowance === null ? null : allowance.toString() };
}

// ------------------------------------------------------------------- stocks

/** The configured stock tokens (every ticker, every issuer) the wallet holds, read on chain: no prices. */
export async function readStocks(c: Client, user: Address, o: { head?: Head } = {}): Promise<HeldStock[]> {
  const { blockNumber } = o.head ?? (await head(c));
  const all = [...STOCK_TOKENS.values()];
  const balances = await mapLimit(all, 12, (t) =>
    c.readContract({ address: t.token, abi: erc20Abi, blockNumber, functionName: "balanceOf", args: [user] }).catch(() => 0n),
  );
  return all.flatMap((t, i) => {
    const raw = balances[i] ?? 0n;
    return raw > 0n ? [{ ...t, tokenSymbol: t.issuer === "bStock" ? `${t.symbol}B` : `${t.symbol} (${t.issuer})`, rawBalance: raw.toString(), priceUsd: null }] : [];
  });
}
