/* Chain reads behind the app's routes: a wallet's Ballast accounts and covers, its own Lista/Venus loans (for a
   cover), the configured markets with their live parameters, and one token's balance and allowance. Every read
   in one answer is pinned to one block. */
import { listaDebt } from "@ballast/risk";
import {
  accountState,
  comptrollerAbi,
  listAccounts,
  listCovers,
  moolahAbi,
  oracleSnapshot,
  vTokenAbi,
  venusOracleAbi,
  type Deployment,
  type ExternalAddresses,
  type OracleSnapshot,
  type ReadClient,
} from "@ballast/sdk";
import { encodeAbiParameters, erc20Abi, formatUnits, getAddress, keccak256, type Address, type Hex } from "viem";
import { deleveragePathFor, MARKETS, tokenSymbol, type CatalogMarket } from "@/lib/markets";
import type { AccountView, CoverView, LoanView, MarketParamsView, MarketView, TokenView } from "@/lib/views";
import { shortMessage } from "./simulate";
import { accountView } from "./views";

type Client = ReadClient;

async function head(c: Client) {
  const b = await c.getBlock({ blockTag: "latest" });
  return { blockNumber: b.number as bigint, at: Number(b.timestamp) };
}

const decimalsMemo = new Map<string, number>();
async function decimalsOf(c: Client, token: Address): Promise<number> {
  const k = token.toLowerCase();
  const hit = decimalsMemo.get(k);
  if (hit !== undefined) return hit;
  const d = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  decimalsMemo.set(k, d);
  return d;
}

const mpView = (mp: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }): MarketParamsView => ({
  loanToken: mp.loanToken,
  collateralToken: mp.collateralToken,
  oracle: mp.oracle,
  irm: mp.irm,
  lltv: mp.lltv.toString(),
});

// ----------------------------------------------------------------- accounts

export async function readAccounts(c: Client, d: Deployment, owner: Address) {
  const { blockNumber, at } = await head(c);
  const errors: string[] = [];
  const [addrs, coverEntries] = await Promise.all([
    listAccounts(c, d, { owner, blockNumber }),
    listCovers(c, d, { user: owner, blockNumber }),
  ]);
  const states = await Promise.all(
    addrs.map((a) =>
      accountState(c, d, a, { blockNumber }).catch((err) => {
        errors.push(`account ${a} could not be read: ${shortMessage(err)}`);
        return null;
      }),
    ),
  );
  const symbols = [...new Set(states.flatMap((st) => (st ? [st.symbol] : [])))];
  const oracles = new Map<string, OracleSnapshot | string>();
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        oracles.set(sym, await oracleSnapshot(c, d, sym, { blockNumber }));
      } catch (err) {
        oracles.set(sym, `the Session Oracle could not be read for ${sym}: ${shortMessage(err)}`);
      }
    }),
  );
  const accounts: AccountView[] = states.flatMap((st) => {
    if (!st) return [];
    const o = oracles.get(st.symbol);
    return [typeof o === "string" || o === undefined ? accountView(st, null, o) : accountView(st, o)];
  });
  const covers: CoverView[] = await Promise.all(
    coverEntries.map(async (e) => {
      const cv = e.cover;
      const tokenDecimals = await decimalsOf(c, cv.token);
      const label =
        cv.venue === "lista"
          ? `Lista ${tokenSymbol(cv.marketParams.collateralToken) ?? `${cv.symbol}B`} / ${tokenSymbol(cv.marketParams.loanToken) ?? "loan"}`
          : `Venus ${cv.symbol}B / ${tokenSymbol(cv.token) ?? "loan"}`;
      return {
        user: e.user,
        key: e.key,
        venue: cv.venue,
        symbol: cv.symbol,
        token: cv.token,
        tokenSymbol: tokenSymbol(cv.token) ?? "tokens",
        tokenDecimals,
        keeper: cv.keeper,
        capPerDay: cv.capPerDay.toString(),
        balance: cv.balance.toString(),
        dayStart: cv.dayStart,
        usedToday: cv.usedToday.toString(),
        label,
      };
    }),
  );
  return { blockNumber: blockNumber.toString(), at, accounts, covers, errors };
}

// -------------------------------------------------------------------- loans

export const listaCoverKey = (mp: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] }],
      [1, [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv]],
    ),
  );

export const venusCoverKey = (vDebt: Address): Hex => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [2, vDebt]));

const paramsMemo = new Map<string, { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }>();
async function listaParams(c: Client, moolah: Address, id: Hex) {
  const hit = paramsMemo.get(id);
  if (hit) return hit;
  const r = await c.readContract({ address: moolah, abi: moolahAbi, functionName: "idToMarketParams", args: [id] });
  const mp = { loanToken: r[0], collateralToken: r[1], oracle: r[2], irm: r[3], lltv: r[4] };
  if (mp.loanToken === "0x0000000000000000000000000000000000000000") throw new Error(`Lista market ${id} is not created`);
  paramsMemo.set(id, mp);
  return mp;
}

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

/** The wallet's own loans on the configured Lista markets and Venus (the ones a CushionVault cover can protect). */
export async function readLoans(c: Client, ext: ExternalAddresses, user: Address) {
  const { blockNumber, at } = await head(c);
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

export async function readToken(c: Client, token: Address, owner: Address, spender: Address | null): Promise<TokenView> {
  const [decimals, balance, allowance, symbol] = await Promise.all([
    decimalsOf(c, token),
    c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    spender ? c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }) : Promise.resolve(null),
    c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => tokenSymbol(token) ?? "token"),
  ]);
  return { token, symbol, decimals, balance: balance.toString(), allowance: allowance === null ? null : allowance.toString() };
}
