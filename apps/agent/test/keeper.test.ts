import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import {
  ballastAccountBaseAbi,
  cushionVaultAbi,
  listaAccountAbi,
  parseDeployment,
  writes,
  type AccountState,
  type CoverEntry,
  type PlanOracle,
  type TxRequest,
} from "@ballast/sdk";
import { regularCloseAt, regularOpenAt } from "@ballast/risk";
import { Feed } from "../src/desk/feed";
import { Keeper, deleveragePathFor, isDust, keeperPhase, restoreTargetUsd, shieldedDebts, trimSale, type KeeperReads } from "../src/desk/keeper";
import {
  GasWatch,
  revertError,
  type Confirmation,
  type HaltInfo,
  type SendOptions,
  type SendResult,
  type SenderState,
  type SimulateOptions,
  type TxBuilder,
  type TxLog,
  type TxSender,
} from "../src/desk/tx";

const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));
const E18 = 10n ** 18n;
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
const AGENT = addr(0xee);
const OWNER = addr(0xb1);
const ACCOUNT = addr(0xd1);
const USD1 = getAddress(d.external.tokens.USD1!);
const USDT = getAddress(d.external.tokens.USDT!);
const NVDAB = addr(0xc2);
const PATH = writes.encodeV3Path([NVDAB, USDT, USD1], [2500, 100]);

// Wednesday 2026-10-07 (EDT): regular session 13:30-20:00 UTC, overnight closure to Thursday 13:30 UTC.
const WED = Date.UTC(2026, 9, 7) / 86_400_000;
const CLOSE = regularCloseAt(WED);
const NEXT_OPEN = regularOpenAt(WED + 1);
const params = { restoreDelay: 5400, horizon: 10_800, convergenceBps: 60, maxRefAge: 93_600, maxOverlayTtl: 21_600, maxOndoDriftBps: 100, maxRefDeviationBps: 300 };

function oracle(at: number, o: Partial<PlanOracle> = {}): PlanOracle {
  return {
    at,
    params,
    session: "REGULAR",
    canAddRisk: false,
    reason: "WINDOW_AHEAD",
    windowAhead: { window: "OVERNIGHT", startsAt: CLOSE, endsAt: NEXT_OPEN, gapBps: 417 },
    currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 },
    ...o,
  };
}
const LEAD = CLOSE - 1800;
const MORNING = regularOpenAt(WED) + 2 * 3600;

function lista(o: Partial<AccountState> & { minLoan?: bigint; pathSet?: boolean; pathHash?: Hex } = {}): AccountState {
  const { minLoan = E18, pathSet = true, pathHash = keccak256(PATH), ...rest } = o;
  return {
    address: ACCOUNT,
    blockNumber: 1_000n,
    venue: "lista",
    owner: OWNER,
    keeper: AGENT,
    symbol: "NVDA",
    mandate: { maxLtvBps: 7400, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true },
    collateral: 10n * E18,
    debt: 1800n * E18,
    cushion: 100n * E18,
    ltvBps: 7200,
    healthKnown: true,
    healthy: true,
    liquidated: false,
    liquidationRecorded: false,
    trackedCollateral: 10n * E18,
    loanToken: USD1,
    collateralToken: NVDAB,
    loanDecimals: 18,
    collateralDecimals: 18,
    market: {
      venue: "lista",
      moolah: d.external.moolah,
      marketId: `0x${"11".repeat(32)}`,
      marketParams: { loanToken: USD1, collateralToken: NVDAB, oracle: addr(0xc4), irm: addr(0xc5), lltv: 75n * 10n ** 16n },
      deleveragePathHash: pathSet ? pathHash : `0x${"00".repeat(32)}`,
      deleveragePathSet: pathSet,
      oraclePrice: 250n * 10n ** 36n,
      minLoan,
    },
    pricing: { collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: Number(minLoan / E18), minLoanKnown: true },
    ...rest,
  };
}

function venus(o: Partial<AccountState> = {}): AccountState {
  return {
    ...lista(),
    venue: "venus",
    loanToken: USDT,
    market: {
      venue: "venus",
      comptroller: d.external.comptroller,
      vCollateral: addr(0xc7),
      vDebt: addr(0xc8),
      venusOracle: d.external.venusOracle,
      collateralFactor: 5n * 10n ** 17n,
      liquidationThreshold: 75n * 10n ** 16n,
      collateralPrice: 250n * E18,
      debtPrice: E18,
    },
    pricing: { collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: 0, minLoanKnown: true },
    ...o,
  };
}

type Call = { fn: string; args: readonly unknown[]; to: Address };

function decode(tx: TxRequest): Call {
  for (const abi of [listaAccountAbi, ballastAccountBaseAbi, cushionVaultAbi]) {
    try {
      const r = decodeFunctionData({ abi, data: tx.data });
      return { fn: r.functionName, args: (r.args ?? []) as readonly unknown[], to: tx.to };
    } catch {
      // try the next ABI
    }
  }
  throw new Error(`unknown calldata ${tx.data.slice(0, 10)}`);
}

/**
 * How a send of a given function ends (default: mined). "pending" is a send the sender halted on; "fallback"
 * is a sale whose cushion repay was mined in its place; "cancel" is one cancelled after a timeout; "rebuild"
 * asks the builder again (round 1) the way the sender does after a receipt timeout, then mines what it got.
 */
type Stage = "estimate" | "revert" | "throw" | "pending" | "dropped" | "halted" | "fallback" | "cancel" | "rebuild";
const STUCK: HaltInfo = { reason: "STUCK", message: "nonce 7 is not mined after 4 replacement rounds", nonce: 7, since: 1_791_000_000 };
const tooLittle = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: ["Too little received"] });
const hashOf = (n: number) => `0x${String(n).padStart(64, "0")}` as Hex;
/** A Shielded(kind, debtBefore, debtAfter, collateralSold) log of the account. */
const shieldedLog = (before: bigint, after: bigint, kind = 0, sold = 0n, address: Address = ACCOUNT): TxLog => ({
  address,
  topics: encodeEventTopics({ abi: ballastAccountBaseAbi, eventName: "Shielded" }) as Hex[],
  data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [kind, before, after, sold]),
});

class StubSender implements TxSender {
  readonly address = AGENT;
  dryRun = false;
  /** fn name -> revert data for its simulation. */
  failing = new Map<string, Hex>();
  /** fn name -> how its next send ends. */
  outcome = new Map<string, Stage>();
  /** fn names whose simulations disagree between Binance and eth_call. */
  disagree = new Set<string>();
  /** txHash -> what confirm() reports (default: still pending). */
  confirms = new Map<string, Confirmation>();
  /** Logs the next mined send of a function returns. */
  logs = new Map<string, TxLog[]>();
  /** Set to make state() and every send report a halted sender. */
  halt: HaltInfo | null = null;
  /** What the builder answered when asked again (round 1): the function name, or null for "cancel it". */
  rebuilt: (string | null)[] = [];
  /** Runs inside send before the builder (as if another send held the nonce meanwhile). */
  beforeBuild?: () => void;
  /** Runs between the first build and the rebuild of a "rebuild" send. */
  beforeRebuild?: () => void;
  sims: (Call & { strict: boolean })[] = [];
  sent: (Call & { mev: boolean; fallback: boolean })[] = [];
  #n = 0;

  state(): SenderState {
    return { halted: this.halt, outstanding: null, spentLastHourWei: 0n };
  }

  async simulate(tx: TxRequest, opts?: SimulateOptions) {
    const c = decode(tx);
    const strict = opts?.strict === true;
    this.sims.push({ ...c, strict });
    const data = this.failing.get(c.fn);
    if (data) return { via: "rpc" as const, ok: false, error: revertError(data)! };
    if (this.disagree.has(c.fn)) {
      if (strict) return { via: "binance" as const, ok: false, disagree: true, error: { name: "SimulatorsDisagree", message: "Binance simulate succeeded but eth_call reverted" } };
      return { via: "rpc" as const, ok: true, disagree: true, note: "binance simulate reported FAILED" };
    }
    return { via: "rpc" as const, ok: true };
  }

  async send(input: TxRequest | TxBuilder, opts?: SendOptions): Promise<SendResult> {
    if (this.halt) return { ok: false, stage: "halted", halt: this.halt };
    this.beforeBuild?.();
    const tx = typeof input === "function" ? await input({ round: 0 }) : input;
    if (!tx) return { ok: false, stage: "aborted" };
    const c = decode(tx);
    this.sent.push({ ...c, mev: opts?.mevProtect === true, fallback: typeof opts?.fallback === "function" });
    const stage = this.outcome.get(c.fn);
    this.outcome.delete(c.fn);
    const base = { ok: true as const, txHash: hashOf(++this.#n), via: "rpc" as const, nonce: this.#n, gasPrice: 1n };
    const mined = (fn: string) => ({ ...base, status: "success" as const, minedAs: "intent" as const, logs: this.logs.get(fn) ?? [] });
    switch (stage) {
      case "halted":
        return { ok: false, stage: "halted", halt: STUCK };
      case "estimate":
        return { ok: false, stage: "estimate", error: revertError(tooLittle)! };
      case "throw":
        throw new Error("broadcast rejected: invalid sender");
      case "revert":
        return { ...base, status: "reverted", minedAs: "intent" };
      case "dropped":
        return { ...base, status: "dropped", note: "nonce 1 went to a transaction that is not ours" };
      case "cancel":
        return { ...base, status: "dropped", minedAs: "cancel", note: "cancelled: no longer needed" };
      case "pending":
        return { ...base, status: "pending", note: "nonce 1 is not mined after 4 replacement rounds", halted: STUCK };
      case "fallback": {
        // The protected broadcast failed: the sender asks for the stand-in and that is what gets mined.
        const stand = await opts?.fallback?.({ round: 1 });
        if (!stand) return { ...base, status: "dropped", minedAs: "cancel", note: "binance broadcast failed (HTTP 503); cancelled" };
        const f = decode(stand);
        this.sent.push({ ...f, mev: false, fallback: false });
        return { ...mined(f.fn), minedAs: "fallback", note: "binance broadcast failed (HTTP 503): the sale is not sent publicly" };
      }
      case "rebuild": {
        this.beforeRebuild?.();
        const next = typeof input === "function" ? await input({ round: 1 }) : input;
        this.rebuilt.push(next ? decode(next).fn : null);
        if (!next) return { ...base, status: "dropped", minedAs: "cancel", note: "cancelled: no longer needed" };
        return mined(c.fn);
      }
      default:
        return mined(c.fn);
    }
  }

  async confirm(txHash: Hex): Promise<Confirmation> {
    return this.confirms.get(txHash) ?? { status: "pending" };
  }

  async balance() {
    return 10n ** 18n;
  }
}

interface World {
  accounts: AccountState[];
  /** Successive reads of an account: the first is the planning read, later ones the pre-send re-reads. */
  rereads: AccountState[];
  oracle: PlanOracle;
  covers: CoverEntry[];
  coverStates: Map<string, AccountState>;
  canShield: boolean;
}

async function setup(w: Partial<World> = {}, o: { gas?: (sender: StubSender, feed: Feed) => GasWatch } = {}) {
  const world: World = { accounts: [], rereads: [], oracle: oracle(LEAD), covers: [], coverStates: new Map(), canShield: true, ...w };
  const sender = new StubSender();
  const feed = new Feed({ dir: await mkdtemp(path.join(tmpdir(), "desk-keeper-")), secrets: [], clock: () => world.oracle.at });
  const reads: KeeperReads = {
    accounts: async () => world.accounts.map((a) => a.address),
    account: async (a) => {
      const next = world.rereads.shift();
      if (next) return next;
      const s = world.accounts.find((x) => x.address === a);
      if (!s) throw new Error(`no account ${a}`);
      return s;
    },
    oracle: async () => world.oracle,
    covers: async () => world.covers,
    coverState: async (e) => world.coverStates.get(e.key) ?? null,
    canShieldNow: async () => world.canShield,
  };
  const keeper = new Keeper({ deployment: d, reads, sender, feed, clock: () => world.oracle.at, ...(o.gas ? { gas: o.gas(sender, feed) } : {}) });
  return { world, sender, feed, keeper, reads };
}

describe("keeperPhase", () => {
  const ahead = oracle(LEAD).windowAhead;
  it("is in the lead time from 60 min before the close", () => {
    expect(keeperPhase(CLOSE - 3600, ahead).phase).toBe("lead");
    expect(keeperPhase(CLOSE - 1, ahead).phase).toBe("lead");
    expect(keeperPhase(CLOSE - 3601, ahead).phase).toBe("restore");
  });

  it("covers the whole regular session before an earnings window", () => {
    const earnings = { ...ahead, window: "EARNINGS" as const, gapBps: 880 };
    expect(keeperPhase(regularOpenAt(WED) + 60, earnings)).toMatchObject({ phase: "lead", why: "earnings" });
    // Before the open it is still the closure in progress: nothing to do yet.
    expect(keeperPhase(regularOpenAt(WED) - 600, earnings).phase).toBe("idle");
  });

  it("does nothing while the market is closed or the calendar cannot tell", () => {
    const tomorrow = { window: "OVERNIGHT" as const, startsAt: regularCloseAt(WED + 1), endsAt: regularOpenAt(WED + 2), gapBps: 417 };
    expect(keeperPhase(CLOSE + 3600, tomorrow)).toMatchObject({ phase: "idle", reason: expect.stringMatching(/closed/) });
    expect(keeperPhase(Date.UTC(2030, 0, 2, 15) / 1000, ahead)).toMatchObject({ phase: "idle", reason: expect.stringMatching(/calendar/) });
  });

  it("restores in the regular session away from the close", () => {
    expect(keeperPhase(MORNING, ahead).phase).toBe("restore");
  });
});

describe("deleveragePathFor", () => {
  it("finds the owner's path among the configured routes", () => {
    expect(deleveragePathFor(lista())).toBe(PATH);
    const direct = writes.encodeV3Path([NVDAB, USD1], [500]);
    expect(deleveragePathFor(lista({ pathHash: keccak256(direct) }))).toBe(direct);
  });

  it("is null when unset, unknown or not Lista", () => {
    expect(deleveragePathFor(lista({ pathSet: false }))).toBeNull();
    expect(deleveragePathFor(lista({ pathHash: `0x${"33".repeat(32)}` }))).toBeNull();
    expect(deleveragePathFor(venus())).toBeNull();
  });
});

describe("Keeper shields", () => {
  it("repays from the cushion inside the lead time and records the pre-shield debt", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    await keeper.tick();
    expect(sender.sent).toHaveLength(1);
    const call = sender.sent[0]!;
    expect(call).toMatchObject({ fn: "shieldRepay", to: ACCOUNT });
    const assets = call.args[0] as bigint;
    expect(assets).toBeGreaterThan(80n * E18);
    expect(assets).toBeLessThanOrEqual(100n * E18);
    const ev = feed.list({ kind: "shield" })[0]!;
    expect(ev).toMatchObject({
      source: "keeper",
      account: ACCOUNT,
      symbol: "NVDA",
      window: { kind: "OVERNIGHT", startsAt: CLOSE, endsAt: NEXT_OPEN, gapBps: 417 },
      sim: { via: "rpc", ok: true },
      txHash: `0x${"1".padStart(64, "0")}`,
      plan: { kind: "repay", debtBefore: (1800n * E18).toString(), step: { fn: "shieldRepay", assets: assets.toString() } },
    });
    expect(feed.preShieldDebt(ACCOUNT)).toBe(1800n * E18);
  });

  it("does nothing outside the lead time and the restore window", async () => {
    const { world, sender, keeper } = await setup({ oracle: oracle(CLOSE + 3600, { session: "POST" }) });
    world.accounts = [lista()];
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });

  it("skips accounts kept by someone else", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ keeper: addr(0x99) })];
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list()).toEqual([]);
  });

  it("sells through one shieldDeleverage on the owner's path when the cushion is short", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldDeleverage"]);
    const [repayAssets, collateralToSell, path, minOut] = sender.sent[0]!.args as [bigint, bigint, Hex, bigint];
    expect(path).toBe(PATH);
    expect(collateralToSell).toBeGreaterThan(0n);
    expect(minOut).toBe(repayAssets);
    // Sized against the debt after the in-transaction cushion spend.
    expect(repayAssets).toBeLessThan(1790n * E18);
    expect(feed.list({ kind: "shield" })[0]!.plan).toMatchObject({ kind: "repay+deleverage" });
  });

  it("falls back to a cushion repay when the contract says NotInShieldWindow", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    sender.failing.set("shieldDeleverage", encodeErrorResult({ abi: listaAccountAbi, errorName: "NotInShieldWindow" }));
    await keeper.tick();
    expect(sender.sims.map((c) => c.fn)).toEqual(["shieldDeleverage", "shieldRepay"]);
    expect(sender.sent).toMatchObject([{ fn: "shieldRepay", args: [10n * E18] }]);
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "NotInShieldWindow" }, reason: expect.stringMatching(/falling back/) });
    expect(feed.list({ kind: "shield" })).toHaveLength(1);
    // The refused sale is not re-tried on the next tick.
    sender.sims = [];
    world.accounts = [lista({ cushion: 0n })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });

  it("executes only the cushion repay of an insufficient plan and alerts the owner", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [venus({ cushion: 10n * E18 })];
    await keeper.tick();
    expect(sender.sent).toMatchObject([{ fn: "shieldRepay", args: [10n * E18] }]);
    const alert = feed.list({ kind: "alert" })[0]!;
    expect(alert).toMatchObject({ account: ACCOUNT, reason: expect.stringMatching(/owner decides/) });
    // The alert is not repeated on the next tick of the same window.
    world.accounts = [venus({ cushion: 0n })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "alert" })).toHaveLength(1);
  });

  it("never sends a sale the contract would refuse as OverDeleverage: cushion only, and an alert", async () => {
    const { world, sender, feed, keeper } = await setup();
    // A minimum loan this large makes the sale clear the loan, landing far below the shield LTV.
    world.accounts = [lista({ cushion: 10n * E18, minLoan: 1700n * E18 })];
    await keeper.tick();
    expect(sender.sims.map((c) => c.fn)).not.toContain("shieldDeleverage");
    expect(sender.sent).toMatchObject([{ fn: "shieldRepay" }]);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/OverDeleverage/);
  });

  it("alerts instead of selling when the owner has not set a deleverage path", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18, pathSet: false })];
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldRepay"]);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/deleverage path/);
  });

  it("alerts and repays from the cushion when the owner's path is not one the desk knows", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18, pathHash: `0x${"33".repeat(32)}` })];
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldRepay"]);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/path/);
  });

  it("sends a sale warned 'no sale will happen' as one shieldDeleverage (a pure cushion repay)", async () => {
    const { world, sender, feed, keeper } = await setup();
    // Cushion short of the target but enough to bring LTV under the shield LTV of 70%.
    world.accounts = [lista({ cushion: 60n * E18, mandate: { maxLtvBps: 7400, shieldLtvBps: 7000, maxSlippageBps: 150, autoRestore: true } })];
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldDeleverage"]);
    expect(feed.list({ kind: "shield" })).toHaveLength(1);
  });

  it("never leaves a remainder under minLoan + 2", async () => {
    const { world, sender, keeper } = await setup();
    // Target repay ~88.75 would leave ~1711 against a 1711.5 minimum loan.
    const minLoan = 17_115n * 10n ** 17n;
    world.accounts = [lista({ minLoan, cushion: 100n * E18 })];
    await keeper.tick();
    const assets = sender.sent[0]!.args[0] as bigint;
    const rest = 1800n * E18 - assets;
    expect(rest === 0n || rest >= minLoan + 2n || assets >= 1800n * E18).toBe(true);
  });

  it("re-reads before sending and aborts when the plan no longer holds", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    world.rereads = [lista(), lista({ debt: 1500n * E18 })]; // planning read, then the owner repaid
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/plan changed/);
  });

  it("aborts when the fresh amount moved beyond the tolerance", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    world.rereads = [lista(), lista({ debt: 1810n * E18 })]; // still a cushion repay, but about 11% larger
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ reason: expect.stringMatching(/plan changed/), plan: { now: { fn: "shieldRepay" } } });
  });

  it("goes ahead with the fresh amounts when only interest accrued", async () => {
    const { world, sender, keeper } = await setup();
    world.accounts = [lista()];
    world.rereads = [lista(), lista({ debt: 1800n * E18 + 10n ** 15n })];
    await keeper.tick();
    expect(sender.sent).toHaveLength(1);
  });

  it("records a contract refusal as a first-class event and backs off the account", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.failing.set("shieldRepay", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "BelowMinLoan", args: [5n, 10n] }));
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({
      account: ACCOUNT,
      symbol: "NVDA",
      error: { name: "BelowMinLoan", args: ["5", "10"] },
      sim: { ok: false },
    });
    sender.sims = [];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });

  it("only simulates in DRY_RUN", async () => {
    const { world, sender, feed, keeper } = await setup();
    sender.dryRun = true;
    world.accounts = [lista()];
    await keeper.tick();
    expect(sender.sims).toHaveLength(1);
    expect(sender.sent).toEqual([]);
    expect(feed.list({ kind: "shield" })[0]).toMatchObject({ dryRun: true, sim: { ok: true } });
    expect(feed.list({ kind: "shield" })[0]!.txHash).toBeUndefined();
    expect(feed.preShieldDebt(ACCOUNT)).toBeNull();
  });

  it("records one noop per account and reason, not one per tick", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ debt: 1000n * E18 })];
    await keeper.tick();
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })).toHaveLength(1);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/survives/);
  });

  it("latches a seizure with recordLiquidation and stops shielding", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ liquidated: true, liquidationRecorded: false, collateral: 5n * E18 })];
    await keeper.tick();
    expect(sender.sent).toMatchObject([{ fn: "recordLiquidation", to: ACCOUNT }]);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/liquidat/);
    world.accounts = [lista({ liquidated: true, liquidationRecorded: true, collateral: 5n * E18 })];
    await keeper.tick();
    expect(sender.sent).toHaveLength(1);
  });
});

describe("Keeper restores", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    // A confirmed keeper shield earlier took the debt from 1800 (72% LTV) to 1700.
    await s.feed.record({
      kind: "shield",
      source: "keeper",
      account: ACCOUNT,
      txHash: `0x${"aa".repeat(32)}`,
      plan: { debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 },
    });
  });

  it("borrows back toward the pre-shield debt within the owner's cap, with both simulators required to agree", async () => {
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    await s.keeper.tick();
    expect(s.sender.sent).toMatchObject([{ fn: "restore", args: [100n * E18] }]);
    expect(s.sender.sims).toMatchObject([{ fn: "restore", strict: true }]);
    expect(s.feed.list({ kind: "restore" })[0]).toMatchObject({ txHash: expect.any(String), plan: { kind: "borrow" } });
    expect(s.feed.preShieldDebt(ACCOUNT)).toBeNull();
  });

  it("waits while the oracle says no, with one noop", async () => {
    s.world.oracle = oracle(MORNING, { canAddRisk: false, reason: "TOO_SOON_AFTER_OPEN" });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    await s.keeper.tick();
    await s.keeper.tick();
    expect(s.sender.sims).toEqual([]);
    expect(s.feed.list({ kind: "noop" }).map((e) => e.reason)).toEqual([expect.stringMatching(/TOO_SOON_AFTER_OPEN/)]);
  });

  it("records RestoreRefused as a refusal with the oracle reason", async () => {
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    s.sender.failing.set("restore", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "RestoreRefused", args: [3] }));
    await s.keeper.tick();
    expect(s.feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "RestoreRefused", reason: "NOT_REGULAR" } });
    expect(s.sender.sent).toEqual([]);
  });

  it("treats auto-restore switched off by a sale as expected: one noop and one alert", async () => {
    s.world.accounts = [lista({ debt: 1700n * E18, mandate: { maxLtvBps: 7400, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: false } })];
    await s.keeper.tick();
    s.world.oracle = oracle(MORNING + 300, { canAddRisk: true, reason: "OK" });
    await s.keeper.tick();
    expect(s.sender.sims).toEqual([]);
    expect(s.feed.list({ kind: "noop" }).map((e) => e.reason)).toEqual([expect.stringMatching(/auto-restore is disabled by the owner/)]);
    expect(s.feed.list({ kind: "alert" }).map((e) => e.reason)).toEqual([expect.stringMatching(/re-enable/)]);
  });

  it("does nothing without an open shield cycle", async () => {
    await s.feed.record({ kind: "restore", source: "keeper", account: ACCOUNT, txHash: `0x${"bb".repeat(32)}` });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    await s.keeper.tick();
    expect(s.sender.sims).toEqual([]);
  });
});

describe("Keeper covers", () => {
  const USER = addr(0xf1);
  const KEY = `0x${"44".repeat(32)}` as Hex;
  const entry = (keeper = AGENT): CoverEntry => ({
    user: USER,
    key: KEY,
    cover: {
      venue: "venus",
      marketParams: { loanToken: USDT, collateralToken: NVDAB, oracle: addr(0), irm: addr(0), lltv: 0n },
      vDebt: addr(0xc8),
      token: USDT,
      symbol: "NVDA",
      keeper,
      capPerDay: 500n * E18,
      balance: 300n * E18,
      dayStart: 0,
      usedToday: 0n,
    },
  });

  it("shields a cover with shieldFor in the lead time", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.covers = [entry()];
    world.coverStates.set(KEY, venus({ address: USER, collateral: 1n * E18, debt: 200n * E18, cushion: 300n * E18 }));
    await keeper.tick();
    expect(sender.sent).toHaveLength(1);
    const [user, key, amount] = sender.sent[0]!.args as [Address, Hex, bigint];
    expect(sender.sent[0]!.fn).toBe("shieldFor");
    expect(sender.sent[0]!.to).toBe(d.cushionVault);
    expect([user, key]).toEqual([USER, KEY]);
    expect(amount).toBeGreaterThan(25n * E18);
    expect(amount).toBeLessThan(35n * E18);
    expect(feed.list({ kind: "shield" })[0]).toMatchObject({ account: USER, cover: { user: USER, key: KEY } });
    expect(feed.preShieldDebt(USER)).toBeNull(); // covers never restore
  });

  it("caps a full close at the user's debt plus accrual headroom", async () => {
    const { world, sender, keeper } = await setup();
    world.covers = [{ ...entry(), cover: { ...entry().cover, venue: "lista" } }];
    // The venue minimum forces a full close; the cover holds more than the debt.
    world.coverStates.set(KEY, lista({ address: USER, minLoan: 180n * E18, collateral: 1n * E18, debt: 200n * E18, cushion: 300n * E18, pathSet: false }));
    await keeper.tick();
    expect(sender.sent[0]!.args[2]).toBe(200n * E18 + (200n * E18) / 10_000n + 1n);
  });

  it("skips a cover whose user has no debt", async () => {
    const { world, sender, keeper } = await setup();
    world.covers = [entry()];
    world.coverStates.set(KEY, venus({ address: USER, debt: 0n, cushion: 300n * E18 }));
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });

  it("waits while the vault says it cannot shield yet", async () => {
    const { world, sender, feed, keeper } = await setup({ canShield: false });
    world.covers = [entry()];
    world.coverStates.set(KEY, venus({ address: USER, debt: 1800n * E18, cushion: 300n * E18 }));
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/vault/);
  });

  it("ignores covers kept by someone else", async () => {
    const { world, sender, keeper } = await setup();
    world.covers = [entry(addr(0x99))];
    world.coverStates.set(KEY, venus({ address: USER, debt: 1800n * E18, cushion: 300n * E18 }));
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });
});

describe("Keeper sale failures (C2)", () => {
  const cases: [string, (st: StubSender) => void][] = [
    ["simulation (Too little received)", (st) => st.failing.set("shieldDeleverage", tooLittle)],
    ["simulation (BelowMinLoan)", (st) => st.failing.set("shieldDeleverage", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "BelowMinLoan", args: [1n, 2n] }))],
    ["simulation (RiskNotReduced)", (st) => st.failing.set("shieldDeleverage", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "RiskNotReduced" }))],
    ["gas estimation", (st) => st.outcome.set("shieldDeleverage", "estimate")],
    ["on-chain revert", (st) => st.outcome.set("shieldDeleverage", "revert")],
    ["a thrown broadcast", (st) => st.outcome.set("shieldDeleverage", "throw")],
  ];

  it("treats a dropped sale as a lost nonce race: no fallback, no hold, re-planned next tick", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    sender.outcome.set("shieldDeleverage", "dropped");
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldDeleverage"]);
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "Dropped" } });
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldDeleverage", "shieldDeleverage"]);
  });

  it.each(cases)("falls back to the cushion repay at once after a failed sale at %s, and holds only the sale", async (_name, arrange) => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    arrange(sender);
    await keeper.tick();
    const refused = feed.list({ kind: "refused" });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ plan: { step: { fn: "shieldDeleverage" } }, reason: expect.stringMatching(/falling back to a cushion repay/), data: { onHold: "sale" } });
    expect(sender.sent.at(-1)).toMatchObject({ fn: "shieldRepay", args: [10n * E18], mev: false });
    expect(feed.list({ kind: "shield" })).toHaveLength(1);
    // Next tick: the sale is on hold, the account is not.
    sender.sims = [];
    world.accounts = [lista({ cushion: 0n, debt: 1790n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims.map((c) => c.fn)).not.toContain("shieldDeleverage");
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/on hold/);
  });

  it("sends the sale with MEV protection", async () => {
    const { world, sender, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    await keeper.tick();
    expect(sender.sent).toMatchObject([{ fn: "shieldDeleverage", mev: true, fallback: true }]);
  });

  it("records the cushion repay that went out in the sale's place when the protected broadcast failed", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    sender.outcome.set("shieldDeleverage", "fallback");
    sender.logs.set("shieldRepay", [shieldedLog(1800n * E18, 1790n * E18)]);
    await keeper.tick();
    expect(sender.sent.map((c) => [c.fn, c.mev])).toEqual([
      ["shieldDeleverage", true],
      ["shieldRepay", false],
    ]);
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "SaleNotSent" }, reason: expect.stringMatching(/not sent publicly.*cushion repay was sent instead/), data: { onHold: "sale" } });
    expect(feed.list({ kind: "shield" })[0]).toMatchObject({
      plan: { step: { fn: "shieldRepay", assets: (10n * E18).toString() }, debtBefore: (1800n * E18).toString(), debtAfter: (1790n * E18).toString() },
      data: { fallbackFor: "shieldDeleverage" },
    });
    // The sale is on hold; the next tick does not try it again.
    sender.sims = [];
    world.accounts = [lista({ cushion: 0n, debt: 1790n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims.map((c) => c.fn)).not.toContain("shieldDeleverage");
  });

  it("keeps one more sale attempt before the close: the hold ends 6 min before it", async () => {
    const { world, sender, feed, keeper } = await setup({ oracle: oracle(CLOSE - 600) });
    world.accounts = [lista({ cushion: 10n * E18 })];
    sender.outcome.set("shieldDeleverage", "revert");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]!.data).toMatchObject({ backoffUntil: CLOSE - 360 });
    sender.sims = [];
    world.accounts = [lista({ cushion: 0n, debt: 1790n * E18 })];
    world.oracle = oracle(CLOSE - 300);
    await keeper.tick();
    expect(sender.sims.map((c) => c.fn)).toContain("shieldDeleverage");
  });

  it("alerts when a sale fails and there is no cushion to fall back on", async () => {
    const { world, sender, feed, keeper } = await setup();
    // No cushion at all: the whole shield is the sale.
    world.accounts = [lista({ cushion: 0n })];
    sender.outcome.set("shieldDeleverage", "revert");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]!.reason).toMatch(/no cushion to fall back on/);
    expect(feed.list({ kind: "alert" }).map((e) => e.reason)).toContainEqual(expect.stringMatching(/sale failed/));
  });

  it("records a thrown broadcast of a repay as a refusal and backs it off", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "throw");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "BroadcastFailed", message: expect.stringMatching(/invalid sender/) } });
    sender.sims = [];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims).toEqual([]);
  });
});

describe("shieldedDebts", () => {
  it("spans a keeper sale: the cushion spend's debtBefore to the sale's debtAfter, this account only", () => {
    const logs = [
      shieldedLog(999n, 1n, 0, 0n, addr(0x99)), // another account in the same receipt
      shieldedLog(1800n, 1790n), // cushion spend
      { address: ACCOUNT, topics: [`0x${"12".repeat(32)}`] as Hex[], data: "0x" as Hex }, // some other event
      shieldedLog(1790n, 1200n, 1, 3n), // the sale
    ];
    expect(shieldedDebts(logs, ACCOUNT)).toEqual({ before: 1800n, after: 1200n });
    expect(shieldedDebts([], ACCOUNT)).toBeNull();
    expect(shieldedDebts(undefined, ACCOUNT)).toBeNull();
  });
});

describe("trimSale", () => {
  it("shrinks the flash loan to leave minLoan + 2 and the sale in proportion, rounded up", () => {
    // debt after the cushion 1000, minLoan 100: a flash of 950 would leave 50 < 102.
    expect(trimSale(950n, 9500n, 1000n, 100n)).toEqual({ flash: 898n, sell: 8980n });
    expect(trimSale(950n, 9501n, 1000n, 100n)).toEqual({ flash: 898n, sell: 8981n }); // ceil(9501 * 898 / 950)
  });

  it("leaves a sale that clears the loan or leaves enough alone", () => {
    expect(trimSale(1000n, 7n, 1000n, 100n)).toEqual({ flash: 1000n, sell: 7n });
    expect(trimSale(800n, 7n, 1000n, 100n)).toEqual({ flash: 800n, sell: 7n });
    expect(trimSale(950n, 7n, 1000n, null)).toEqual({ flash: 950n, sell: 7n });
  });

  it("trims to nothing when the debt is already at the minimum", () => {
    expect(trimSale(50n, 5n, 101n, 100n)).toEqual({ flash: 0n, sell: 0n });
  });
});

describe("Keeper pending transactions (C1, N2, N3)", () => {
  it("records an unmined shield as pending (no shield, no restore cycle) and confirms it from the receipt logs", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    const pending = feed.list({ kind: "pending" })[0]!;
    expect(pending).toMatchObject({ account: ACCOUNT, txHash: hashOf(1), data: { intent: "shield", nonce: 1 } });
    expect(feed.list({ kind: "shield" })).toEqual([]);
    expect(feed.shieldCycle(ACCOUNT)).toBeNull();

    sender.confirms.set(hashOf(1), { status: "success", logs: [shieldedLog(1800n * E18, 1711n * E18)] });
    world.accounts = [lista({ debt: 1711n * E18, cushion: 11n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "shield" })[0]).toMatchObject({
      txHash: hashOf(1),
      plan: { debtBefore: (1800n * E18).toString(), debtAfter: (1711n * E18).toString() },
      data: { confirmedLater: true, pendingTx: hashOf(1) },
    });
    expect(feed.shieldCycle(ACCOUNT)).toMatchObject({ preShieldDebt: 1800n * E18, postShieldDebt: 1711n * E18, repaid: 89n * E18 });
  });

  it("takes the debts from the receipt even when the owner repaid between send and confirm (N3)", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    // Mined at 1800 -> 1711; then the owner repaid 300 before the keeper looked again.
    sender.confirms.set(hashOf(1), { status: "success", logs: [shieldedLog(1800n * E18, 1711n * E18)] });
    world.accounts = [lista({ debt: 1411n * E18, cushion: 11n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.shieldCycle(ACCOUNT)).toMatchObject({ postShieldDebt: 1711n * E18, repaid: 89n * E18 });
    // At the open the debt is below what the shield left: the owner acted, nothing is restored.
    world.oracle = oracle(MORNING + 86_400, { canAddRisk: true, reason: "OK" });
    await keeper.tick();
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ data: { cycleClosed: true } });
    expect(sender.sent.map((c) => c.fn)).toEqual(["shieldRepay"]);
  });

  it("records a speed-up that was mined instead under its own hash, naming the pending one", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    const faster = `0x${"fa".repeat(32)}` as Hex;
    sender.confirms.set(hashOf(1), { status: "success", txHash: faster, logs: [shieldedLog(1800n * E18, 1711n * E18)] });
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "shield" }).find((e) => e.txHash === faster)).toMatchObject({ data: { replaces: hashOf(1), pendingTx: hashOf(1) } });
    expect(feed.unresolvedPending("keeper")).toEqual([]);
  });

  it("leaves the account alone while its send is unmined (N2)", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    world.oracle = oracle(LEAD + 300);
    await keeper.tick(); // still pending
    expect(sender.sent).toHaveLength(1);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/waiting for the desk's pending transaction/);
  });

  it("re-plans in the same tick once the pending send turns out dropped, without a back-off", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    sender.confirms.set(hashOf(1), { status: "dropped" });
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ txHash: hashOf(1), error: { name: "Dropped" } });
    expect(sender.sent).toHaveLength(2);
    expect(feed.list({ kind: "shield" })).toMatchObject([{ txHash: hashOf(2) }]);
    expect(feed.list({ kind: "alert" }).filter((e) => /last minutes/.test(e.reason ?? ""))).toEqual([]); // not yet in the last minutes
  });

  it("alerts when a shield is dropped in the last minutes before the close (N4)", async () => {
    const { world, sender, feed, keeper } = await setup({ oracle: oracle(CLOSE - 300) });
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "dropped");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "Dropped" } });
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/replaced before it was mined in the last minutes/);
  });

  it("records a pending shield that reverted when mined as a refusal", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    sender.confirms.set(hashOf(1), { status: "reverted" });
    world.accounts = [lista({ debt: 1000n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ txHash: hashOf(1), error: { name: "Reverted" } });
  });

  it("after a restart with a send pending at N, sends nothing else for that account until it settles (N2)", async () => {
    const first = await setup();
    first.world.accounts = [lista()];
    first.sender.outcome.set("shieldRepay", "pending");
    await first.keeper.tick();
    // Restart: a new keeper on the same feed; the restore window opens while the shield is still unmined.
    const restarted = new Keeper({ deployment: d, reads: first.reads, sender: first.sender, feed: first.feed });
    first.world.oracle = oracle(MORNING + 86_400, { canAddRisk: true, reason: "OK" });
    await restarted.tick();
    expect(first.sender.sent).toHaveLength(1);
    // Mined at last: recorded from its receipt.
    first.sender.confirms.set(hashOf(1), { status: "success", logs: [shieldedLog(1800n * E18, 1711n * E18)] });
    first.world.accounts = [lista({ debt: 1711n * E18 })];
    first.world.oracle = oracle(LEAD + 300);
    await restarted.tick();
    expect(first.feed.list({ kind: "shield" })[0]).toMatchObject({ txHash: hashOf(1), plan: { debtAfter: (1711n * E18).toString() } });
  });

  it("records a confirmed shield without receipt logs with an unknown debtAfter (nothing to restore)", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    await keeper.tick();
    expect(feed.list({ kind: "shield" })[0]!.plan).toMatchObject({ debtBefore: (1800n * E18).toString(), debtAfter: null });
    expect(feed.shieldCycle(ACCOUNT)).toMatchObject({ repaid: 0n });
    expect(sender.sent).toHaveLength(1);
  });

  it("records a dropped repay as a refusal without a back-off", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "dropped");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ txHash: hashOf(1), error: { name: "Dropped" } });
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sent).toHaveLength(2);
  });

  it("records a pending send the sender's own cancel replaced (after a restart) as a noop, and re-plans", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    sender.confirms.set(hashOf(1), { status: "dropped", minedAs: "cancel", txHash: `0x${"cc".repeat(32)}` });
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "noop" }).map((e) => e.reason)).toContainEqual(expect.stringMatching(/cancelled before it was mined/));
    expect(feed.list({ kind: "refused" })).toEqual([]);
    expect(sender.sent).toHaveLength(2); // settled: the shield is planned again in the same tick
    expect(feed.unresolvedPending("keeper")).toEqual([]);
  });

  it("records the sale's cushion repay when that is what a pending sale turned into", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ cushion: 10n * E18 })];
    const realSend = sender.send.bind(sender);
    sender.send = async (input, opts) => {
      await opts?.fallback?.({ round: 1 }); // the sender built the stand-in before it halted
      return realSend(input, opts);
    };
    sender.outcome.set("shieldDeleverage", "pending");
    await keeper.tick();
    expect(feed.list({ kind: "pending" })[0]!.data).toMatchObject({ fallbackStep: { fn: "shieldRepay" } });
    sender.confirms.set(hashOf(1), { status: "success", minedAs: "fallback", txHash: `0x${"fb".repeat(32)}`, logs: [shieldedLog(1800n * E18, 1790n * E18)] });
    world.accounts = [lista({ cushion: 0n, debt: 1000n * E18 })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(feed.list({ kind: "shield" })[0]).toMatchObject({ txHash: `0x${"fb".repeat(32)}`, plan: { step: { fn: "shieldRepay" } }, data: { fallbackFor: "shieldDeleverage" } });
  });
});

describe("Keeper and a slow or halted sender (R38)", () => {
  it("re-sends a shield as it was after a timeout, even when the lead window has ended meanwhile", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "rebuild");
    sender.beforeRebuild = () => {
      world.oracle = oracle(CLOSE + 600, { session: "POST" }); // the market closed while it sat unmined
    };
    await keeper.tick();
    expect(sender.rebuilt).toEqual(["shieldRepay"]);
    expect(feed.list({ kind: "shield" })).toHaveLength(1);
  });

  it("lets a stuck shield be cancelled only when the contract would no longer take it", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "rebuild");
    sender.beforeRebuild = () => {
      sender.failing.set("shieldRepay", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "InsufficientCushion", args: [0n, 1n] }));
    };
    await keeper.tick();
    expect(sender.rebuilt).toEqual([null]);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/no longer valid: its nonce was cancelled/);
    expect(feed.list({ kind: "refused" })).toEqual([]);
  });

  it("cancels a stuck restore once the oracle no longer allows it", async () => {
    const s = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    await s.feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, txHash: `0x${"aa".repeat(32)}`, plan: { debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 } });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    s.sender.outcome.set("restore", "rebuild");
    s.sender.beforeRebuild = () => {
      s.world.oracle = oracle(MORNING + 60, { canAddRisk: false, reason: "FLAGGED" });
    };
    await s.keeper.tick();
    expect(s.sender.rebuilt).toEqual([null]);
    expect(s.feed.list({ kind: "restore" })).toEqual([]);
    expect(s.feed.shieldCycle(ACCOUNT)).not.toBeNull(); // nothing was restored: the cycle stays open
  });

  it("cancels a stuck restore when the plan is no longer the same", async () => {
    const s = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    await s.feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, txHash: `0x${"aa".repeat(32)}`, plan: { debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 } });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    s.sender.outcome.set("restore", "rebuild");
    s.sender.beforeRebuild = () => {
      s.world.accounts = [lista({ debt: 1750n * E18 })]; // the owner borrowed meanwhile: 50 would be the plan now, not 100
    };
    await s.keeper.tick();
    expect(s.sender.rebuilt).toEqual([null]);
  });

  it("re-sends a stuck restore while it is still the plan", async () => {
    const s = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    await s.feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, txHash: `0x${"aa".repeat(32)}`, plan: { debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 } });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    s.sender.outcome.set("restore", "rebuild");
    await s.keeper.tick();
    expect(s.sender.rebuilt).toEqual(["restore"]);
    expect(s.feed.list({ kind: "restore" })).toHaveLength(1);
  });

  it("says SENDER_HALTED once per subject and alerts once per halt", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.halt = STUCK;
    await keeper.tick();
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sent).toEqual([]);
    expect(feed.list({ kind: "refused" })).toMatchObject([{ account: ACCOUNT, error: { name: "SENDER_HALTED" }, reason: expect.stringMatching(/^SENDER_HALTED \(STUCK\)/), data: { sender: "halted" } }]);
    expect(feed.list({ kind: "alert" })).toMatchObject([{ reason: expect.stringMatching(/sender is HALTED \(STUCK\)/), data: { sender: "halted", halt: { nonce: 7 } } }]);
    // A new halt later is a new alert.
    sender.halt = { ...STUCK, since: STUCK.since + 3600, reason: "FEE_BUDGET" };
    world.oracle = oracle(LEAD + 600);
    await keeper.tick();
    expect(feed.list({ kind: "alert" })).toHaveLength(2);
    expect(feed.list({ kind: "refused" })).toHaveLength(2);
  });

  it("alerts at the start of a tick even with nothing to send", async () => {
    const { sender, feed, keeper } = await setup();
    sender.halt = STUCK;
    await keeper.tick();
    expect(feed.list({ kind: "alert" })).toHaveLength(1);
  });

  it("tracks a shield the sender halted on as pending and alerts", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    expect(feed.list({ kind: "pending" })).toHaveLength(1);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/HALTED/);
    expect(feed.list({ kind: "shield" })).toEqual([]);
  });

  it("records a send cancelled after a timeout as a noop, not a refusal", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "cancel");
    await keeper.tick();
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/nonce was cancelled/);
    expect(feed.list({ kind: "refused" })).toEqual([]);
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sent).toHaveLength(2); // no back-off
  });

  it("records a halted recordLiquidation once and alerts", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ liquidated: true, liquidationRecorded: false })];
    sender.outcome.set("recordLiquidation", "halted");
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "SENDER_HALTED" } });
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/HALTED/);
  });
});

describe("Keeper sizing and dust (R39 additions)", () => {
  it("sizes the repay against the accrued debt, so the next tick has nothing to top up", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    await keeper.tick();
    const assets = sender.sent[0]!.args[0] as bigint;
    // Target debt is 1711.25; with one basis point of accrual on 1800 the repay must cover 88.93, not 88.75.
    expect(assets).toBeGreaterThanOrEqual(8893n * 10n ** 16n);
    expect(assets).toBeLessThan(90n * E18);
    // After it the debt has accrued a little (0.05): the remaining shortfall is dust, not another transaction.
    world.accounts = [lista({ debt: 1800n * E18 + 5n * 10n ** 16n - assets, cushion: 100n * E18 - assets })];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sims).toHaveLength(1);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/dust|survives/);
  });

  it("skips a dust repay", async () => {
    const { world, sender, feed, keeper } = await setup();
    // A cent over the target debt of 1711.25.
    world.accounts = [lista({ debt: 171_126n * 10n ** 16n, cushion: 11n * E18 })];
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/dust/);
    expect(keeper.shieldBusy()).toBe(false);
  });

  it("knows dust: under max(0.05 units, 0.1% of the debt), unless it closes the loan", () => {
    expect(isDust(4n * 10n ** 16n, 10n * E18, 18)).toBe(true); // 0.04 < 0.05
    expect(isDust(6n * 10n ** 16n, 10n * E18, 18)).toBe(false);
    expect(isDust(1n * E18, 1800n * E18, 18)).toBe(true); // 1 < 1.8 (0.1%)
    expect(isDust(2n * E18, 1800n * E18, 18)).toBe(false);
    expect(isDust(3n * 10n ** 16n, 3n * 10n ** 16n, 18)).toBe(false); // a full close
    expect(isDust(40_000n, 10_000_000n, 6)).toBe(true); // 0.04 USDT-style units
  });
});

describe("Keeper.shieldBusy (R39)", () => {
  it("is true from the moment a shield is planned in a lead window until it is done", async () => {
    const { world, sender, keeper } = await setup();
    expect(keeper.shieldBusy()).toBe(false);
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "revert"); // planned, attempted, refused: still to do
    await keeper.tick();
    expect(keeper.shieldBusy()).toBe(true);
    world.oracle = oracle(LEAD + 900);
    await keeper.tick(); // retried after the back-off and mined
    expect(sender.sent).toHaveLength(2);
    expect(keeper.shieldBusy()).toBe(false);
  });

  it("is true while a shield is pending and false again once the closure has started", async () => {
    const { world, sender, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "pending");
    await keeper.tick();
    expect(keeper.shieldBusy()).toBe(true);
    sender.confirms.set(hashOf(1), { status: "reverted" });
    world.accounts = [lista({ cushion: 0n })]; // nothing left to repay with: insufficient, no step
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(keeper.shieldBusy()).toBe(false);
  });

  it("is true for a pending shield found in the feed after a restart", async () => {
    const first = await setup();
    first.world.accounts = [lista()];
    first.sender.outcome.set("shieldRepay", "pending");
    await first.keeper.tick();
    const restarted = new Keeper({ deployment: d, reads: first.reads, sender: first.sender, feed: first.feed, clock: () => first.world.oracle.at });
    expect(restarted.shieldBusy()).toBe(false); // nothing loaded yet
    first.world.oracle = oracle(MORNING + 86_400, { canAddRisk: true, reason: "OK" }); // no lead window, only the pending send
    await restarted.tick();
    expect(restarted.shieldBusy()).toBe(true);
  });

  it("forgets a plan once its window has begun, and is false outside lead windows", async () => {
    const { world, sender, keeper } = await setup();
    world.accounts = [lista()];
    sender.outcome.set("shieldRepay", "revert");
    await keeper.tick();
    expect(keeper.shieldBusy()).toBe(true);
    world.oracle = oracle(CLOSE + 60, { session: "POST" });
    expect(keeper.shieldBusy()).toBe(false);

    const quiet = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    quiet.world.accounts = [lista()];
    await quiet.keeper.tick();
    expect(quiet.keeper.shieldBusy()).toBe(false);
  });
});

describe("Keeper restore cycle (I3)", () => {
  const cycle = { preShieldDebt: 1800n * E18, preShieldLtvBps: 7200, postShieldDebt: 1700n * E18, repaid: 100n * E18, shields: 1 };

  it("targets at most what the keeper repaid, the pre-shield debt and the pre-shield LTV", () => {
    expect(restoreTargetUsd(lista({ debt: 1700n * E18 }), cycle)).toBeCloseTo(1800, 6);
    expect(restoreTargetUsd(lista({ debt: 1700n * E18 }), { ...cycle, repaid: 30n * E18 })).toBeCloseTo(1730, 6);
    // The price fell 20%: 72% of the collateral is now worth 1440.
    const cheaper = lista({ debt: 1700n * E18 });
    expect(restoreTargetUsd({ ...cheaper, pricing: { ...cheaper.pricing, collateralPriceUsd: 200 } }, cycle)).toBeCloseTo(1440, 6);
    expect(restoreTargetUsd(lista({ debt: 1700n * E18 }), { ...cycle, preShieldLtvBps: null })).toBeCloseTo(1800, 6);
  });

  async function restoring(shield: Record<string, unknown>) {
    const s = await setup({ oracle: oracle(MORNING, { canAddRisk: true, reason: "OK" }) });
    await s.feed.record({ kind: "shield", source: "keeper", account: ACCOUNT, txHash: `0x${"aa".repeat(32)}`, plan: shield });
    return s;
  }

  it("borrows back only what it repaid when the debt read after the shield is known", async () => {
    const s = await restoring({ debtBefore: (1800n * E18).toString(), debtAfter: (1760n * E18).toString(), ltvBps: 7200 });
    s.world.accounts = [lista({ debt: 1760n * E18 })];
    await s.keeper.tick();
    expect(s.sender.sent).toMatchObject([{ fn: "restore", args: [40n * E18] }]);
  });

  it("borrows nothing when it cannot tell what it repaid", async () => {
    const s = await restoring({ debtBefore: (1800n * E18).toString(), ltvBps: 7200 });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    await s.keeper.tick();
    expect(s.sender.sims).toEqual([]);
    expect(s.feed.list({ kind: "noop" })[0]!.reason).toMatch(/already at or above/);
  });

  it("closes the cycle with a noop and an alert when the owner repaid since the shield", async () => {
    const s = await restoring({ debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 });
    s.world.accounts = [lista({ debt: 1500n * E18 })];
    await s.keeper.tick();
    expect(s.sender.sims).toEqual([]);
    expect(s.feed.list({ kind: "noop" })[0]).toMatchObject({ reason: expect.stringMatching(/owner acted/), data: { cycleClosed: true } });
    expect(s.feed.list({ kind: "alert" })[0]!.reason).toMatch(/will not borrow back/);
    expect(s.feed.shieldCycle(ACCOUNT)).toBeNull();
  });

  it("closes the cycle when the owner closed a loan the keeper did not", async () => {
    const s = await restoring({ debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 });
    s.world.accounts = [lista({ debt: 0n })];
    await s.keeper.tick();
    expect(s.feed.list({ kind: "noop" })[0]).toMatchObject({ reason: expect.stringMatching(/repaid in full/), data: { cycleClosed: true } });
  });

  it("blocks a restore when Binance and eth_call disagree, and reports repeated disagreements", async () => {
    const s = await restoring({ debtBefore: (1800n * E18).toString(), debtAfter: (1700n * E18).toString(), ltvBps: 7200 });
    s.world.accounts = [lista({ debt: 1700n * E18 })];
    s.sender.disagree.add("restore");
    for (let i = 0; i < 3; i++) {
      s.world.oracle = oracle(MORNING + i * 1000, { canAddRisk: true, reason: "OK" });
      await s.keeper.tick();
    }
    expect(s.sender.sent).toEqual([]);
    expect(s.feed.list({ kind: "refused" })).toHaveLength(3);
    expect(s.feed.list({ kind: "refused" })[0]!.error!.name).toBe("SimulatorsDisagree");
    expect(s.feed.list({ kind: "finding" })).toMatchObject([{ source: "keeper", reason: expect.stringMatching(/disagreed 3 times/) }]);
  });
});

describe("Keeper hygiene", () => {
  it("re-plans inside the send: a change while waiting for the nonce aborts the send", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista()];
    sender.beforeBuild = () => {
      world.accounts = [lista({ debt: 1500n * E18 })]; // another transaction landed while this one waited
    };
    await keeper.tick();
    expect(sender.sims).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]!.reason).toMatch(/plan changed before send/);
  });

  it("skips a tick while the previous one is still running", async () => {
    const { world, keeper, sender } = await setup();
    world.accounts = [lista()];
    const [a, b] = await Promise.all([keeper.tick(), keeper.tick()]);
    expect([a.busy, b.busy]).toEqual([undefined, true]);
    expect(sender.sent).toHaveLength(1);
  });

  it("alerts once when the desk key runs low on BNB", async () => {
    const { world, feed, keeper } = await setup({}, { gas: (sender, f) => new GasWatch({ sender: { address: sender.address, balance: async () => 10n ** 15n }, feed: f, minWei: 3n * 10n ** 15n }) });
    world.accounts = [];
    await keeper.tick();
    await keeper.tick();
    expect(feed.list({ kind: "alert" })).toMatchObject([{ source: "keeper", reason: expect.stringMatching(/BNB/) }]);
  });

  it("records a failed recordLiquidation", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ liquidated: true, liquidationRecorded: false })];
    sender.failing.set("recordLiquidation", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "Locked" }));
    await keeper.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "Locked" }, plan: { step: { fn: "recordLiquidation" } } });
    sender.sims = [];
    world.oracle = oracle(LEAD + 300);
    await keeper.tick();
    expect(sender.sims).toEqual([]); // backed off
  });

  it("records the same recordLiquidation refusal once a day", async () => {
    const { world, sender, feed, keeper } = await setup();
    world.accounts = [lista({ liquidated: true, liquidationRecorded: false })];
    sender.failing.set("recordLiquidation", encodeErrorResult({ abi: ballastAccountBaseAbi, errorName: "Locked" }));
    for (let i = 0; i < 6; i++) {
      world.oracle = oracle(LEAD + i * 1000);
      await keeper.tick();
    }
    expect(sender.sims.length).toBeGreaterThan(1); // retried after each back-off
    expect(feed.list({ kind: "refused" })).toHaveLength(1);
    world.oracle = oracle(LEAD + 86_400 + 1000);
    await keeper.tick();
    expect(feed.list({ kind: "refused" })).toHaveLength(2);
  });

  it("puts the whole cushion on the debt when the venue cannot price the collateral (M14)", async () => {
    const { world, sender, feed, keeper } = await setup();
    const s = lista();
    world.accounts = [{ ...s, ltvBps: null, pricing: { ...s.pricing, collateralPriceUsd: null } }];
    await keeper.tick();
    expect(sender.sent).toMatchObject([{ fn: "shieldRepay", args: [100n * E18] }]);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/cannot price/);
  });

  it("does the same for a cover", async () => {
    const { world, sender, keeper } = await setup();
    const KEY = `0x${"55".repeat(32)}` as Hex;
    const USER = addr(0xf2);
    world.covers = [
      {
        user: USER,
        key: KEY,
        cover: { venue: "venus", marketParams: { loanToken: USDT, collateralToken: NVDAB, oracle: addr(0), irm: addr(0), lltv: 0n }, vDebt: addr(0xc8), token: USDT, symbol: "NVDA", keeper: AGENT, capPerDay: 500n * E18, balance: 300n * E18, dayStart: 0, usedToday: 0n },
      },
    ];
    const v = venus({ address: USER, cushion: 300n * E18 });
    world.coverStates.set(KEY, { ...v, pricing: { ...v.pricing, collateralPriceUsd: null } });
    await keeper.tick();
    expect(sender.sent).toMatchObject([{ fn: "shieldFor", args: [USER, KEY, 300n * E18] }]);
  });
});
