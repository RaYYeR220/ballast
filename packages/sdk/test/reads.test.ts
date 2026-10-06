import { describe, expect, it } from "vitest";
import { toHex, type Hex } from "viem";
import {
  accountState,
  ballastFactoryAbi,
  ballastGuardianAbi,
  cushionVaultAbi,
  guardianJobs,
  kernelAbi,
  listAccounts,
  listCovers,
  oracleSnapshot,
  readGuardianJobs,
  sessionCalendarAbi,
  sessionOracleAbi,
  sessionState,
} from "../src/index";
import { addr, FakeChain, MULTICALL3 } from "./fake-chain";
import { d, E18, KEEPER, listaAccount, MARKET_ID, mp, NVDA, NVDAB, OWNER, UINT_MAX, USD1, USDT, V_NVDAB, V_USDT, venusAccount } from "./fixtures";

const ACCOUNT = addr(0xd1);

describe("accountState", () => {
  it("reads a Lista account with venue pricing", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT);
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s).toMatchObject({
      address: ACCOUNT,
      venue: "lista",
      owner: OWNER,
      keeper: KEEPER,
      symbol: "NVDA",
      mandate: { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true },
      collateral: 10n * E18,
      debt: 1000n * E18,
      cushion: 100n * E18,
      ltvBps: 4000,
      healthKnown: true,
      healthy: true,
      liquidated: false,
      liquidationRecorded: false,
      trackedCollateral: 10n * E18,
      loanToken: USD1,
      collateralToken: NVDAB,
      loanDecimals: 18,
      collateralDecimals: 18,
    });
    expect(s.market).toMatchObject({ venue: "lista", marketId: MARKET_ID, marketParams: mp, deleveragePathSet: true, minLoan: E18 });
    expect(s.pricing).toEqual({ collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: 1, minLoanKnown: true });
  });

  it("pins every read to the head block", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT);
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.blockNumber).toBe(chain.blockNumber);
    const reads = chain.requests.filter((r) => r.method === "eth_call" || r.method === "eth_getCode");
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.every((r) => r.block === toHex(chain.blockNumber))).toBe(true);
    const pinned = await accountState(chain.client(), d, ACCOUNT, { blockNumber: 77n });
    expect(pinned.blockNumber).toBe(77n);
    expect(chain.requests.at(-1)?.block).toBe(toHex(77n));
  });

  it("flags an unreadable minimum loan instead of assuming zero", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT, { minLoan: "revert" });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.pricing.minLoanKnown).toBe(false);
    expect(s.market.venue === "lista" && s.market.minLoan).toBeNull();
  });

  it("reports a Lista account whose price is unavailable as ltv null and health unknown", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT, { ltvBps: "revert", health: [false, false], price: "revert" });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.ltvBps).toBeNull();
    expect(s.healthKnown).toBe(false);
    expect(s.healthy).toBe(false);
    expect(s.pricing.collateralPriceUsd).toBeNull();
    expect(s.market.venue === "lista" && s.market.oraclePrice).toBeNull();
  });

  it("marks an unset deleverage path", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT, { pathHash: `0x${"00".repeat(32)}` });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.market.venue === "lista" && s.market.deleveragePathSet).toBe(false);
  });

  it("maps an infinite on-chain LTV to Infinity", async () => {
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT, { ltvBps: UINT_MAX });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.ltvBps).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads a Venus account with the liquidation threshold and oracle prices", async () => {
    const chain = new FakeChain();
    venusAccount(chain, ACCOUNT, { liquidated: true, liquidationRecorded: true, health: [true, false] });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s).toMatchObject({ venue: "venus", loanToken: USDT, liquidated: true, liquidationRecorded: true, healthKnown: true, healthy: false });
    expect(s.market).toMatchObject({
      venue: "venus",
      vCollateral: V_NVDAB,
      vDebt: V_USDT,
      collateralFactor: 5n * 10n ** 17n,
      liquidationThreshold: 6n * 10n ** 17n,
      collateralPrice: 250n * E18,
      debtPrice: E18,
    });
    expect(s.pricing).toEqual({ collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.6, minLoanUsd: 0, minLoanKnown: true });
  });

  it("reports a Venus account whose price is unavailable as ltv null and health unknown", async () => {
    const chain = new FakeChain();
    venusAccount(chain, ACCOUNT, { ltvBps: "revert", health: [false, false], price: "revert" });
    const s = await accountState(chain.client(), d, ACCOUNT);
    expect(s.ltvBps).toBeNull();
    expect(s.healthKnown).toBe(false);
    expect(s.pricing.collateralPriceUsd).toBeNull();
  });

  it("rejects an address that is not a Ballast account clone", async () => {
    const chain = new FakeChain();
    await expect(accountState(chain.client(), d, ACCOUNT)).rejects.toThrow(/not a Ballast account/);
  });

  it("does not hide RPC failures as missing prices", async () => {
    // Only reverts mean "price unavailable"; a transport failure on the same read must surface.
    const chain = new FakeChain();
    listaAccount(chain, ACCOUNT, { price: "fail" });
    await expect(accountState(chain.client(), d, ACCOUNT)).rejects.toThrow(/connection reset/);
  });
});

describe("oracleSnapshot", () => {
  const o = d.sessionOracle;
  const c = d.calendar;
  const ts = 1_790_000_000n;
  function base(chain: FakeChain) {
    chain.timestamp = ts;
    return chain
      .on(c, sessionCalendarAbi, "session", [ts], 5)
      .on(o, sessionOracleAbi, "rawPrice", [NVDA], [25_000_000_000n, true])
      .on(o, sessionOracleAbi, "perSharePrice", [NVDA], [25_010_000_000n, true])
      .on(o, sessionOracleAbi, "referenceFor", [NVDA], [24_990_000_000n, ts - 600n, true])
      .on(o, sessionOracleAbi, "converged", [NVDA], [true, 8n, 0])
      .on(o, sessionOracleAbi, "windowAhead", [NVDA], [1, 1_790_003_600n, 1_790_066_000n, 417])
      .on(o, sessionOracleAbi, "currentWindow", [NVDA], [0, 0, 0n])
      .on(o, sessionOracleAbi, "params", [], [5400, 10800, 60, 93600, 21600, 100, 300])
      .on(o, sessionOracleAbi, "overlay", [NVDA], {
        validUntil: 1_790_010_000n,
        nextEarnings: 1_791_000_000n,
        flags: 4,
        ondoMultiplier: 10n ** 18n,
        referencePrice: 0n,
        postedAt: ts - 100n,
      });
  }

  it("decodes the refusal reason to its enum name", async () => {
    const chain = base(new FakeChain()).on(o, sessionOracleAbi, "canAddRisk", [NVDA], [false, 10]);
    const s = await oracleSnapshot(chain.client(), d, "NVDA");
    expect(s).toMatchObject({
      symbol: "NVDA",
      at: Number(ts),
      session: "REGULAR",
      rawPrice: 25_000_000_000n,
      perShare: 25_010_000_000n,
      reference: 24_990_000_000n,
      referenceUpdatedAt: Number(ts) - 600,
      converged: true,
      devBps: 8,
      convergedReason: "OK",
      canAddRisk: false,
      reason: "WINDOW_AHEAD",
      windowAhead: { window: "OVERNIGHT", startsAt: 1_790_003_600, endsAt: 1_790_066_000, gapBps: 417 },
      currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 },
      overlay: { validUntil: 1_790_010_000, nextEarnings: 1_791_000_000, flags: 4, flagNames: ["EARNINGS_WINDOW"], fresh: true },
    });
    expect(s.reasonText).toMatch(/closure/);
    expect(s.params).toEqual({
      restoreDelay: 5400,
      horizon: 10800,
      convergenceBps: 60,
      maxRefAge: 93600,
      maxOverlayTtl: 21600,
      maxOndoDriftBps: 100,
      maxRefDeviationBps: 300,
    });
  });

  it("reports unavailable prices as null with PRICE_UNAVAILABLE", async () => {
    const chain = base(new FakeChain())
      .on(o, sessionOracleAbi, "rawPrice", [NVDA], [0n, false])
      .on(o, sessionOracleAbi, "perSharePrice", [NVDA], [0n, false])
      .on(o, sessionOracleAbi, "referenceFor", [NVDA], [0n, 0n, false])
      .on(o, sessionOracleAbi, "converged", [NVDA], [false, 0n, 7])
      .on(o, sessionOracleAbi, "canAddRisk", [NVDA], [false, 7]);
    const s = await oracleSnapshot(chain.client(), d, NVDA);
    expect(s).toMatchObject({ rawPrice: null, perShare: null, reference: null, referenceUpdatedAt: null, converged: false });
    expect(s.convergedReason).toBe("PRICE_UNAVAILABLE");
    expect(s.reason).toBe("PRICE_UNAVAILABLE");
  });
});

describe("sessionState", () => {
  it("reads the calendar at the latest block time", async () => {
    const chain = new FakeChain();
    const ts = chain.timestamp;
    const c = d.calendar;
    chain
      .on(c, sessionCalendarAbi, "session", [ts], 3)
      .on(c, sessionCalendarAbi, "nextClose", [ts], 1_790_050_000n)
      .on(c, sessionCalendarAbi, "nextOpen", [ts], 1_790_020_000n)
      .on(c, sessionCalendarAbi, "nextWindow", [ts], [2, 1_790_050_000n, 1_790_250_000n])
      .on(c, sessionCalendarAbi, "currentWindow", [ts], [1, 1_789_990_000n, 1_790_020_000n]);
    const s = await sessionState(chain.client(), d);
    expect(s).toEqual({
      at: Number(ts),
      blockNumber: chain.blockNumber,
      session: "OVERNIGHT",
      nextClose: 1_790_050_000,
      nextOpen: 1_790_020_000,
      window: { kind: "WEEKEND", startsAt: 1_790_050_000, endsAt: 1_790_250_000 },
      current: { kind: "OVERNIGHT", closedAt: 1_789_990_000, opensAt: 1_790_020_000 },
    });
  });
});

describe("listAccounts", () => {
  it("enumerates every account through the factory registry", async () => {
    const chain = new FakeChain().on(d.factory, ballastFactoryAbi, "accountCount", [], 3n);
    for (let i = 0; i < 3; i++) chain.on(d.factory, ballastFactoryAbi, "allAccounts", [BigInt(i)], addr(0xe0 + i));
    expect(await listAccounts(chain.client(), d)).toEqual([addr(0xe0), addr(0xe1), addr(0xe2)]);
  });

  it("lists one owner's accounts", async () => {
    const chain = new FakeChain().on(d.factory, ballastFactoryAbi, "accountsOf", [OWNER], [addr(0xe5)]);
    expect(await listAccounts(chain.client(), d, { owner: OWNER })).toEqual([addr(0xe5)]);
  });

  it("returns nothing for an empty registry", async () => {
    const chain = new FakeChain().on(d.factory, ballastFactoryAbi, "accountCount", [], 0n);
    expect(await listAccounts(chain.client(), d)).toEqual([]);
  });
});

describe("listCovers", () => {
  const v = d.cushionVault;
  const k1: Hex = `0x${"aa".repeat(32)}`;
  const k2: Hex = `0x${"bb".repeat(32)}`;
  const zeroMp = { loanToken: addr(0), collateralToken: addr(0), oracle: addr(0), irm: addr(0), lltv: 0n };
  const cover = (venue: number, keeper: `0x${string}`) => ({
    venue,
    mp: venue === 1 ? mp : zeroMp,
    vDebt: venue === 2 ? V_USDT : addr(0),
    token: venue === 1 ? USD1 : USDT,
    symbol: NVDA,
    keeper,
    capPerDay: 500n * E18,
    balance: 200n * E18,
    dayStart: 1_789_000_000n,
    usedToday: 50n * E18,
  });
  function chainWithCovers() {
    return new FakeChain()
      .on(v, cushionVaultAbi, "coverCount", [], 2n)
      .on(v, cushionVaultAbi, "coverAt", [0n], [OWNER, k1])
      .on(v, cushionVaultAbi, "coverAt", [1n], [addr(0xb9), k2])
      .on(v, cushionVaultAbi, "cover", [OWNER, k1], cover(1, KEEPER))
      .on(v, cushionVaultAbi, "cover", [addr(0xb9), k2], cover(2, addr(0xb8)));
  }

  it("enumerates covers with decoded state", async () => {
    const covers = await listCovers(chainWithCovers().client(), d);
    expect(covers).toHaveLength(2);
    expect(covers[0]).toEqual({
      user: OWNER,
      key: k1,
      cover: {
        venue: "lista",
        marketParams: mp,
        vDebt: addr(0),
        token: USD1,
        symbol: "NVDA",
        keeper: KEEPER,
        capPerDay: 500n * E18,
        balance: 200n * E18,
        dayStart: 1_789_000_000,
        usedToday: 50n * E18,
      },
    });
    expect(covers[1]?.cover.venue).toBe("venus");
    expect(covers[1]?.cover.vDebt).toBe(V_USDT);
  });

  it("filters covers by keeper", async () => {
    const covers = await listCovers(chainWithCovers().client(), d, { keeper: KEEPER });
    expect(covers.map((c) => c.key)).toEqual([k1]);
  });
});

describe("guardianJobs", () => {
  const PROVIDER = addr(0xf1);
  const CLIENT = addr(0xf2);
  const OTHER = addr(0xf3);
  const ACCT = addr(0xf4);
  const z32: Hex = `0x${"00".repeat(32)}`;
  const job = (id: bigint, evaluator: `0x${string}`, provider: `0x${string}`, status: number) => ({
    id,
    client: CLIENT,
    provider,
    evaluator,
    description: "guard",
    budget: E18,
    expiredAt: 1_790_500_000n,
    status,
    hook: evaluator,
    submittedAt: 0n,
    deliverable: z32,
  });
  const empty = { ...job(0n, addr(0), addr(0), 0), client: addr(0), description: "", budget: 0n, expiredAt: 0n };
  const terms = (bound: boolean, account = ACCT) =>
    [bound ? account : addr(0), bound ? 1_790_000_000n : 0n, bound ? 1_790_200_000n : 0n, bound ? 77n : 0n, bound, false] as const;
  const k = d.external.kernel;
  const g = d.guardian;

  function chainWithJobs() {
    return new FakeChain()
      .on(k, kernelAbi, "jobCounter", [], 105n)
      .on(k, kernelAbi, "getJob", [101n], empty)
      .on(k, kernelAbi, "getJob", [102n], job(102n, g, PROVIDER, 0))
      .on(k, kernelAbi, "getJob", [103n], job(103n, g, OTHER, 2))
      .on(k, kernelAbi, "getJob", [104n], job(104n, OTHER, PROVIDER, 1))
      .on(k, kernelAbi, "getJob", [105n], job(105n, g, PROVIDER, 1))
      .on(g, ballastGuardianAbi, "terms", [102n], terms(false))
      .on(g, ballastGuardianAbi, "terms", [103n], terms(true, addr(0xf9)))
      .on(g, ballastGuardianAbi, "terms", [105n], terms(true));
  }

  it("scans the ids above the cursor through Multicall3 and returns the new cursor", async () => {
    const chain = chainWithJobs();
    const page = await guardianJobs(chain.client(), d, { fromJobId: 100n, provider: PROVIDER });
    expect(page.head).toBe(105n);
    expect(page.nextCursor).toBe(105n);
    expect(page.jobs.map((j) => j.jobId)).toEqual([102n, 105n]);
    expect(page.jobs[1]).toMatchObject({
      jobId: 105n,
      client: CLIENT,
      provider: PROVIDER,
      status: "Funded",
      budget: E18,
      expiredAt: 1_790_500_000,
      terms: { account: ACCT, start: 1_790_000_000, end: 1_790_200_000, agentId: 77n, settled: false },
    });
    expect(page.jobs[0]?.status).toBe("Open");
    expect(page.jobs[0]?.terms).toBeNull();
    const kernel = k.toLowerCase();
    const direct = chain.requests.filter((r) => r.to === kernel && r.via === undefined);
    const batched = chain.requests.filter((r) => r.to === kernel && r.via === "multicall");
    expect(direct).toHaveLength(1); // jobCounter
    expect(batched).toHaveLength(5); // getJob 101..105, all through Multicall3
    expect(chain.requests.filter((r) => r.to === MULTICALL3).length).toBeGreaterThan(0);
  });

  it("pages with a limit and resumes from the cursor", async () => {
    const chain = chainWithJobs();
    const first = await guardianJobs(chain.client(), d, { fromJobId: 100n, limit: 2 });
    expect(first.nextCursor).toBe(102n);
    expect(first.jobs.map((j) => j.jobId)).toEqual([102n]);
    const second = await guardianJobs(chain.client(), d, { fromJobId: first.nextCursor, limit: 2 });
    expect(second.nextCursor).toBe(104n);
    expect(second.jobs.map((j) => j.jobId)).toEqual([103n]);
  });

  it("stops at toJobId and filters by account", async () => {
    const page = await guardianJobs(chainWithJobs().client(), d, { fromJobId: 100n, toJobId: 103n, account: addr(0xf9) });
    expect(page.nextCursor).toBe(103n);
    expect(page.jobs.map((j) => j.jobId)).toEqual([103n]);
  });

  it("returns nothing and keeps the cursor when no new job exists", async () => {
    const chain = new FakeChain().on(k, kernelAbi, "jobCounter", [], 105n);
    expect(await guardianJobs(chain.client(), d, { fromJobId: 105n })).toEqual({ jobs: [], nextCursor: 105n, head: 105n });
  });

  it("starts at id 1 on a fresh kernel", async () => {
    const chain = new FakeChain()
      .on(k, kernelAbi, "jobCounter", [], 1n)
      .on(k, kernelAbi, "getJob", [1n], job(1n, g, PROVIDER, 2))
      .on(g, ballastGuardianAbi, "terms", [1n], terms(true));
    const page = await guardianJobs(chain.client(), d, { fromJobId: 0n });
    expect(page.jobs.map((j) => [j.jobId, j.status])).toEqual([[1n, "Submitted"]]);
  });

  it("refreshes known jobs by id and drops ids that are not guardian jobs", async () => {
    const jobs = await readGuardianJobs(chainWithJobs().client(), d, [105n, 104n]);
    expect(jobs.map((j) => j.jobId)).toEqual([105n]);
    expect(await readGuardianJobs(new FakeChain().client(), d, [])).toEqual([]);
  });
});
