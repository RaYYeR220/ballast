// Account keeper. Every 5 min: for each Ballast account and CushionVault cover this desk keeps, work out where
// the market is (the @ballast/risk calendar plus the oracle's windowAhead), and inside the shield lead time
// (60 min before a close, or the whole regular session before an earnings window) shield the position to
// survive the coming gap; in the regular session restore it toward its pre-shield debt when the owner allows
// and the oracle says risk may be added. Every decision is deterministic; the contracts bound every action.
// Each send is preceded by a fresh read and a re-plan (abort if the plan moved) and by a simulation.
import { bscConfig, nextClose, session as calendarSession } from "@ballast/risk";
import {
  accountState,
  comptrollerAbi,
  cushionVaultAbi,
  isRevert,
  listAccounts,
  listCovers,
  moolahAbi,
  oracleSnapshot,
  planForAccount,
  sessionOracleAbi,
  symbolToBytes32,
  vTokenAbi,
  venusOracleAbi,
  writes,
  type AccountPlan,
  type AccountState,
  type CoverEntry,
  type Deployment,
  type PlanOracle,
  type ReadClient,
  type TxRequest,
} from "@ballast/sdk";
import { encodeAbiParameters, erc20Abi, formatUnits, keccak256, parseAbi, zeroHash, type Address, type Hex } from "viem";
import type { Feed, FeedError, FeedSim, FeedWindow } from "./feed";
import { safeMessage, type TxSender } from "./tx";

export const KEEPER_TICK_SEC = 300;
/** Shield this long before a regular close. */
export const LEAD_TIME_SEC = 3600;
/** After a refusal, leave that account's action alone this long (three ticks). */
export const REFUSAL_BACKOFF_SEC = 15 * 60;
/** Amounts may move this much between the planning read and the pre-send re-read (interest accrual). */
export const PLAN_TOLERANCE_BPS = 50;

// ------------------------------------------------------------------- phase

export type Phase =
  | { phase: "lead"; why: "close" | "earnings"; window: FeedWindow }
  | { phase: "restore"; window: FeedWindow }
  | { phase: "idle"; reason: string; window: FeedWindow };

/**
 * Where the keeper stands at `at` (chain time) for a symbol whose next closure is `ahead` (oracle windowAhead,
 * already upgraded to EARNINGS when the posted earnings gap lands at its open).
 */
export function keeperPhase(at: number, ahead: PlanOracle["windowAhead"], leadSec = LEAD_TIME_SEC): Phase {
  const window: FeedWindow = { kind: ahead.window, startsAt: ahead.startsAt, endsAt: ahead.endsAt, gapBps: ahead.gapBps };
  const s = calendarSession(at);
  if (s === "UNKNOWN") return { phase: "idle", reason: "the session calendar does not cover this time", window };
  if (ahead.window !== "NONE" && ahead.startsAt > at) {
    if (ahead.startsAt - at <= leadSec) return { phase: "lead", why: "close", window };
    // Earnings: the whole regular session whose close opens the earnings window.
    if (ahead.window === "EARNINGS" && s === "REGULAR" && nextClose(at) === ahead.startsAt) return { phase: "lead", why: "earnings", window };
  }
  if (s === "REGULAR") return { phase: "restore", window };
  return { phase: "idle", reason: "the market is closed: shields run before the close, restores in the regular session", window };
}

// -------------------------------------------------------------------- path

const FIRST_HOP_FEES = [2500, 500, 100, 10_000];
const SECOND_HOP_FEES = [100, 500];

/**
 * The PancakeSwap v3 route the owner fixed for this Lista account (collateral -> USDT -> loan token, or a
 * direct pool), found by matching its hash among the configured routes. Null when unset or unknown.
 */
export function deleveragePathFor(state: AccountState, extra: readonly Hex[] = []): Hex | null {
  if (state.market.venue !== "lista" || !state.market.deleveragePathSet) return null;
  const want = state.market.deleveragePathHash.toLowerCase();
  const usdt = bscConfig.tokens.USDT as Address;
  const coll = state.collateralToken;
  const loan = state.loanToken;
  const candidates: Hex[] = [...extra];
  for (const f1 of FIRST_HOP_FEES) {
    candidates.push(writes.encodeV3Path([coll, loan], [f1]));
    if (loan.toLowerCase() !== usdt.toLowerCase()) for (const f2 of SECOND_HOP_FEES) candidates.push(writes.encodeV3Path([coll, usdt, loan], [f1, f2]));
  }
  return candidates.find((p) => keccak256(p).toLowerCase() === want) ?? null;
}

// ------------------------------------------------------------------- reads

export interface KeeperReads {
  accounts(): Promise<Address[]>;
  account(address: Address): Promise<AccountState>;
  oracle(symbol: string): Promise<PlanOracle>;
  covers(): Promise<CoverEntry[]>;
  /**
   * The cover user's own loan as an AccountState for the planner (cushion = what the cover may spend today).
   * Null when the position cannot be read as one loan in the cover's symbol.
   */
  coverState(entry: CoverEntry): Promise<AccountState | null>;
  canShieldNow(symbol: string): Promise<boolean>;
}

const assetsInAbi = parseAbi(["function getAssetsIn(address account) view returns (address[])"]);
const scaled = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (isRevert(err)) return null;
    throw err;
  }
}

/** Keeper reads over the deployment with the SDK. */
export function chainKeeperReads(c: ReadClient, d: Deployment): KeeperReads {
  return {
    accounts: () => listAccounts(c, d),
    account: (a) => accountState(c, d, a),
    oracle: (sym) => oracleSnapshot(c, d, sym),
    covers: () => listCovers(c, d),
    canShieldNow: (sym) => c.readContract({ address: d.cushionVault, abi: cushionVaultAbi, functionName: "canShieldNow", args: [symbolToBytes32(sym)] }),
    coverState: (e) => coverState(c, d, e),
  };
}

const SYNTHETIC_MANDATE = { maxLtvBps: 10_000, shieldLtvBps: 0, maxSlippageBps: 0, autoRestore: false };

async function coverState(c: ReadClient, d: Deployment, e: CoverEntry): Promise<AccountState | null> {
  const head = await c.getBlock({ blockTag: "latest" });
  const blockNumber = head.number as bigint;
  const at = Number(head.timestamp);
  const cv = e.cover;
  const usedToday = at >= cv.dayStart + 86_400 ? 0n : cv.usedToday;
  const room = cv.capPerDay > usedToday ? cv.capPerDay - usedToday : 0n;
  const cushion = cv.balance < room ? cv.balance : room;
  const decimals = (t: Address) => c.readContract({ address: t, abi: erc20Abi, blockNumber, functionName: "decimals" });
  const base = {
    address: e.user,
    blockNumber,
    owner: e.user,
    keeper: cv.keeper,
    symbol: cv.symbol,
    mandate: SYNTHETIC_MANDATE,
    cushion,
    ltvBps: null,
    healthKnown: false,
    healthy: false,
    liquidated: false,
    liquidationRecorded: false,
    trackedCollateral: 0n,
  };

  if (cv.venue === "lista") {
    const mp = cv.marketParams;
    const id = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv],
      ),
    );
    const m = { address: d.external.moolah, abi: moolahAbi, blockNumber } as const;
    const [pos, mkt, price, minLoan, ld, cd] = await Promise.all([
      c.readContract({ ...m, functionName: "position", args: [id, e.user] }),
      c.readContract({ ...m, functionName: "market", args: [id] }),
      orNull(c.readContract({ ...m, functionName: "getPrice", args: [mp] })),
      orNull(c.readContract({ ...m, functionName: "minLoan", args: [mp] })),
      decimals(mp.loanToken),
      decimals(mp.collateralToken),
    ]);
    const shares = BigInt(pos[1]);
    const debt = shares === 0n ? 0n : (shares * (BigInt(mkt[2]) + 1n) + BigInt(mkt[3]) + 1_000_000n - 1n) / (BigInt(mkt[3]) + 1_000_000n);
    const oraclePrice = price && price > 0n ? price : null;
    return {
      ...base,
      venue: "lista",
      collateral: BigInt(pos[2]),
      debt,
      loanToken: mp.loanToken,
      collateralToken: mp.collateralToken,
      loanDecimals: ld,
      collateralDecimals: cd,
      market: { venue: "lista", moolah: d.external.moolah, marketId: id, marketParams: mp, deleveragePathHash: zeroHash, deleveragePathSet: false, oraclePrice, minLoan },
      pricing: {
        collateralPriceUsd: oraclePrice === null ? null : scaled((oraclePrice * 10n ** BigInt(cd)) / 10n ** BigInt(ld), 36),
        loanPriceUsd: 1,
        lltv: scaled(mp.lltv, 18),
        minLoanUsd: minLoan === null ? 0 : scaled(minLoan, ld),
        minLoanKnown: minLoan !== null,
      },
    };
  }

  // Venus: the cover names the debt market; the collateral is the user's market for the symbol's bStock.
  const t = await c.readContract({ address: d.sessionOracle, abi: sessionOracleAbi, blockNumber, functionName: "ticker", args: [symbolToBytes32(cv.symbol)] });
  const entered = await c.readContract({ address: d.external.comptroller, abi: assetsInAbi, blockNumber, functionName: "getAssetsIn", args: [e.user] });
  const underlyings = await Promise.all(entered.map((v) => orNull(c.readContract({ address: v, abi: vTokenAbi, blockNumber, functionName: "underlying" }))));
  const vColl = entered.find((_, i) => underlyings[i] && same(underlyings[i] as string, t.bStock));
  if (!vColl) return null;
  const v = (address: Address) => ({ address, abi: vTokenAbi, blockNumber }) as const;
  const price = (vToken: Address) => orNull(c.readContract({ address: d.external.venusOracle, abi: venusOracleAbi, blockNumber, functionName: "getUnderlyingPrice", args: [vToken] }));
  const [debt, bal, rate, loanToken, mk, cPrice, dPrice] = await Promise.all([
    c.readContract({ ...v(cv.vDebt), functionName: "borrowBalanceStored", args: [e.user] }),
    c.readContract({ ...v(vColl), functionName: "balanceOf", args: [e.user] }),
    c.readContract({ ...v(vColl), functionName: "exchangeRateStored" }),
    c.readContract({ ...v(cv.vDebt), functionName: "underlying" }),
    c.readContract({ address: d.external.comptroller, abi: comptrollerAbi, blockNumber, functionName: "markets", args: [vColl] }),
    price(vColl),
    price(cv.vDebt),
  ]);
  const [ld, cd] = await Promise.all([decimals(loanToken), decimals(t.bStock)]);
  const threshold = mk[3] > 0n ? mk[3] : mk[1];
  const collateralPrice = cPrice && cPrice > 0n ? cPrice : null;
  const debtPrice = dPrice && dPrice > 0n ? dPrice : null;
  return {
    ...base,
    venue: "venus",
    collateral: (bal * rate) / 10n ** 18n,
    debt,
    loanToken,
    collateralToken: t.bStock,
    loanDecimals: ld,
    collateralDecimals: cd,
    market: {
      venue: "venus",
      comptroller: d.external.comptroller,
      vCollateral: vColl,
      vDebt: cv.vDebt,
      venusOracle: d.external.venusOracle,
      collateralFactor: mk[1],
      liquidationThreshold: mk[3],
      collateralPrice,
      debtPrice,
    },
    pricing: {
      collateralPriceUsd: collateralPrice === null ? null : scaled(collateralPrice * 10n ** BigInt(cd), 36),
      loanPriceUsd: debtPrice === null ? null : scaled(debtPrice * 10n ** BigInt(ld), 36),
      lltv: scaled(threshold, 18),
      minLoanUsd: 0,
      minLoanKnown: true,
    },
  };
}

// --------------------------------------------------------------- decisions

type Step =
  | { fn: "shieldRepay"; assets: bigint }
  | { fn: "shieldDeleverage"; repayAssets: bigint; collateralToSell: bigint; minOut: bigint; path: Hex; cushion: bigint }
  | { fn: "restore"; assets: bigint }
  | { fn: "shieldFor"; amount: bigint };

interface Decision {
  plan: AccountPlan;
  step: Step | null;
  /** Why nothing is sent (a noop event). */
  noop?: string;
  alert?: { type: string; message: string };
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
/** One basis point plus one wei over a debt read a few blocks before the transaction (interest accrual). */
const withAccrual = (debt: bigint) => debt + debt / 10_000n + 1n;

/** Venue minimum loan in loan units: 0 on Venus, null when Lista's could not be read. */
function minLoanOf(state: AccountState): bigint | null {
  return state.market.venue === "lista" ? state.market.minLoan : 0n;
}

/**
 * Repay amount that never leaves 0 < debt < minLoan + 2: a full close when the cushion covers it with accrual
 * headroom, else stop exactly at minLoan + 2. Null when nothing can be repaid.
 */
export function guardRepay(assets: bigint, debt: bigint, cushion: bigint, minLoan: bigint | null): bigint | null {
  if (assets <= 0n) return null;
  if (minLoan === null || assets >= debt) return assets;
  const floor = minLoan + 2n;
  if (debt - assets >= floor) return assets;
  const full = withAccrual(debt);
  if (cushion >= full) return full;
  return debt > floor ? debt - floor : null;
}

/** Debt left after ListaAccount._spendCushion: all of the cushion, or down to minLoan + 1 above the minimum. */
export function debtAfterCushion(debt: bigint, cushion: bigint, minLoan: bigint): bigint {
  if (cushion === 0n || debt === 0n) return debt;
  if (cushion >= debt) return 0n;
  const keep = minLoan + 1n;
  if (debt - cushion < keep) return debt <= keep ? debt : keep;
  return debt - cushion;
}

function minLoanUsdPlus2(state: AccountState): number | undefined {
  const m = minLoanOf(state);
  if (m === null) return undefined; // unknown: let the planner warn
  return scaled(m + 2n, state.loanDecimals) * (state.pricing.loanPriceUsd ?? 1);
}

const fmtUnits = (x: bigint, decimals: number) => Number(formatUnits(x, decimals)).toFixed(2);

function decideShield(state: AccountState, oracle: PlanOracle, pathFor: (s: AccountState) => Hex | null): Decision {
  const plan = planForAccount(state, oracle, { minLoanUsd: minLoanUsdPlus2(state) });
  if (plan.kind === "noop") return { plan, step: null, noop: plan.reason };
  const minLoan = minLoanOf(state);
  const a = plan.amounts;
  const cushionOnly = (): Step | null => {
    const v = guardRepay(a.repayAssets, state.debt, state.cushion, minLoan);
    return v ? { fn: "shieldRepay", assets: v } : null;
  };
  const repaid = (s: Step | null) =>
    s && s.fn === "shieldRepay" ? `repaying ${fmtUnits(s.assets, state.loanDecimals)} from the cushion only` : "nothing to repay from the cushion";
  if (plan.kind === "repay") {
    const step = cushionOnly();
    return step ? { plan, step } : { plan, step, noop: "the repay would leave a loan under the venue minimum" };
  }
  if (plan.kind === "insufficient") {
    const step = cushionOnly();
    const noPath = state.market.venue === "lista" && !state.market.deleveragePathSet ? " No deleverage path is set by the owner, so no collateral can be sold." : "";
    return {
      plan,
      step,
      alert: {
        type: "insufficient",
        message: `cannot reach HF ${plan.targetHfAfterGap} after a ${plan.gapBps} bps gap: ${plan.reason}.${noPath} The desk is ${repaid(step)}; the owner decides.`,
      },
    };
  }
  // repay+deleverage: one keeper shieldDeleverage spends the cushion first, then sells if still above shieldLtv.
  const noSale = plan.warnings.some((w) => w.startsWith("no sale will happen"));
  const over = plan.warnings.some((w) => w.startsWith("OverDeleverage"));
  const path = pathFor(state);
  if (!path) {
    const step = cushionOnly();
    return {
      plan,
      step,
      alert: {
        type: "path",
        message: `a collateral sale is needed but the owner's deleverage path is not one the desk can rebuild (collateral -> USDT -> loan token); ${repaid(step)}; the owner decides.`,
      },
    };
  }
  if (over && !noSale) {
    const step = cushionOnly();
    return {
      plan,
      step,
      alert: { type: "over-deleverage", message: `the planned sale would be refused (OverDeleverage: it lands too far below the floor); ${repaid(step)}; the owner decides.` },
    };
  }
  let flash = a.flashRepayAssets;
  if (minLoan !== null && flash < debtAfterCushion(state.debt, state.cushion, minLoan)) {
    const after = debtAfterCushion(state.debt, state.cushion, minLoan);
    if (after - flash < minLoan + 2n) flash = after > minLoan + 2n ? after - minLoan - 2n : 0n;
  }
  if (flash === 0n && !noSale) {
    const step = cushionOnly();
    return { plan, step, alert: { type: "min-loan", message: `the sale cannot leave a loan above the venue minimum; ${repaid(step)}; the owner decides.` } };
  }
  return {
    plan,
    step: { fn: "shieldDeleverage", repayAssets: flash, collateralToSell: a.sellCollateral, minOut: minBig(a.minOut, flash), path, cushion: a.repayAssets },
  };
}

function decideRestore(state: AccountState, oracle: PlanOracle, targetDebt: bigint): Decision {
  const targetUsd = scaled(targetDebt, state.loanDecimals) * (state.pricing.loanPriceUsd ?? 1);
  const plan = planForAccount(state, oracle, { restoreToDebtUsd: targetUsd });
  if (plan.kind !== "borrow") return { plan, step: null, noop: "reason" in plan ? plan.reason : "nothing to restore" };
  return { plan, step: { fn: "restore", assets: plan.amounts.borrowAssets } };
}

function decideCover(state: AccountState, oracle: PlanOracle): Decision {
  const plan = planForAccount(state, oracle, { minLoanUsd: minLoanUsdPlus2(state) });
  if (plan.kind === "noop") return { plan, step: null, noop: plan.reason };
  // Never more than the user's debt (plus accrual headroom; the vault refunds what a full close leaves).
  const capped = minBig(plan.amounts.repayAssets, withAccrual(state.debt));
  const amount = guardRepay(capped, state.debt, state.cushion, minLoanOf(state));
  const step: Step | null = amount ? { fn: "shieldFor", amount } : null;
  const d: Decision = { plan, step };
  if (!step) d.noop = "nothing the cover can repay above the venue minimum";
  if (plan.kind === "insufficient") {
    d.alert = {
      type: "insufficient",
      message: `the cover cannot bring this loan to HF ${plan.targetHfAfterGap} after a ${plan.gapBps} bps gap (${plan.reason}); ${step ? `repaying ${fmtUnits(step.amount, state.loanDecimals)} from the cover only` : "nothing to repay"}; the user decides.`,
    };
  }
  return d;
}

function stepAmounts(s: Step): bigint[] {
  switch (s.fn) {
    case "shieldRepay":
    case "restore":
      return [s.assets];
    case "shieldFor":
      return [s.amount];
    case "shieldDeleverage":
      return [s.repayAssets, s.collateralToSell];
  }
}

const close = (a: bigint, b: bigint) => {
  const hi = a > b ? a : b;
  const diff = a > b ? a - b : b - a;
  return diff * 10_000n <= hi * BigInt(PLAN_TOLERANCE_BPS);
};

/** The same call with amounts within the tolerance (interest accrues between two reads). */
export function sameStep(a: Step | null, b: Step | null): boolean {
  if (!a || !b) return a === b;
  if (a.fn !== b.fn) return false;
  if (a.fn === "shieldDeleverage" && b.fn === "shieldDeleverage" && a.path !== b.path) return false;
  const x = stepAmounts(a);
  const y = stepAmounts(b);
  return x.every((v, i) => close(v, y[i] as bigint));
}

function stepJson(s: Step | null): Record<string, unknown> | undefined {
  if (!s) return undefined;
  const { fn, ...rest } = s;
  return { fn, ...rest };
}

function summary(plan: AccountPlan, state: AccountState, step: Step | null): Record<string, unknown> {
  return {
    kind: plan.kind,
    mode: plan.mode,
    reason: "reason" in plan ? plan.reason : undefined,
    gapBps: plan.gapBps,
    targetHfAfterGap: plan.targetHfAfterGap,
    hfAfterGap: "hfAfterGap" in plan ? plan.hfAfterGap : undefined,
    inDeleverageWindow: plan.inDeleverageWindow,
    canSellCollateral: plan.canSellCollateral,
    warnings: plan.warnings,
    debtBefore: state.debt,
    collateral: state.collateral,
    cushion: state.cushion,
    ltvBps: state.ltvBps !== null && Number.isFinite(state.ltvBps) ? state.ltvBps : null,
    step: stepJson(step),
  };
}

// ------------------------------------------------------------------ keeper

export interface KeeperOptions {
  deployment: Deployment;
  reads: KeeperReads;
  sender: TxSender;
  feed: Feed;
  /** Extra deleverage routes to try besides the configured ones. */
  paths?: readonly Hex[];
  leadTimeSec?: number;
  log?: (line: string) => void;
}

export interface KeeperReport {
  at: number | null;
  checked: number;
  sent: number;
  errors: string[];
}

/** One thing the keeper acts on: a Ballast account or a cover. */
interface Target {
  /** Backoff and dedupe key. */
  key: string;
  account: Address;
  cover?: { user: Address; key: Hex };
  symbol: string;
  mode: "shield" | "restore";
  calldata(step: Step): TxRequest;
  /** Fresh read and decision right before the send; `why` set when the phase no longer allows the action. */
  recheck(): Promise<{ decision: Decision | null; state: AccountState | null; window: FeedWindow; why?: string }>;
}

export class Keeper {
  readonly #o: KeeperOptions;
  readonly #me: Address;
  readonly #noops = new Map<string, string>();
  readonly #alerts = new Set<string>();
  readonly #backoff = new Map<string, number>();
  #at = 0;

  constructor(o: KeeperOptions) {
    this.#o = o;
    this.#me = o.sender.address;
  }

  async tick(): Promise<KeeperReport> {
    const report: KeeperReport = { at: null, checked: 0, sent: 0, errors: [] };
    const oracles = new Map<string, PlanOracle>();
    const oracle = async (sym: string) => {
      let o = oracles.get(sym);
      if (!o) {
        o = await this.#o.reads.oracle(sym);
        oracles.set(sym, o);
      }
      this.#at = o.at;
      report.at = o.at;
      return o;
    };
    const guard = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        const m = `${what}: ${safeMessage(err)}`;
        report.errors.push(m);
        this.#o.log?.(`keeper ${m}`);
      }
    };

    let accounts: Address[] = [];
    await guard("listAccounts", async () => {
      accounts = await this.#o.reads.accounts();
    });
    for (const a of accounts) {
      await guard(`account ${a}`, async () => {
        report.checked++;
        await this.#account(a, oracle, report);
      });
    }
    let covers: CoverEntry[] = [];
    await guard("listCovers", async () => {
      covers = await this.#o.reads.covers();
    });
    for (const c of covers) {
      if (!same(c.cover.keeper, this.#me)) continue;
      await guard(`cover ${c.user}/${c.key}`, async () => {
        report.checked++;
        await this.#cover(c, oracle, report);
      });
    }
    return report;
  }

  // ---------------------------------------------------------------- accounts

  async #account(address: Address, oracle: (s: string) => Promise<PlanOracle>, report: KeeperReport) {
    const { reads } = this.#o;
    const state = await reads.account(address);
    if (!same(state.keeper, this.#me)) return;
    const snap = await oracle(state.symbol);
    const lead = this.#o.leadTimeSec ?? LEAD_TIME_SEC;

    if (state.liquidated) {
      if (!state.liquidationRecorded) await this.#recordLiquidation(state, keeperPhase(snap.at, snap.windowAhead, lead).window, report);
      return;
    }
    const phase = keeperPhase(snap.at, snap.windowAhead, lead);
    const pathFor = (s: AccountState) => deleveragePathFor(s, this.#o.paths);

    if (phase.phase === "lead") {
      const target: Target = {
        key: `${address}|shield`,
        account: address,
        symbol: state.symbol,
        mode: "shield",
        calldata: (step) => this.#accountCall(address, step),
        recheck: async () => {
          const [s, o] = await Promise.all([reads.account(address), reads.oracle(state.symbol)]);
          const p = keeperPhase(o.at, o.windowAhead, lead);
          if (p.phase !== "lead") return { decision: null, state: s, window: p.window, why: "the lead time is over" };
          return { decision: decideShield(s, o, pathFor), state: s, window: p.window };
        },
      };
      await this.#act(target, decideShield(state, snap, pathFor), state, phase.window, report);
      return;
    }

    if (phase.phase === "restore") {
      const targetDebt = this.#o.feed.preShieldDebt(address);
      if (targetDebt === null) return; // no shield cycle open: nothing to restore
      const t = { key: `${address}|restore`, account: address, symbol: state.symbol };
      if (!state.mandate.autoRestore) {
        // Expected after a keeper sale: the contract switches autoRestore off until the owner turns it back on.
        await this.#noop(t, "auto-restore is disabled by the owner", phase.window);
        await this.#alert(t, `autoRestore:${targetDebt}`, phase.window, {
          message: `auto-restore is off (a keeper sale switches it off); re-enable it with setMandate to let the desk restore the loan toward ${fmtUnits(targetDebt, state.loanDecimals)}.`,
        });
        return;
      }
      if (!snap.canAddRisk) {
        await this.#noop(t, `restore waits: the oracle says ${snap.reason}`, phase.window);
        return;
      }
      const target: Target = {
        ...t,
        mode: "restore",
        calldata: (step) => this.#accountCall(address, step),
        recheck: async () => {
          const [s, o] = await Promise.all([reads.account(address), reads.oracle(state.symbol)]);
          const p = keeperPhase(o.at, o.windowAhead, lead);
          if (p.phase !== "restore") return { decision: null, state: s, window: p.window, why: "the restore window is over" };
          if (!o.canAddRisk) return { decision: null, state: s, window: p.window, why: `the oracle now says ${o.reason}` };
          if (!s.mandate.autoRestore) return { decision: null, state: s, window: p.window, why: "auto-restore was disabled" };
          return { decision: decideRestore(s, o, targetDebt), state: s, window: p.window };
        },
      };
      await this.#act(target, decideRestore(state, snap, targetDebt), state, phase.window, report);
    }
  }

  #accountCall(account: Address, step: Step): TxRequest {
    switch (step.fn) {
      case "shieldRepay":
        return writes.shieldRepay(account, step.assets);
      case "shieldDeleverage":
        return writes.shieldDeleverage(account, { repayAssets: step.repayAssets, collateralToSell: step.collateralToSell, path: step.path, minOut: step.minOut });
      case "restore":
        return writes.restore(account, step.assets);
      case "shieldFor":
        throw new Error("shieldFor is a vault call");
    }
  }

  async #recordLiquidation(state: AccountState, window: FeedWindow, report: KeeperReport) {
    const t = { key: `${state.address}|liquidation`, account: state.address, symbol: state.symbol };
    const tx = writes.recordLiquidation(state.address);
    const sim = await this.#o.sender.simulate(tx);
    if (!sim.ok) return; // NotLiquidated or a lock in progress: look again next tick
    const message = "collateral was seized below what the account tracked: recording the liquidation on-chain; the desk stops acting on this account.";
    if (this.#o.sender.dryRun) {
      await this.#alert(t, "liquidation", window, { message, sim, dryRun: true });
      return;
    }
    const sent = await this.#o.sender.send(tx);
    if (sent.ok && sent.status !== "reverted") {
      report.sent++;
      await this.#alert(t, "liquidation", window, { message, sim, txHash: sent.txHash });
    }
  }

  // ------------------------------------------------------------------ covers

  async #cover(e: CoverEntry, oracle: (s: string) => Promise<PlanOracle>, report: KeeperReport) {
    const { reads } = this.#o;
    const snap = await oracle(e.cover.symbol);
    const lead = this.#o.leadTimeSec ?? LEAD_TIME_SEC;
    const phase = keeperPhase(snap.at, snap.windowAhead, lead);
    if (phase.phase !== "lead") return; // covers only shield; nothing to restore
    const t = { key: `${e.user}|${e.key}|shield`, account: e.user, cover: { user: e.user, key: e.key }, symbol: e.cover.symbol };
    const state = await reads.coverState(e);
    if (!state) {
      await this.#noop(t, `no ${e.cover.symbol} collateral found for this ${e.cover.venue} loan`, phase.window);
      return;
    }
    if (state.debt === 0n) {
      await this.#noop(t, "the user has no debt", phase.window);
      return;
    }
    if (!(await reads.canShieldNow(e.cover.symbol))) {
      await this.#noop(t, "the vault only shields within its horizon of the close", phase.window);
      return;
    }
    const target: Target = {
      ...t,
      mode: "shield",
      calldata: (step) => {
        if (step.fn !== "shieldFor") throw new Error(`a cover cannot ${step.fn}`);
        return writes.shieldFor(this.#o.deployment, e.user, e.key, step.amount);
      },
      recheck: async () => {
        const [s, o] = await Promise.all([reads.coverState(e), reads.oracle(e.cover.symbol)]);
        const p = keeperPhase(o.at, o.windowAhead, lead);
        if (p.phase !== "lead") return { decision: null, state: s, window: p.window, why: "the lead time is over" };
        if (!s || s.debt === 0n) return { decision: null, state: s, window: p.window, why: "the user has no debt" };
        return { decision: decideCover(s, o), state: s, window: p.window };
      },
    };
    await this.#act(target, decideCover(state, snap), state, phase.window, report);
  }

  // --------------------------------------------------------------- execution

  async #act(target: Target, decision: Decision, state: AccountState, window: FeedWindow, report: KeeperReport) {
    if (decision.alert) await this.#alert(target, decision.alert.type, window, { message: decision.alert.message, plan: summary(decision.plan, state, decision.step) });
    if (!decision.step) {
      if (decision.noop) await this.#noop(target, decision.noop, window, summary(decision.plan, state, null));
      return;
    }
    if ((this.#backoff.get(target.key) ?? 0) > this.#at) return;

    // Re-read right before the send and go ahead only if the plan still holds.
    const fresh = await target.recheck();
    if (fresh.why || !fresh.decision || !fresh.state || !sameStep(decision.step, fresh.decision.step)) {
      const now = fresh.decision ? stepJson(fresh.decision.step) : undefined;
      await this.#noop(target, `plan changed before send: ${fresh.why ?? "the fresh read plans a different action"}`, fresh.window, {
        ...summary(decision.plan, state, decision.step),
        now,
      });
      return;
    }
    await this.#execute(target, fresh.decision.step as Step, fresh.decision.plan, fresh.state, fresh.window, report);
  }

  async #execute(target: Target, step: Step, plan: AccountPlan, state: AccountState, window: FeedWindow, report: KeeperReport): Promise<void> {
    const { sender, feed } = this.#o;
    const tx = target.calldata(step);
    const base = {
      source: "keeper" as const,
      account: target.account,
      ...(target.cover ? { cover: target.cover } : {}),
      symbol: target.symbol,
      window,
      plan: summary(plan, state, step),
    };
    const kind = target.mode === "restore" ? ("restore" as const) : ("shield" as const);
    const sim = await sender.simulate(tx);
    if (!sim.ok) {
      const error: FeedError = sim.error ?? { name: "SimulationFailed", message: "simulation failed" };
      if (step.fn === "shieldDeleverage" && (error.name === "NotInShieldWindow" || error.name === "OverDeleverage")) {
        await feed.record({ kind: "refused", ...base, sim, error, reason: `${error.message}: falling back to a cushion repay` });
        this.#noops.delete(target.key);
        // The sale stays refused for a while: do not re-try it every tick.
        this.#backoff.set(target.key, this.#at + REFUSAL_BACKOFF_SEC);
        const fallback = guardRepay(step.cushion, state.debt, state.cushion, minLoanOf(state));
        if (fallback) await this.#execute(target, { fn: "shieldRepay", assets: fallback }, plan, state, window, report);
        return;
      }
      await this.#refused(target, base, sim, error);
      return;
    }
    if (sender.dryRun) {
      await feed.record({ kind, ...base, sim, dryRun: true });
      this.#noops.delete(target.key);
      return;
    }
    const sent = await sender.send(tx);
    if (!sent.ok) {
      await this.#refused(target, base, sim, sent.error);
      return;
    }
    if (sent.status === "reverted") {
      await this.#refused(target, base, sim, { name: "Reverted", message: `${step.fn} reverted on-chain` }, sent.txHash);
      return;
    }
    report.sent++;
    this.#noops.delete(target.key);
    await feed.record({
      kind,
      ...base,
      sim,
      txHash: sent.txHash,
      ...(sent.status === "unknown" ? { reason: sent.note ?? "receipt pending" } : {}),
      data: { via: sent.via, gasUsed: sent.gasUsed, effectiveGasPrice: sent.effectiveGasPrice },
    });
    this.#o.log?.(`keeper ${step.fn} ${target.account} in ${sent.txHash}`);
  }

  async #refused(target: Target, base: Record<string, unknown>, sim: FeedSim, error: FeedError, txHash?: Hex) {
    this.#backoff.set(target.key, this.#at + REFUSAL_BACKOFF_SEC);
    this.#noops.delete(target.key);
    await this.#o.feed.record({
      kind: "refused",
      source: "keeper",
      ...(base as object),
      sim,
      error,
      reason: error.message,
      ...(txHash ? { txHash } : {}),
      data: { backoffUntil: this.#at + REFUSAL_BACKOFF_SEC },
    });
  }

  /** One noop per target and reason (numbers ignored), so a quiet account does not fill the feed. */
  async #noop(t: { key: string; account: Address; cover?: { user: Address; key: Hex }; symbol: string }, reason: string, window: FeedWindow, plan?: Record<string, unknown>) {
    const k = reason.replace(/[\d.]+/g, "#");
    if (this.#noops.get(t.key) === k) return;
    this.#noops.set(t.key, k);
    await this.#o.feed.record({
      kind: "noop",
      source: "keeper",
      account: t.account,
      ...(t.cover ? { cover: t.cover } : {}),
      symbol: t.symbol,
      window,
      reason,
      ...(plan ? { plan } : {}),
    });
  }

  /** One alert per target, type and window. */
  async #alert(
    t: { key: string; account: Address; cover?: { user: Address; key: Hex }; symbol: string },
    type: string,
    window: FeedWindow,
    o: { message: string; plan?: Record<string, unknown>; sim?: FeedSim; txHash?: Hex; dryRun?: boolean },
  ) {
    const k = `${t.key}|${type}|${window.startsAt}`;
    if (this.#alerts.has(k)) return;
    this.#alerts.add(k);
    if (this.#alerts.size > 10_000) this.#alerts.delete(this.#alerts.values().next().value as string);
    await this.#o.feed.record({
      kind: "alert",
      source: "keeper",
      account: t.account,
      ...(t.cover ? { cover: t.cover } : {}),
      symbol: t.symbol,
      window,
      reason: o.message,
      ...(o.plan ? { plan: o.plan } : {}),
      ...(o.sim ? { sim: o.sim } : {}),
      ...(o.txHash ? { txHash: o.txHash } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
    });
  }
}
