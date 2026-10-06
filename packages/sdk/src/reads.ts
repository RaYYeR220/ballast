import { erc20Abi, formatUnits, maxUint256, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import {
  ballastAccountBaseAbi,
  ballastFactoryAbi,
  ballastGuardianAbi,
  comptrollerAbi,
  cushionVaultAbi,
  kernelAbi,
  listaAccountAbi,
  moolahAbi,
  sessionCalendarAbi,
  sessionOracleAbi,
  venusAccountAbi,
  venusOracleAbi,
} from "./abi";
import type { Deployment } from "./addresses";
import {
  REASON_TEXT,
  flagNames,
  jobStatusName,
  reasonName,
  riskWindowName,
  sessionName,
  venueName,
  windowTypeName,
  type JobStatusName,
  type OverlayFlagName,
  type ReasonName,
  type RiskWindowName,
  type SessionName,
  type Venue,
  type WindowTypeName,
} from "./enums";
import { bytes32ToSymbol, cloneImplementation, orNullOnRevert, sameAddress, symbolToBytes32 } from "./util";

/** The subset of a viem PublicClient the reads use. Any PublicClient satisfies it. */
export type ReadClient = Pick<PublicClient, "readContract" | "multicall" | "getBlock" | "getBlockNumber" | "getCode">;

export interface ReadOptions {
  /** Block to read at. By default each call reads the head block number once and pins every read to it. */
  blockNumber?: bigint;
}

/** How many reads run concurrently in the enumerations. */
const CONCURRENCY = 25;

async function mapLimit<T, R>(items: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
}

const range = (n: bigint) => Array.from({ length: Number(n) }, (_, i) => BigInt(i));

/** Head block (or the requested one): its timestamp and the number every following read is pinned to. */
async function head(c: ReadClient, o: ReadOptions) {
  const b = await c.getBlock(o.blockNumber === undefined ? { blockTag: "latest" } : { blockNumber: o.blockNumber });
  return { ts: b.timestamp, at: Number(b.timestamp), blockNumber: b.number as bigint };
}

const pin = async (c: ReadClient, o: ReadOptions) => o.blockNumber ?? (await c.getBlockNumber());

// ------------------------------------------------------------------ session

export interface SessionState {
  /** Unix time of the block the session was evaluated at. */
  at: number;
  blockNumber: bigint;
  session: SessionName;
  nextClose: number;
  nextOpen: number;
  /** The next closure: from the next regular close to the following regular open. */
  window: { kind: WindowTypeName; startsAt: number; endsAt: number };
  /** The closure in progress (NONE during the regular session). */
  current: { kind: WindowTypeName; closedAt: number; opensAt: number };
}

export async function sessionState(c: ReadClient, d: Deployment, o: ReadOptions = {}): Promise<SessionState> {
  const { ts, at, blockNumber } = await head(c, o);
  const cal = { address: d.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  const [session, nextClose, nextOpen, next, current] = await Promise.all([
    c.readContract({ ...cal, functionName: "session", args: [ts] }),
    c.readContract({ ...cal, functionName: "nextClose", args: [ts] }),
    c.readContract({ ...cal, functionName: "nextOpen", args: [ts] }),
    c.readContract({ ...cal, functionName: "nextWindow", args: [ts] }),
    c.readContract({ ...cal, functionName: "currentWindow", args: [ts] }),
  ]);
  return {
    at,
    blockNumber,
    session: sessionName(session),
    nextClose: Number(nextClose),
    nextOpen: Number(nextOpen),
    window: { kind: windowTypeName(next[0]), startsAt: Number(next[1]), endsAt: Number(next[2]) },
    current: { kind: windowTypeName(current[0]), closedAt: Number(current[1]), opensAt: Number(current[2]) },
  };
}

// ------------------------------------------------------------------- oracle

export interface OverlayState {
  validUntil: number;
  nextEarnings: number;
  flags: number;
  flagNames: OverlayFlagName[];
  /** Shares per Ondo token, 1e18 (0 = not posted). */
  ondoMultiplier: bigint;
  /** Per-share USD, 1e8 (0 = not posted). */
  referencePrice: bigint;
  postedAt: number;
  /** validUntil is not in the past. */
  fresh: boolean;
}

export interface OracleSnapshot {
  symbol: string;
  at: number;
  blockNumber: bigint;
  session: SessionName;
  /** USD price of one raw bStock token, 1e8. Null when unavailable. */
  rawPrice: bigint | null;
  /** USD price per underlying share, 1e8. Null when unavailable. */
  perShare: bigint | null;
  /** Reference per-share USD price, 1e8 (Chainlink or the last accepted publisher print). */
  reference: bigint | null;
  referenceUpdatedAt: number | null;
  converged: boolean;
  devBps: number;
  convergedReason: ReasonName;
  canAddRisk: boolean;
  reason: ReasonName;
  reasonText: string;
  windowAhead: { window: RiskWindowName; startsAt: number; endsAt: number; gapBps: number };
  currentWindow: { window: RiskWindowName; gapBps: number; closedAt: number };
  overlay: OverlayState;
  /** SessionOracle.params(). `horizon` is also the keeper's deleverage window before a closure. */
  params: OracleParams;
}

export interface OracleParams {
  restoreDelay: number;
  horizon: number;
  convergenceBps: number;
  maxRefAge: number;
  maxOverlayTtl: number;
  maxOndoDriftBps: number;
  maxRefDeviationBps: number;
}

export async function oracleSnapshot(c: ReadClient, d: Deployment, symbol: string, o: ReadOptions = {}): Promise<OracleSnapshot> {
  const sym = symbolToBytes32(symbol);
  const { ts, at, blockNumber } = await head(c, o);
  const or = { address: d.sessionOracle, abi: sessionOracleAbi, blockNumber } as const;
  const [session, raw, perShare, ref, conv, can, ahead, current, ov, params] = await Promise.all([
    c.readContract({ address: d.calendar, abi: sessionCalendarAbi, blockNumber, functionName: "session", args: [ts] }),
    c.readContract({ ...or, functionName: "rawPrice", args: [sym] }),
    c.readContract({ ...or, functionName: "perSharePrice", args: [sym] }),
    c.readContract({ ...or, functionName: "referenceFor", args: [sym] }),
    c.readContract({ ...or, functionName: "converged", args: [sym] }),
    c.readContract({ ...or, functionName: "canAddRisk", args: [sym] }),
    c.readContract({ ...or, functionName: "windowAhead", args: [sym] }),
    c.readContract({ ...or, functionName: "currentWindow", args: [sym] }),
    c.readContract({ ...or, functionName: "overlay", args: [sym] }),
    c.readContract({ ...or, functionName: "params" }),
  ]);
  const reason = reasonName(can[1]);
  return {
    symbol: bytes32ToSymbol(sym),
    at,
    blockNumber,
    session: sessionName(session),
    rawPrice: raw[1] ? raw[0] : null,
    perShare: perShare[1] ? perShare[0] : null,
    reference: ref[2] ? ref[0] : null,
    referenceUpdatedAt: ref[2] ? Number(ref[1]) : null,
    converged: conv[0],
    devBps: Number(conv[1]),
    convergedReason: reasonName(conv[2]),
    canAddRisk: can[0],
    reason,
    reasonText: REASON_TEXT[reason],
    windowAhead: { window: riskWindowName(ahead[0]), startsAt: Number(ahead[1]), endsAt: Number(ahead[2]), gapBps: ahead[3] },
    currentWindow: { window: riskWindowName(current[0]), gapBps: current[1], closedAt: Number(current[2]) },
    overlay: {
      validUntil: Number(ov.validUntil),
      nextEarnings: Number(ov.nextEarnings),
      flags: ov.flags,
      flagNames: flagNames(ov.flags),
      ondoMultiplier: ov.ondoMultiplier,
      referencePrice: ov.referencePrice,
      postedAt: Number(ov.postedAt),
      fresh: Number(ov.validUntil) >= at,
    },
    params: {
      restoreDelay: params[0],
      horizon: params[1],
      convergenceBps: params[2],
      maxRefAge: params[3],
      maxOverlayTtl: params[4],
      maxOndoDriftBps: params[5],
      maxRefDeviationBps: params[6],
    },
  };
}

// ----------------------------------------------------------------- accounts

export async function listAccounts(c: ReadClient, d: Deployment, o: ReadOptions & { owner?: Address } = {}): Promise<Address[]> {
  const f = { address: d.factory, abi: ballastFactoryAbi, blockNumber: await pin(c, o) } as const;
  if (o.owner) return [...(await c.readContract({ ...f, functionName: "accountsOf", args: [o.owner] }))];
  const n = await c.readContract({ ...f, functionName: "accountCount" });
  return mapLimit(range(n), (i) => c.readContract({ ...f, functionName: "allAccounts", args: [i] }));
}

export interface Mandate {
  maxLtvBps: number;
  shieldLtvBps: number;
  maxSlippageBps: number;
  autoRestore: boolean;
}

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface ListaMarket {
  venue: "lista";
  moolah: Address;
  marketId: Hex;
  marketParams: MarketParams;
  deleveragePathHash: Hex;
  deleveragePathSet: boolean;
  /** Moolah price: collateral units * price / 1e36 = loan units. Null when the venue cannot price. */
  oraclePrice: bigint | null;
  /** Venue minimum loan in loan-token units. Null if it could not be read (see pricing.minLoanKnown). */
  minLoan: bigint | null;
}

export interface VenusMarket {
  venue: "venus";
  comptroller: Address;
  vCollateral: Address;
  vDebt: Address;
  venusOracle: Address;
  collateralFactor: bigint;
  liquidationThreshold: bigint;
  /** Venus oracle prices (1e36 / 10^underlyingDecimals scale). Null when unavailable. */
  collateralPrice: bigint | null;
  debtPrice: bigint | null;
}

/**
 * Planner inputs in the venue's own unit of account. For Lista that unit is the loan token (assumed at par,
 * loanPriceUsd = 1); for Venus it is USD from the Venus oracle.
 */
export interface Pricing {
  /** Price of one whole collateral token. Null when the venue cannot price it. */
  collateralPriceUsd: number | null;
  /** Price of one whole loan token. */
  loanPriceUsd: number | null;
  /** Liquidation LTV as a fraction (Lista lltv, Venus liquidation threshold or collateral factor). */
  lltv: number;
  /** 0 when unknown: check minLoanKnown before trusting it. */
  minLoanUsd: number;
  /** False when the venue minimum loan could not be read (a partial repay may then be refused). */
  minLoanKnown: boolean;
}

export interface AccountState {
  address: Address;
  /** Block every field was read at. */
  blockNumber: bigint;
  venue: Venue;
  owner: Address;
  keeper: Address;
  symbol: string;
  mandate: Mandate;
  /** Collateral in collateral-token units (Venus: underlying, not vTokens). */
  collateral: bigint;
  /** Debt in loan-token units. */
  debt: bigint;
  /** Loan tokens held by the account, spendable by shieldRepay. */
  cushion: bigint;
  /** On-chain LTV in bps. Null when the venue cannot price (ltvBps() reverts); Infinity for zero collateral value. */
  ltvBps: number | null;
  healthKnown: boolean;
  healthy: boolean;
  liquidated: boolean;
  liquidationRecorded: boolean;
  /** Venue-native units (Lista: tokens, Venus: vTokens). */
  trackedCollateral: bigint;
  loanToken: Address;
  collateralToken: Address;
  loanDecimals: number;
  collateralDecimals: number;
  market: ListaMarket | VenusMarket;
  pricing: Pricing;
}

const positive = (x: bigint | null) => (x === null || x === 0n ? null : x);

async function listaMarket(c: ReadClient, account: Address, blockNumber?: bigint): Promise<ListaMarket> {
  const l = { address: account, abi: listaAccountAbi, blockNumber } as const;
  const [moolah, marketId, marketParams, deleveragePathHash] = await Promise.all([
    c.readContract({ ...l, functionName: "moolah" }),
    c.readContract({ ...l, functionName: "marketId" }),
    c.readContract({ ...l, functionName: "marketParams" }),
    c.readContract({ ...l, functionName: "deleveragePathHash" }),
  ]);
  const m = { address: moolah, abi: moolahAbi, blockNumber } as const;
  const [oraclePrice, minLoan] = await Promise.all([
    orNullOnRevert(c.readContract({ ...m, functionName: "getPrice", args: [marketParams] })),
    orNullOnRevert(c.readContract({ ...m, functionName: "minLoan", args: [marketParams] })),
  ]);
  return {
    venue: "lista",
    moolah,
    marketId,
    marketParams: { ...marketParams },
    deleveragePathHash,
    deleveragePathSet: deleveragePathHash !== zeroHash,
    oraclePrice: positive(oraclePrice),
    minLoan,
  };
}

async function venusMarket(c: ReadClient, account: Address, blockNumber?: bigint): Promise<VenusMarket> {
  const v = { address: account, abi: venusAccountAbi, blockNumber } as const;
  const [comptroller, vCollateral, vDebt, venusOracle] = await Promise.all([
    c.readContract({ ...v, functionName: "comptroller" }),
    c.readContract({ ...v, functionName: "vCollateral" }),
    c.readContract({ ...v, functionName: "vDebt" }),
    c.readContract({ ...v, functionName: "venusOracle" }),
  ]);
  const price = (vToken: Address) =>
    orNullOnRevert(c.readContract({ address: venusOracle, abi: venusOracleAbi, blockNumber, functionName: "getUnderlyingPrice", args: [vToken] }));
  const [market, collateralPrice, debtPrice] = await Promise.all([
    c.readContract({ address: comptroller, abi: comptrollerAbi, blockNumber, functionName: "markets", args: [vCollateral] }),
    price(vCollateral),
    price(vDebt),
  ]);
  return {
    venue: "venus",
    comptroller,
    vCollateral,
    vDebt,
    venusOracle,
    collateralFactor: market[1],
    liquidationThreshold: market[3],
    collateralPrice: positive(collateralPrice),
    debtPrice: positive(debtPrice),
  };
}

const scaled = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));

function pricingFor(m: ListaMarket | VenusMarket, loanDecimals: number, collateralDecimals: number): Pricing {
  const cd = 10n ** BigInt(collateralDecimals);
  const ld = 10n ** BigInt(loanDecimals);
  if (m.venue === "lista") {
    return {
      collateralPriceUsd: m.oraclePrice === null ? null : scaled((m.oraclePrice * cd) / ld, 36),
      loanPriceUsd: 1,
      lltv: scaled(m.marketParams.lltv, 18),
      minLoanUsd: m.minLoan === null ? 0 : scaled(m.minLoan, loanDecimals),
      minLoanKnown: m.minLoan !== null,
    };
  }
  const threshold = m.liquidationThreshold > 0n ? m.liquidationThreshold : m.collateralFactor;
  return {
    collateralPriceUsd: m.collateralPrice === null ? null : scaled(m.collateralPrice * cd, 36),
    loanPriceUsd: m.debtPrice === null ? null : scaled(m.debtPrice * ld, 36),
    lltv: scaled(threshold, 18),
    minLoanUsd: 0, // Venus has no minimum loan
    minLoanKnown: true,
  };
}

/** Which Ballast implementation `account` is a clone of, or null. */
export async function accountVenue(c: ReadClient, d: Deployment, account: Address, o: ReadOptions = {}): Promise<Venue | null> {
  const impl = cloneImplementation(await c.getCode({ address: account, blockNumber: o.blockNumber }));
  if (impl && sameAddress(impl, d.listaImpl)) return "lista";
  if (impl && sameAddress(impl, d.venusImpl)) return "venus";
  return null;
}

export async function accountState(c: ReadClient, d: Deployment, account: Address, o: ReadOptions = {}): Promise<AccountState> {
  const blockNumber = await pin(c, o);
  const venue = await accountVenue(c, d, account, { blockNumber });
  if (!venue) throw new Error(`${account} is not a Ballast account of this deployment`);
  const a = { address: account, abi: ballastAccountBaseAbi, blockNumber } as const;
  const [owner, keeper, symbol, mandate, tracked, recorded, liquidated, health, position, ltv, cushion, loanToken, collateralToken] =
    await Promise.all([
      c.readContract({ ...a, functionName: "owner" }),
      c.readContract({ ...a, functionName: "keeper" }),
      c.readContract({ ...a, functionName: "symbol" }),
      c.readContract({ ...a, functionName: "mandate" }),
      c.readContract({ ...a, functionName: "trackedCollateral" }),
      c.readContract({ ...a, functionName: "liquidationRecorded" }),
      c.readContract({ ...a, functionName: "liquidated" }),
      c.readContract({ ...a, functionName: "healthStatus" }),
      c.readContract({ ...a, functionName: "position" }),
      orNullOnRevert(c.readContract({ ...a, functionName: "ltvBps" })),
      c.readContract({ ...a, functionName: "cushion" }),
      c.readContract({ ...a, functionName: "loanToken" }),
      c.readContract({ ...a, functionName: "collateralToken" }),
    ]);
  const decimals = (token: Address) => c.readContract({ address: token, abi: erc20Abi, blockNumber, functionName: "decimals" });
  const [loanDecimals, collateralDecimals, market] = await Promise.all([
    decimals(loanToken),
    decimals(collateralToken),
    venue === "lista" ? listaMarket(c, account, blockNumber) : venusMarket(c, account, blockNumber),
  ]);
  return {
    address: account,
    blockNumber,
    venue,
    owner,
    keeper,
    symbol: bytes32ToSymbol(symbol),
    mandate: { maxLtvBps: mandate[0], shieldLtvBps: mandate[1], maxSlippageBps: mandate[2], autoRestore: mandate[3] },
    collateral: position[0],
    debt: position[1],
    cushion,
    ltvBps: ltv === null ? null : ltv === maxUint256 ? Number.POSITIVE_INFINITY : Number(ltv),
    healthKnown: health[0],
    healthy: health[1],
    liquidated,
    liquidationRecorded: recorded,
    trackedCollateral: tracked,
    loanToken,
    collateralToken,
    loanDecimals,
    collateralDecimals,
    market,
    pricing: pricingFor(market, loanDecimals, collateralDecimals),
  };
}

// ------------------------------------------------------------------- covers

export interface CoverState {
  venue: Venue;
  marketParams: MarketParams;
  vDebt: Address;
  token: Address;
  symbol: string;
  keeper: Address;
  capPerDay: bigint;
  balance: bigint;
  dayStart: number;
  usedToday: bigint;
}

export interface CoverEntry {
  user: Address;
  key: Hex;
  cover: CoverState;
}

export async function listCovers(
  c: ReadClient,
  d: Deployment,
  o: ReadOptions & { keeper?: Address; user?: Address } = {},
): Promise<CoverEntry[]> {
  const v = { address: d.cushionVault, abi: cushionVaultAbi, blockNumber: await pin(c, o) } as const;
  const n = await c.readContract({ ...v, functionName: "coverCount" });
  let refs = await mapLimit(range(n), (i) => c.readContract({ ...v, functionName: "coverAt", args: [i] }));
  if (o.user) refs = refs.filter(([user]) => sameAddress(user, o.user as Address));
  const entries = await mapLimit(refs, async ([user, key]): Promise<CoverEntry> => {
    const cv = await c.readContract({ ...v, functionName: "cover", args: [user, key] });
    return {
      user,
      key,
      cover: {
        venue: venueName(cv.venue),
        marketParams: { ...cv.mp },
        vDebt: cv.vDebt,
        token: cv.token,
        symbol: bytes32ToSymbol(cv.symbol),
        keeper: cv.keeper,
        capPerDay: cv.capPerDay,
        balance: cv.balance,
        dayStart: Number(cv.dayStart),
        usedToday: cv.usedToday,
      },
    };
  });
  return o.keeper ? entries.filter((e) => sameAddress(e.cover.keeper, o.keeper as Address)) : entries;
}

// ----------------------------------------------------------------- guardian

export interface GuardTerms {
  account: Address;
  start: number;
  end: number;
  agentId: bigint;
  settled: boolean;
}

export interface GuardianJob {
  jobId: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: number;
  status: JobStatusName;
  hook: Address;
  submittedAt: number;
  deliverable: Hex;
  /** Terms bound when the job was funded; null while unfunded. */
  terms: GuardTerms | null;
}

export interface GuardianJobsOptions extends ReadOptions {
  /** Cursor: scan job ids strictly above this one (the nextCursor of the previous scan). */
  fromJobId: bigint;
  /** Scan up to this id (inclusive). Default and cap: the kernel's jobCounter. */
  toJobId?: bigint;
  /** At most this many ids per call (default 1000); continue from nextCursor. */
  limit?: number;
  /** Only jobs whose provider is this address (the agent). */
  provider?: Address;
  /** Only jobs guarding this account (unbound jobs never match). */
  account?: Address;
}

export interface GuardianJobsPage {
  /** Guardian-evaluated jobs in the scanned range, oldest first. */
  jobs: GuardianJob[];
  /** Highest id scanned: persist it and pass it as fromJobId next time. */
  nextCursor: bigint;
  /** The kernel's jobCounter (newest id; ids start at 1). */
  head: bigint;
}

/** Calldata bytes per Multicall3 chunk: about 100 getJob calls per eth_call. */
const MULTICALL_BATCH_BYTES = 4096;

const missing = (what: string, id: bigint): never => {
  throw new Error(`multicall returned no ${what} for job ${id}`);
};

async function jobsWithTerms(c: ReadClient, d: Deployment, ids: readonly bigint[], blockNumber: bigint, provider?: Address) {
  const mc = { multicallAddress: d.external.multicall3, allowFailure: false, batchSize: MULTICALL_BATCH_BYTES, blockNumber } as const;
  const jobs = await c.multicall({
    ...mc,
    contracts: ids.map((id) => ({ address: d.external.kernel, abi: kernelAbi, functionName: "getJob", args: [id] }) as const),
  });
  const ours = ids
    .map((id, i) => ({ id, job: jobs[i] ?? missing("job", id) }))
    .filter(({ job }) => sameAddress(job.evaluator, d.guardian) && (!provider || sameAddress(job.provider, provider)));
  if (ours.length === 0) return [];
  const terms = await c.multicall({
    ...mc,
    contracts: ours.map(({ id }) => ({ address: d.guardian, abi: ballastGuardianAbi, functionName: "terms", args: [id] }) as const),
  });
  return ours.map(({ id, job }, i): GuardianJob => {
    const t = terms[i] ?? missing("terms", id);
    return {
      jobId: id,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      description: job.description,
      budget: job.budget,
      expiredAt: Number(job.expiredAt),
      status: jobStatusName(job.status),
      hook: job.hook,
      submittedAt: Number(job.submittedAt),
      deliverable: job.deliverable,
      terms: t[4] ? { account: t[0], start: Number(t[1]), end: Number(t[2]), agentId: t[3], settled: t[5] } : null,
    };
  });
}

/**
 * New ERC-8183 kernel jobs whose evaluator is the Ballast guardian, scanned incrementally by job id through
 * Multicall3. Start from the jobCounter at the guardian's deployment (or 0n) and pass nextCursor back each
 * time. Jobs already seen are refreshed with readGuardianJobs.
 */
export async function guardianJobs(c: ReadClient, d: Deployment, o: GuardianJobsOptions): Promise<GuardianJobsPage> {
  const blockNumber = await pin(c, o);
  const head = await c.readContract({ address: d.external.kernel, abi: kernelAbi, blockNumber, functionName: "jobCounter" });
  const limit = BigInt(Math.max(0, Math.floor(o.limit ?? 1000)));
  let to = o.toJobId !== undefined && o.toJobId < head ? o.toJobId : head;
  if (to > o.fromJobId + limit) to = o.fromJobId + limit;
  if (to <= o.fromJobId) return { jobs: [], nextCursor: o.fromJobId, head };
  const ids: bigint[] = [];
  for (let id = o.fromJobId + 1n; id <= to; id++) ids.push(id);
  const jobs = await jobsWithTerms(c, d, ids, blockNumber, o.provider);
  return {
    jobs: o.account ? jobs.filter((j) => j.terms !== null && sameAddress(j.terms.account, o.account as Address)) : jobs,
    nextCursor: to,
    head,
  };
}

/** Current state of known guardian jobs (ids that are not guardian jobs are dropped). */
export async function readGuardianJobs(c: ReadClient, d: Deployment, jobIds: readonly bigint[], o: ReadOptions = {}): Promise<GuardianJob[]> {
  if (jobIds.length === 0) return [];
  return jobsWithTerms(c, d, jobIds, await pin(c, o));
}
