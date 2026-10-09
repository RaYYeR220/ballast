// Records one full Ballast cycle on a local anvil fork of BNB Chain (chain 31337 only) and writes it to
// apps/web/public/replay/cycle.json, the file /judge plays back:
//
//   contracts on chain -> publish the overlay -> open a Lista account -> fix the sale route -> fund a guardian
//   job -> shield before the close -> a restore refused while New York is closed -> restore after the open ->
//   submit and settle the guardian job.
//
// By default the cycle runs against the contracts deployed on BNB Chain (contracts/deployments/56.json), which
// the fork carries; DEPLOYMENT_FILE points it at another deployment (for example one made on the fork with
// script/Deploy.s.sol). Every step is a real transaction on the fork: its hash, block time, decoded result or
// revert, and the account's state after it are recorded. Nothing is simulated or typed in.
//
//   anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 31337 --port 8571 --auto-impersonate
//   (cd contracts && forge build)                     # the fork-only mocks below come from contracts/out
//   FORK_RPC=http://127.0.0.1:8571 pnpm tsx scripts/demo/record-replay.ts
//
// FORK ONLY, and written into the recording as such:
//  - the fork's clock is moved forward (a close, a weekend and an open in a few seconds);
//  - Lista's price sources are frozen behind a fixed-price mock, because they go stale when the clock moves;
//  - the NVDA Chainlink feed is replaced by a mock that reprints the frozen per-share price after each move,
//    because a fork receives no new Chainlink rounds;
//  - the desk's address is impersonated (anvil --auto-impersonate): no key of the desk is used or needed;
//  - the borrower is a throwaway address funded from an exchange wallet on the fork.
// The script refuses to run on any chain but 31337.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTradingDay, localDay, nextClose, nextOpen, regularCloseAt, regularOpenAt, session } from "@ballast/risk";
import {
  accountState,
  ballastAccountBaseAbi,
  ballastFactoryAbi,
  ballastGuardianAbi,
  decodeBallastError,
  identityRegistryAbi,
  kernelAbi,
  moolahAbi,
  oracleSnapshot,
  parseDeployment,
  planForAccount,
  readGuardianJobs,
  sessionAwareFeedAbi,
  sessionOracleAbi,
  symbolToBytes32,
  writes,
  type Deployment,
  type MarketParams,
  type TxRequest,
} from "@ballast/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8571";
const OUT = process.env.REPLAY_OUT ?? path.join(ROOT, "apps", "web", "public", "replay", "cycle.json");
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE ?? path.join(ROOT, "contracts", "deployments", "56.json");

const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "bsc-mainnet.json"), "utf8"));
const chain = defineChain({ id: 31337, name: "bsc-fork", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const E18 = 10n ** 18n;

/** The desk's ERC-8004 identity and key on BNB Chain (publisher, keeper, guardian provider). */
const DESK_AGENT_ID = BigInt(process.env.AGENT_ID ?? "368122");
/** A throwaway borrower: an address nobody holds a key for, impersonated on the fork. */
const OWNER = getAddress(`0x${keccak256(stringToHex("ballast replay borrower")).slice(-40)}`);
const SYMBOL = "NVDA";
const MARKET = "NVDAB_USD1";
const MANDATE = { maxLtvBps: 7400, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true };
const BUDGET = parseUnits("0.05", 18);

const priceMockAbi = parseAbi(["function peek(address asset) view returns (uint256)", "function set(address asset, uint256 p)"]);
const feedMockAbi = parseAbi(["function set(int256 a, uint256 u)"]);
const reputationAbi = parseAbi([
  "function getLastIndex(uint256 agentId, address client) view returns (uint64)",
  "function readFeedback(uint256 agentId, address client, uint64 index) view returns (int128 value, uint8 decimals, string tag1, string tag2, bool revoked)",
]);

// ------------------------------------------------------------------ recording

interface TxRecord {
  label: string;
  /** the call as a person reads it */
  call: string;
  hash: Hex;
  status: "success" | "reverted";
  from: Address;
  to: Address;
  block: number;
  gasUsed: string;
}

interface StateRecord {
  /** unix seconds of the block the state was read at */
  at: number;
  session: string;
  canAddRisk: boolean;
  reason: string;
  window: { ahead: string; aheadGapBps: number; current: string; currentGapBps: number };
  /** SessionAwareFeed.band(): null while New York is open or without an anchor */
  bandBps: number | null;
  account: null | { address: Address; ltvBps: number | null; collateral: string; debt: string; cushion: string; healthy: boolean; liquidated: boolean; hfAfterGap: number | null };
  job: null | { id: string; status: string; settled: boolean };
}

interface StepRecord {
  id: string;
  /** wheel mark: what kind of moment this is */
  kind: "setup" | "publish" | "open" | "job" | "shield" | "refused" | "restore" | "settle";
  title: string;
  summary: string;
  /** unix seconds (fork block time) */
  at: number;
  txs: TxRecord[];
  /** decoded outcome: event fields, plan figures */
  result: Record<string, string | number | boolean | null>;
  /** decoded revert, for a refusal */
  error?: { name: string; reason?: string; message: string };
  state: StateRecord;
  /** how to reproduce this step yourself */
  reproduce: { test?: string; command: string };
  /** keys of the matching BNB Chain transactions in data/proof-txs.json, when they exist */
  proofKeys: string[];
  /** what only a fork can do, when this step needed it */
  forkOnly?: string[];
}

const steps: StepRecord[] = [];
const forkOnly: string[] = [];

async function head() {
  const b = await pub.getBlock({ blockTag: "latest" });
  return { at: Number(b.timestamp), number: Number(b.number) };
}

async function send(from: Address, tx: TxRequest, label: string, call: string, o: { expectRevert?: boolean } = {}): Promise<{ record: TxRecord; receipt: TransactionReceipt }> {
  const w = createWalletClient({ account: from, chain, transport: http(RPC) });
  // a fixed gas limit skips estimation, so a refused call is mined as a reverted transaction instead of never being sent
  const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: 3_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" && !o.expectRevert) throw new Error(`${label} reverted (${hash})`);
  if (receipt.status === "success" && o.expectRevert) throw new Error(`${label} was expected to revert but went through (${hash})`);
  console.log(`  ${receipt.status === "success" ? "ok      " : "reverted"} ${label}: ${hash}`);
  return { record: { label, call, hash, status: receipt.status, from, to: tx.to, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() }, receipt };
}

async function warp(to: number) {
  const now = (await head()).at;
  if (to <= now) throw new Error(`cannot move the clock back (${to} <= ${now})`);
  await test.setNextBlockTimestamp({ timestamp: BigInt(to) });
  await test.mine({ blocks: 1 });
  const t = (await head()).at;
  console.log(`clock: ${new Date(t * 1000).toISOString()} (${session(t)})`);
}

const usd = (x: bigint, decimals = 18) => Number(formatUnits(x, decimals)).toFixed(2);

async function snapshot(d: Deployment, account: Address | null, jobId: bigint | null): Promise<StateRecord> {
  const o = await oracleSnapshot(pub, d, SYMBOL);
  const blockNumber = o.blockNumber;
  const band = await pub.readContract({ address: d.sessionAwareFeed, abi: sessionAwareFeedAbi, blockNumber, functionName: "band", args: [symbolToBytes32(SYMBOL)] });
  const st = account ? await accountState(pub, d, account, { blockNumber }) : null;
  const gap = o.currentWindow.window !== "NONE" ? o.currentWindow.gapBps : o.windowAhead.gapBps;
  const job = jobId === null ? null : ((await readGuardianJobs(pub, d, [jobId], { blockNumber }))[0] ?? null);
  return {
    at: o.at,
    session: o.session,
    canAddRisk: o.canAddRisk,
    reason: o.reason,
    window: { ahead: o.windowAhead.window, aheadGapBps: o.windowAhead.gapBps, current: o.currentWindow.window, currentGapBps: o.currentWindow.gapBps },
    bandBps: band[3] ? Number(band[2]) : null,
    account: st
      ? {
          address: st.address,
          ltvBps: st.ltvBps === null || !Number.isFinite(st.ltvBps) ? null : st.ltvBps,
          collateral: formatUnits(st.collateral, st.collateralDecimals),
          debt: usd(st.debt, st.loanDecimals),
          cushion: usd(st.cushion, st.loanDecimals),
          healthy: st.healthy,
          liquidated: st.liquidated,
          hfAfterGap: st.ltvBps && Number.isFinite(st.ltvBps) && st.ltvBps > 0 ? Math.round((((10_000 - gap) / 10_000) * st.pricing.lltv * 10_000 * 1000) / st.ltvBps) / 1000 : null,
        }
      : null,
    job: job ? { id: job.jobId.toString(), status: job.status, settled: job.terms?.settled ?? false } : null,
  };
}

// ------------------------------------------------------------- fork-only help

async function freezeListaPrices(payer: Address) {
  const art = JSON.parse(readFileSync(path.join(ROOT, "contracts", "out", "Mocks.sol", "MockPriceSource.json"), "utf8"));
  const tokens: Address[] = [...cfg.tickers.map((t: { bStock: string }) => t.bStock as Address), cfg.tokens.USD1, cfg.tokens.USDT, cfg.tokens.USDC, cfg.tokens.U];
  const sources: Address[] = [cfg.lista.stockOracle, cfg.lista.resilientOracle];
  const prices = new Map<string, bigint>();
  for (const src of sources) {
    for (const t of tokens) {
      try {
        const p = await pub.readContract({ address: src, abi: priceMockAbi, functionName: "peek", args: [t] });
        if (p > 0n) prices.set(`${src}|${t}`, p);
      } catch {
        // this source does not price that token
      }
    }
  }
  for (const src of sources) await test.setCode({ address: src, bytecode: art.deployedBytecode.object as Hex });
  const w = createWalletClient({ account: payer, chain, transport: http(RPC) });
  for (const [k, p] of prices) {
    const [src, t] = k.split("|") as [Address, Address];
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: src, abi: priceMockAbi, functionName: "set", args: [t, p], gas: 200_000n }) });
  }
  return prices.size;
}

/** Puts a fixed-answer aggregator at the ticker's Chainlink address. */
async function mockReference(feed: Address) {
  const art = JSON.parse(readFileSync(path.join(ROOT, "contracts", "out", "Mocks.sol", "MockAggregator.json"), "utf8"));
  await test.setCode({ address: feed, bytecode: art.deployedBytecode.object as Hex });
}

/** Reprints the frozen per-share price on the mocked reference feed, stamped `at`. */
async function printReference(d: Deployment, feed: Address, payer: Address, at: number) {
  const sym = symbolToBytes32(SYMBOL);
  const [perShare, ok] = await pub.readContract({ address: d.sessionOracle, abi: sessionOracleAbi, functionName: "perSharePrice", args: [sym] });
  if (!ok) throw new Error("the Session Oracle has no per-share price on the fork");
  const w = createWalletClient({ account: payer, chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: feed, abi: feedMockAbi, functionName: "set", args: [perShare, BigInt(at)], gas: 200_000n }) });
  return perShare;
}

async function fundFromWhale(token: Address, to: Address, amount: bigint) {
  const whale = cfg.forkWhales.binanceHot as Address;
  const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [whale] });
  if (bal < amount) throw new Error(`the fork's funding wallet holds only ${formatUnits(bal, 18)} of ${token}`);
  await test.setBalance({ address: whale, value: 10n * E18 });
  const w = createWalletClient({ account: whale, chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], gas: 300_000n }) });
}

// ------------------------------------------------------------------- the cycle

const overlayTx = (d: Deployment, at: number, maxTtl: number) =>
  writes.postOverlays(d, [{ symbol: SYMBOL, overlay: { validUntil: at + maxTtl - 600, nextEarnings: 0, flags: 0, ondoMultiplier: 0n, referencePrice: 0n } }]);

async function main() {
  if ((await pub.getChainId()) !== 31337) throw new Error("refusing to run: this recording is made on a local fork (chain 31337) only");
  const d = parseDeployment(31337, JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")));
  const deploymentSource = path.relative(ROOT, DEPLOYMENT_FILE).replace(/\\/g, "/");
  const fork = await head();
  console.log(`fork of BNB Chain at block ${fork.number}, ${new Date(fork.at * 1000).toISOString()} (${session(fork.at)})`);

  const sym = symbolToBytes32(SYMBOL);
  const or = { address: d.sessionOracle, abi: sessionOracleAbi } as const;
  const [publisher, publisherAgentId, params, ticker] = await Promise.all([
    pub.readContract({ ...or, functionName: "publisher" }),
    pub.readContract({ ...or, functionName: "publisherAgentId" }),
    pub.readContract({ ...or, functionName: "params" }),
    pub.readContract({ ...or, functionName: "ticker", args: [sym] }),
  ]);
  const desk = getAddress(publisher);
  const agentOwner = getAddress(await pub.readContract({ address: d.external.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [DESK_AGENT_ID] }));
  if (agentOwner !== desk) throw new Error(`agent ${DESK_AGENT_ID} belongs to ${agentOwner}, not to the publisher ${desk}`);
  const [restoreDelay, , , , maxOverlayTtl] = params;
  const m = cfg.lista.markets[MARKET];
  const mp: MarketParams = { loanToken: getAddress(cfg.tokens.USD1), collateralToken: getAddress(m.collateralToken), oracle: getAddress(cfg.lista.stockOracle), irm: getAddress(cfg.lista.irm), lltv: BigInt(m.lltv) };
  const nvdab = mp.collateralToken;
  const usd1 = mp.loanToken;
  const feed = getAddress(ticker.chainlink);

  // ---- 1. the contracts, as they stand on the fork (no transaction: the fork carries them)
  const code = await Promise.all(([d.calendar, d.sessionOracle, d.sessionAwareFeed, d.factory, d.cushionVault, d.guardian] as Address[]).map((a) => pub.getCode({ address: a })));
  if (code.some((c) => !c || c === "0x")) throw new Error(`no Ballast code at the addresses in ${deploymentSource} on this fork`);
  steps.push({
    id: "contracts",
    kind: "setup",
    title: "The contracts are on BNB Chain",
    summary: `The fork carries Ballast as deployed: the Session Oracle names ${desk} as publisher, registered as ERC-8004 agent ${publisherAgentId}. This replay runs against those contracts, not a copy.`,
    at: fork.at,
    txs: [],
    result: { sessionOracle: d.sessionOracle, sessionAwareFeed: d.sessionAwareFeed, factory: d.factory, cushionVault: d.cushionVault, guardian: d.guardian, publisher: desk, publisherAgentId: publisherAgentId.toString(), restoreDelaySec: restoreDelay, maxOverlayTtlSec: maxOverlayTtl },
    state: await snapshot(d, null, null),
    reproduce: { command: "pnpm verify:onchain" },
    proofKeys: ["register", "deploy"],
  });

  // ---- fork-only preparation
  await test.setBalance({ address: desk, value: E18 });
  await test.setBalance({ address: OWNER, value: E18 });
  const frozen = await freezeListaPrices(OWNER);
  await mockReference(feed);
  forkOnly.push(
    "The fork's clock is moved forward: a close, a weekend and an open pass in seconds.",
    `Lista's price sources are frozen behind a fixed-price mock (${frozen} prices kept as read), because they go stale when the clock moves.`,
    `The ${SYMBOL} Chainlink feed is replaced by a mock that reprints the frozen per-share price after each move, because a fork receives no new rounds.`,
    `The desk's address ${desk} is impersonated by the local node. No key of the desk is used.`,
    `The borrower ${OWNER} is a throwaway address, funded with 20 NVDAB and 1,000 USD1 from an exchange wallet on the fork.`,
  );
  await fundFromWhale(nvdab, OWNER, 20n * E18);
  await fundFromWhale(usd1, OWNER, 1000n * E18);

  // start in a regular session: past the restore delay after the open, at least two hours before the close
  const now0 = (await head()).at;
  let start = 0;
  for (let day = localDay(now0).day; day < localDay(now0).day + 10 && !start; day++) {
    if (!isTradingDay(day)) continue;
    const t = Math.max(now0, regularOpenAt(day) + restoreDelay + 300);
    if (regularCloseAt(day) - t >= 2 * 3600) start = t;
  }
  if (!start) throw new Error("no regular session found to start in");
  if (start > now0) await warp(start);

  // ---- 2. the publisher posts the overlay
  let at = (await head()).at;
  await printReference(d, feed, OWNER, at - 60);
  const posted = await send(desk, overlayTx(d, at, maxOverlayTtl), "post the overlay", `postOverlays([${SYMBOL}], valid 6 h, no flags)`);
  steps.push({
    id: "publish",
    kind: "publish",
    title: "The desk publishes the overlay",
    summary: `The publisher posts ${SYMBOL}'s overlay: no halt, no corporate action, no earnings flag, valid for under six hours. With it and a fresh, converged reference the Session Oracle answers that risk may be added.`,
    at: (await head()).at,
    txs: [posted.record],
    result: { symbol: SYMBOL, flags: 0, validForSec: maxOverlayTtl - 600 },
    state: await snapshot(d, null, null),
    reproduce: { test: "contracts/test/SessionOracle.t.sol", command: "pnpm contracts:test --match-path test/SessionOracle.t.sol" },
    proofKeys: ["overlay"],
    forkOnly: ["The reference feed was reprinted at the frozen price just before this step."],
  });

  // ---- 3. the borrower opens a credit line
  const price = await pub.readContract({ address: d.external.moolah, abi: moolahAbi, functionName: "getPrice", args: [mp] });
  const collateral = 10n * E18;
  const value = (collateral * price) / 10n ** 36n;
  const borrowAmt = (value * 69n) / 100n;
  const created = await send(OWNER, writes.createListaAccount(d, { marketParams: mp, symbol: SYMBOL, keeper: desk, mandate: MANDATE }), "open the account", `createListaAccount(NVDAB / USD1, ${SYMBOL}, keeper = desk)`);
  const ev = parseEventLogs({ abi: ballastFactoryAbi, eventName: "AccountCreated", logs: created.receipt.logs })[0];
  if (!ev) throw new Error("no AccountCreated event");
  const account = getAddress((ev.args as { account: Address }).account);
  const open = [
    created.record,
    (await send(OWNER, writes.approve(nvdab, account, collateral), "approve collateral", "approve(account, 10 NVDAB)")).record,
    (await send(OWNER, writes.depositCollateral(account, collateral), "deposit collateral", "depositCollateral(10 NVDAB)")).record,
    (await send(OWNER, writes.borrow(account, borrowAmt, OWNER), "borrow", `borrow(${usd(borrowAmt)} USD1)`)).record,
    (await send(OWNER, writes.approve(usd1, account, 200n * E18), "approve cushion", "approve(account, 200 USD1)")).record,
    (await send(OWNER, writes.depositCushion(account, 200n * E18), "deposit cushion", "depositCushion(200 USD1)")).record,
  ];
  steps.push({
    id: "open",
    kind: "open",
    title: "A borrower opens a credit line",
    summary: `10 NVDAB as collateral on Lista, ${usd(borrowAmt)} USD1 borrowed at 69% of its value, and a 200 USD1 cushion the keeper may spend only on repaying this loan. The mandate caps the keeper at 74% LTV.`,
    at: (await head()).at,
    txs: open,
    result: { account, collateral: "10 NVDAB", borrowed: `${usd(borrowAmt)} USD1`, cushion: "200.00 USD1", maxLtvBps: MANDATE.maxLtvBps, shieldLtvBps: MANDATE.shieldLtvBps, autoRestore: MANDATE.autoRestore },
    state: await snapshot(d, account, null),
    reproduce: { test: "contracts/test/fork/ListaAccount.fork.t.sol:test_factoryRegistersAccount", command: "pnpm contracts:test:fork --match-test test_factoryRegistersAccount" },
    proofKeys: ["open-account"],
  });

  // ---- 4. the owner fixes the one route collateral may ever be sold through
  const route = writes.encodeV3Path([nvdab, getAddress(cfg.tokens.USDT), usd1], [2500, 100]);
  const pathTx = await send(OWNER, writes.setDeleveragePath(account, route), "fix the sale route", "setDeleveragePath(NVDAB > USDT > USD1)");
  steps.push({
    id: "path",
    kind: "open",
    title: "The owner fixes the sale route",
    summary: "If the cushion ever runs short, the keeper may sell collateral into the debt only through this one PancakeSwap route, only close to a closure, and only down to the owner's shield LTV. Without a route it cannot sell at all.",
    at: (await head()).at,
    txs: [pathTx.record],
    result: { route: "NVDAB > USDT (0.25%) > USD1 (0.01%)", pathHash: keccak256(route) },
    state: await snapshot(d, account, null),
    reproduce: { test: "contracts/test/fork/ListaAccount.fork.t.sol:test_deleverage_disabledUntilOwnerSetsPath", command: "pnpm contracts:test:fork --match-test test_deleverage_disabledUntilOwnerSetsPath" },
    proofKeys: ["set-path"],
  });

  // ---- 5. a guardian job over the coming closure, paid from escrow only if the loan survives
  const jobStart = (await head()).at;
  const close = nextClose(jobStart);
  const reopen = nextOpen(close);
  const end = reopen + restoreDelay + 300;
  const expiredAt = nextOpen(end) + 2 * 3600;
  const jobCreated = await send(OWNER, writes.createJobWithToken(d, { provider: desk, expiredAt, description: `guard my ${SYMBOL} loan through the coming closure`, token: usd1 }), "create the job", "createJobWithToken(provider = desk, evaluator and hook = BallastGuardian, USD1)");
  const jev = parseEventLogs({ abi: kernelAbi, eventName: "JobCreated", logs: jobCreated.receipt.logs })[0];
  if (!jev) throw new Error("no JobCreated event");
  const jobId = (jev.args as { jobId: bigint }).jobId;
  const jobTxs = [
    jobCreated.record,
    (await send(OWNER, writes.setBudget(d, jobId, BUDGET), "set the budget", `setBudget(job ${jobId}, 0.05 USD1)`)).record,
    (await send(OWNER, writes.approve(usd1, d.external.kernel, BUDGET), "approve the budget", "approve(kernel, 0.05 USD1)")).record,
    (await send(OWNER, writes.fund(d, { jobId, expectedBudget: BUDGET, terms: { account, start: jobStart, end, agentId: DESK_AGENT_ID } }), "fund with the terms", `fund(job ${jobId}, terms: account, window, agent ${DESK_AGENT_ID})`)).record,
  ];
  steps.push({
    id: "job",
    kind: "job",
    title: "A guardian job is funded",
    summary: `The borrower escrows 0.05 USD1 on the ERC-8183 kernel for the desk to guard this loan until ${new Date(end * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC. The guardian contract binds the terms and checks that the provider is the ERC-8004 agent they name.`,
    at: (await head()).at,
    txs: jobTxs,
    result: { jobId: jobId.toString(), budget: "0.05 USD1", windowStart: jobStart, windowEnd: end, expiresAt: expiredAt, agentId: DESK_AGENT_ID.toString(), provider: desk },
    state: await snapshot(d, account, jobId),
    reproduce: { test: "contracts/test/fork/BallastGuardian.fork.t.sol:test_fundedJob_atEnd_thenSubmit_thenSettlePays", command: "pnpm contracts:test:fork --match-test test_fundedJob_atEnd_thenSubmit_thenSettlePays" },
    proofKeys: ["job-fund"],
  });

  // ---- 6. 59 minutes before the close the keeper shields
  await warp(close - 59 * 60);
  const before = await accountState(pub, d, account);
  const oracleBefore = await oracleSnapshot(pub, d, SYMBOL);
  const plan = planForAccount(before, oracleBefore);
  const repay = plan.steps.find((s) => s.fn === "shieldRepay");
  if (!repay || repay.fn !== "shieldRepay") throw new Error(`the planner asked for no cushion repay (${plan.kind}): nothing to record`);
  const shield = await send(desk, writes.shieldRepay(account, repay.assets), "shield", `shieldRepay(${usd(repay.assets)} USD1)`);
  const shielded = parseEventLogs({ abi: ballastAccountBaseAbi, eventName: "Shielded", logs: shield.receipt.logs })[0];
  const sArgs = shielded?.args as { debtBefore: bigint; debtAfter: bigint; collateralSold: bigint } | undefined;
  steps.push({
    id: "shield",
    kind: "shield",
    title: "Before the close, the keeper shields",
    summary: `With 59 minutes of trading left the desk sizes the loan for the worst 1% ${oracleBefore.windowAhead.window.toLowerCase()} gap of ${SYMBOL} (${(plan.gapBps / 100).toFixed(2)}%) at a health factor of ${plan.targetHfAfterGap}, and repays ${usd(repay.assets)} USD1 from the cushion. No collateral is sold.`,
    at: (await head()).at,
    txs: [shield.record],
    result: {
      plan: plan.kind,
      window: oracleBefore.windowAhead.window,
      gapBps: plan.gapBps,
      targetHfAfterGap: plan.targetHfAfterGap,
      repaid: `${usd(repay.assets)} USD1`,
      debtBefore: sArgs ? usd(sArgs.debtBefore) : usd(before.debt),
      debtAfter: sArgs ? usd(sArgs.debtAfter) : null,
      collateralSold: sArgs ? formatUnits(sArgs.collateralSold, 18) : "0",
      ltvBeforeBps: before.ltvBps,
    },
    state: await snapshot(d, account, jobId),
    reproduce: { test: "contracts/test/fork/ListaAccount.fork.t.sol:test_keeperShieldRepay_reducesDebtOnly", command: "pnpm contracts:test:fork --match-test test_keeperShieldRepay_reducesDebtOnly" },
    proofKeys: ["shield"],
  });
  const restoreTarget = Number(formatUnits(before.debt, before.loanDecimals));

  // ---- 7. while New York is closed, the keeper's restore is refused by the contract
  const closedAt = close + Math.floor((reopen - close) / 2);
  await warp(closedAt);
  const want = repay.assets;
  const restoreTx = writes.restore(account, want);
  let refusal: { name: string; reason?: string; message: string } | null = null;
  try {
    await pub.call({ account: desk, to: restoreTx.to, data: restoreTx.data });
  } catch (err) {
    const e = decodeBallastError(err);
    if (e) refusal = { name: e.name, ...(e.reason ? { reason: e.reason } : {}), message: e.message };
  }
  if (!refusal) throw new Error("restore during the closure was not refused");
  const debtBeforeRefusal = (await accountState(pub, d, account)).debt;
  const refused = await send(desk, restoreTx, "restore while closed", `restore(${usd(want)} USD1)`, { expectRevert: true });
  const afterRefusal = await accountState(pub, d, account);
  steps.push({
    id: "refused",
    kind: "refused",
    title: "While New York is closed, a restore is refused",
    summary: `The keeper asks to borrow ${usd(want)} USD1 back into the cushion. The account asks the Session Oracle whether risk may be added; the answer is no, and the call reverts with ${refusal.name}(${refusal.reason ?? ""}). Nothing moved: the keeper can make a loan safer while the market is shut, never riskier.`,
    at: (await head()).at,
    txs: [refused.record],
    result: { call: `restore(${usd(want)} USD1)`, reverted: true, debtBefore: usd(debtBeforeRefusal), debtAfter: usd(afterRefusal.debt), cushionAfter: usd(afterRefusal.cushion) },
    error: refusal,
    state: await snapshot(d, account, jobId),
    reproduce: { test: "contracts/test/fork/ListaAccount.fork.t.sol:test_restore_refusedOnWeekend_andMovesNothing", command: "pnpm contracts:test:fork --match-test test_restore_refusedOnWeekend_andMovesNothing" },
    proofKeys: ["restore-refused"],
  });

  // ---- 8. after the open and the restore delay, the oracle allows risk again and the keeper restores
  await warp(reopen + restoreDelay + 60);
  at = (await head()).at;
  await printReference(d, feed, OWNER, reopen + 60);
  const reposted = await send(desk, overlayTx(d, at, maxOverlayTtl), "post the overlay", `postOverlays([${SYMBOL}], valid 6 h, no flags)`);
  const stateOpen = await accountState(pub, d, account);
  const oracleOpen = await oracleSnapshot(pub, d, SYMBOL);
  if (!oracleOpen.canAddRisk) throw new Error(`the Session Oracle still refuses after the open: ${oracleOpen.reason}`);
  const rplan = planForAccount(stateOpen, oracleOpen, { restoreToDebtUsd: restoreTarget });
  const borrowBack = rplan.steps.find((s) => s.fn === "restore");
  if (!borrowBack || borrowBack.fn !== "restore") throw new Error(`the planner asked for no restore (${rplan.kind})`);
  const restored = await send(desk, writes.restore(account, borrowBack.assets), "restore", `restore(${usd(borrowBack.assets)} USD1)`);
  const rev = parseEventLogs({ abi: ballastAccountBaseAbi, eventName: "Restored", logs: restored.receipt.logs })[0];
  const rArgs = rev?.args as { assets: bigint; ltvBps: bigint } | undefined;
  steps.push({
    id: "restore",
    kind: "restore",
    title: "After the open, the keeper restores",
    summary: `Ninety minutes after the bell the Session Oracle answers yes: regular session, overlay valid, price converged to the reference, no closure within three hours. The same call that was refused now goes through, and ${usd(borrowBack.assets)} USD1 returns to the cushion, inside the owner's ${MANDATE.maxLtvBps / 100}% cap.`,
    at: (await head()).at,
    txs: [reposted.record, restored.record],
    result: { canAddRisk: true, restored: `${usd(borrowBack.assets)} USD1`, ltvAfterBps: rArgs ? Number(rArgs.ltvBps) : null, maxLtvBps: MANDATE.maxLtvBps },
    state: await snapshot(d, account, jobId),
    reproduce: { test: "contracts/test/fork/ListaAccount.fork.t.sol:test_restore_borrowsIntoCushionWhenAllowed", command: "pnpm contracts:test:fork --match-test test_restore_borrowsIntoCushionWhenAllowed" },
    proofKeys: ["restore"],
    forkOnly: ["The reference feed was reprinted at the frozen price, stamped one minute after the open."],
  });

  // ---- 9. the window is over: the desk submits its evidence, anyone settles
  await warp(end + 60);
  const evidence = { jobId: jobId.toString(), account, window: { start: jobStart, end }, events: steps.filter((s) => ["shield", "refused", "restore"].includes(s.kind)).map((s) => ({ kind: s.kind, at: s.at, tx: s.txs[s.txs.length - 1]?.hash ?? null })) };
  const deliverable = keccak256(toHex(JSON.stringify(evidence)));
  const submitted = await send(desk, writes.submit(d, jobId, deliverable), "submit the evidence", `submit(job ${jobId}, keccak256 of the evidence)`);
  const deskBefore = await pub.readContract({ address: usd1, abi: erc20Abi, functionName: "balanceOf", args: [desk] });
  const settled = await send(OWNER, writes.settle(d, jobId), "settle", `BallastGuardian.settle(job ${jobId})`);
  const deskAfter = await pub.readContract({ address: usd1, abi: erc20Abi, functionName: "balanceOf", args: [desk] });
  const sev = parseEventLogs({ abi: ballastGuardianAbi, eventName: "Settled", logs: settled.receipt.logs })[0];
  const setArgs = sev?.args as { survived: boolean; paid: boolean } | undefined;
  const feedbackFailed = parseEventLogs({ abi: ballastGuardianAbi, eventName: "FeedbackFailed", logs: settled.receipt.logs }).length > 0;
  let feedback: { value: number; tag: string } | null = null;
  try {
    const idx = await pub.readContract({ address: d.external.reputationRegistry, abi: reputationAbi, functionName: "getLastIndex", args: [DESK_AGENT_ID, d.guardian] });
    if (idx > 0n) {
      const f = await pub.readContract({ address: d.external.reputationRegistry, abi: reputationAbi, functionName: "readFeedback", args: [DESK_AGENT_ID, d.guardian, idx] });
      feedback = { value: Number(f[0]), tag: f[2] };
    }
  } catch {
    // the registry could not be read: the recording says so by leaving the feedback empty
  }
  steps.push({
    id: "settle",
    kind: "settle",
    title: "The window ends: the job settles",
    summary: `The desk submits the hash of its evidence. Anyone may then call settle: the guardian contract checks that the account was not liquidated and is healthy, releases the escrow to the desk, and writes the outcome to the desk's ERC-8004 reputation. Had the loan been liquidated, the fee would have gone back to the borrower.`,
    at: (await head()).at,
    txs: [submitted.record, settled.record],
    result: {
      jobId: jobId.toString(),
      deliverable,
      survived: setArgs?.survived ?? null,
      paid: setArgs?.paid ?? null,
      payout: `${formatUnits(deskAfter - deskBefore, 18)} USD1`,
      reputationValue: feedback?.value ?? null,
      reputationTag: feedback?.tag ?? null,
      feedbackWritten: !feedbackFailed && feedback !== null,
    },
    state: await snapshot(d, account, jobId),
    reproduce: { test: "contracts/test/fork/BallastGuardian.fork.t.sol:test_survivedWindow_paysGuardianAndWritesReputation", command: "pnpm contracts:test:fork --match-test test_survivedWindow_paysGuardianAndWritesReputation" },
    proofKeys: ["job-settle"],
  });

  const out = {
    version: 1,
    recordedAt: new Date().toISOString(),
    fork: { of: "BNB Chain", chainId: 56, block: fork.number, blockTime: fork.at, localChainId: 31337 },
    deployment: { source: deploymentSource, sessionOracle: d.sessionOracle, sessionAwareFeed: d.sessionAwareFeed, factory: d.factory, cushionVault: d.cushionVault, guardian: d.guardian, calendar: d.calendar },
    actors: { borrower: OWNER, desk, agentId: DESK_AGENT_ID.toString() },
    market: { label: "Lista NVDAB / USD1", symbol: SYMBOL, lltvBps: Math.round(Number(mp.lltv / 10n ** 14n)) },
    forkOnly,
    steps,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`recorded ${steps.length} steps, ${steps.reduce((n, s) => n + s.txs.length, 0)} transactions -> ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
