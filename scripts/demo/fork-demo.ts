// Demo on a local anvil fork of BSC (chain 31337 only): one Lista account and one CushionVault cover kept by
// the desk, a guardian job over the account, and clock warps to watch the desk shield before a close and
// settle the job after its window.
//
//   tsx scripts/demo/fork-demo.ts identity     # optional, before Deploy.s.sol: registers the desk's ERC-8004
//                                              # identity and prints its id (deploy with PUBLISHER_AGENT_ID=<id>)
//   tsx scripts/demo/fork-demo.ts setup        # after Deploy.s.sol on the fork (AGENT_ID=<id> reuses the identity)
//   tsx scripts/demo/fork-demo.ts warp lead    # 59 min before the next regular close
//   tsx scripts/demo/fork-demo.ts warp end     # just past the guardian window
//   tsx scripts/demo/fork-demo.ts automine off # stop mining: the desk's next send stays unmined (stuck-send drill)
//   tsx scripts/demo/fork-demo.ts automine on  # mine what is pending and resume
//   tsx scripts/demo/fork-demo.ts status
//
// Env: FORK_RPC (default http://127.0.0.1:8545), DEPLOYMENT_FILE (default contracts/deployments/31337.json),
// AGENT_KEY / USER_KEY (default anvil keys 0 and 2), DEMO_OUT (default apps/agent/var/fork-demo.json).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextClose, nextOpen, session } from "@ballast/risk";
import {
  ballastFactoryAbi,
  identityRegistryAbi,
  kernelAbi,
  loadDeployment,
  moolahAbi,
  readGuardianJobs,
  accountState,
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
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
const OUT = process.env.DEMO_OUT ?? path.join(ROOT, "apps", "agent", "var", "fork-demo.json");
// anvil's well-known development keys (no value anywhere but a local node)
const AGENT_KEY = (process.env.AGENT_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const USER_KEY = (process.env.USER_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as Hex;

const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "bsc-mainnet.json"), "utf8"));
const chain = defineChain({ id: 31337, name: "bsc-fork", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const E18 = 10n ** 18n;

const priceSourceAbi = parseAbi(["function peek(address asset) view returns (uint256)", "function set(address asset, uint256 p)"]);
const erc721Transfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);

async function head() {
  const b = await pub.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}

async function send(from: PrivateKeyAccount, tx: TxRequest, what: string) {
  const w = createWalletClient({ account: from, chain, transport: http(RPC) });
  const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted (${hash})`);
  console.log(`  ${what}: ${hash}`);
  return r;
}

async function fundFromWhale(token: Address, to: Address, amount: bigint) {
  const whale = cfg.forkWhales.binanceHot as Address;
  await test.impersonateAccount({ address: whale });
  await test.setBalance({ address: whale, value: 10n * E18 });
  const w = createWalletClient({ account: whale, chain, transport: http(RPC) });
  const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await pub.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: whale });
}

// -------------------------------------------------------------------------------------------------------
// FORK ONLY, demo only. Warping an anvil fork forward makes Lista's oracles report stale prices, so the
// Session Oracle reads PRICE_UNAVAILABLE and the venue cannot price the account. This replaces the code
// at the Lista stock oracle and resilient oracle addresses with a fixed-price mock (MockPriceSource from
// contracts/test/mocks/Mocks.sol, built by `forge build`) holding the prices read just before, so the
// clock can move. It is never part of the desk and refuses any chain but the local fork.
// -------------------------------------------------------------------------------------------------------
async function freezeListaPrices(payer: PrivateKeyAccount) {
  const art = JSON.parse(readFileSync(path.join(ROOT, "contracts", "out", "Mocks.sol", "MockPriceSource.json"), "utf8"));
  const code = art.deployedBytecode.object as Hex;
  const tokens: Address[] = [
    ...cfg.tickers.map((t: { bStock: string }) => t.bStock as Address),
    cfg.tokens.USD1,
    cfg.tokens.USDT,
    cfg.tokens.USDC,
    cfg.tokens.U,
  ];
  const sources: Address[] = [cfg.lista.stockOracle, cfg.lista.resilientOracle];
  const prices = new Map<string, bigint>();
  for (const src of sources) {
    for (const t of tokens) {
      try {
        const p = await pub.readContract({ address: src, abi: priceSourceAbi, functionName: "peek", args: [t] });
        if (p > 0n) prices.set(`${src}|${t}`, p);
      } catch {
        // this source does not price that token
      }
    }
  }
  for (const src of sources) await test.setCode({ address: src, bytecode: code });
  const w = createWalletClient({ account: payer, chain, transport: http(RPC) });
  for (const [k, p] of prices) {
    const [src, t] = k.split("|") as [Address, Address];
    const hash = await w.writeContract({ address: src, abi: priceSourceAbi, functionName: "set", args: [t, p] });
    await pub.waitForTransactionReceipt({ hash });
  }
  console.log(`  FORK ONLY: froze ${prices.size} Lista oracle prices behind a mock at ${sources.join(", ")}`);
}

// FORK ONLY: the well-known anvil keys carry EIP-7702 delegations on BSC mainnet (sweeper contracts), and
// the ERC-8004 registry mints with safeMint, which a delegated account may refuse. Make them plain EOAs.
async function plainEoa(addresses: Address[]) {
  for (const a of addresses) {
    const code = await pub.getCode({ address: a });
    if (code && code !== "0x") {
      await test.setCode({ address: a, bytecode: "0x" });
      console.log(`  FORK ONLY: cleared the EIP-7702 delegation on ${a}`);
    }
  }
}

/** The desk's ERC-8004 identity on the fork (the guardian checks the provider against it). */
async function registerIdentity(identityRegistry: Address, agent: PrivateKeyAccount): Promise<bigint> {
  const reg = await send(agent, { to: identityRegistry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: ['data:application/json,{"name":"ballast-desk-fork"}'] }), value: 0n }, "register agent identity");
  const minted = parseEventLogs({ abi: erc721Transfer, logs: reg.logs }).find((l) => l.args.to.toLowerCase() === agent.address.toLowerCase());
  if (!minted) throw new Error("no identity minted");
  return minted.args.tokenId;
}

async function assertFork() {
  const id = await pub.getChainId();
  if (id !== 31337) throw new Error(`refusing to run on chain ${id}: this demo is for the local fork only`);
}

function listaMarket(key: string): MarketParams {
  const m = cfg.lista.markets[key];
  return { loanToken: cfg.tokens.USD1, collateralToken: m.collateralToken, oracle: cfg.lista.stockOracle, irm: cfg.lista.irm, lltv: BigInt(m.lltv) };
}

async function setup(d: Deployment) {
  await assertFork();
  const agent = privateKeyToAccount(AGENT_KEY);
  const user = privateKeyToAccount(USER_KEY);
  const mp = listaMarket("NVDAB_USD1");
  const nvdab = mp.collateralToken;
  const usd1 = mp.loanToken;
  console.log(`agent ${agent.address}, user ${user.address}, head ${new Date((await head()) * 1000).toISOString()}`);

  await freezeListaPrices(agent);

  await plainEoa([agent.address, user.address]);
  const agentId = process.env.AGENT_ID ? BigInt(process.env.AGENT_ID) : await registerIdentity(d.external.identityRegistry, agent);
  console.log(`  agentId ${agentId}${process.env.AGENT_ID ? " (given)" : ""}`);

  await fundFromWhale(nvdab, user.address, 20n * E18);
  await fundFromWhale(usd1, user.address, 1000n * E18);

  // Price of one NVDAB in USD1 from the (now frozen) market oracle: size both loans at 69% LTV.
  const price = await pub.readContract({ address: d.external.moolah, abi: moolahAbi, functionName: "getPrice", args: [mp] });
  const value = (10n * E18 * price) / 10n ** 36n; // 10 NVDAB in USD1 wei
  const borrowAmt = (value * 69n) / 100n;
  console.log(`  10 NVDAB = ${Number(value / 10n ** 16n) / 100} USD1, borrowing ${Number(borrowAmt / 10n ** 16n) / 100} at 69% LTV`);

  // 1. A Ballast Lista account kept by the desk, with a 200 USD1 cushion.
  await send(user, writes.createListaAccount(d, { marketParams: mp, symbol: "NVDA", keeper: agent.address, mandate: { maxLtvBps: 7400, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true } }), "create Lista account");
  const mine = await pub.readContract({ address: d.factory, abi: ballastFactoryAbi, functionName: "accountsOf", args: [user.address] });
  const account = mine[mine.length - 1] as Address;
  await send(user, writes.approve(nvdab, account, 10n * E18), "approve collateral");
  await send(user, writes.depositCollateral(account, 10n * E18), "deposit 10 NVDAB");
  await send(user, writes.borrow(account, borrowAmt, user.address), "borrow");
  await send(user, writes.approve(usd1, account, 200n * E18), "approve cushion");
  await send(user, writes.depositCushion(account, 200n * E18), "deposit 200 USD1 cushion");

  // 2. The user's own Moolah loan, protected by a CushionVault cover the desk keeps.
  await send(user, writes.approve(nvdab, d.external.moolah, 10n * E18), "approve Moolah");
  await send(user, { to: d.external.moolah, data: encodeFunctionData({ abi: moolahAbi, functionName: "supplyCollateral", args: [mp, 10n * E18, user.address, "0x"] }), value: 0n }, "supply collateral to Moolah");
  await send(user, { to: d.external.moolah, data: encodeFunctionData({ abi: moolahAbi, functionName: "borrow", args: [mp, borrowAmt, 0n, user.address, user.address] }), value: 0n }, "borrow on Moolah");
  await send(user, writes.approve(usd1, d.cushionVault, 400n * E18), "approve cover");
  await send(user, writes.openListaCover(d, { marketParams: mp, symbol: "NVDA", keeper: agent.address, capPerDay: 300n * E18, amount: 400n * E18 }), "open cover (400 USD1, 300/day)");

  // 3. A guardian job over the account: window from now to 30 min before the close, paid in USD1.
  const now = await head();
  const close = nextClose(now);
  const end = close - 1800;
  if (end < now + 3600) throw new Error("less than an hour before the close: run the demo earlier in the day");
  const expiredAt = nextOpen(end) + 2 * 3600;
  const budget = parseUnits("0.05", 18);
  const created = await send(
    user,
    writes.createJobWithToken(d, { provider: agent.address, expiredAt, description: "guard my NVDA loan through today's close", token: usd1 }),
    "create guardian job",
  );
  const ev = parseEventLogs({ abi: kernelAbi, eventName: "JobCreated", logs: created.logs })[0];
  if (!ev) throw new Error("no JobCreated event");
  const jobId = ev.args.jobId;
  await send(user, writes.setBudget(d, jobId, budget), "set budget 0.05 USD1");
  await send(user, writes.approve(usd1, d.external.kernel, budget), "approve budget");
  await send(user, writes.fund(d, { jobId, expectedBudget: budget, terms: { account, start: now, end, agentId } }), "fund job with terms");

  const out = { account, cover: { user: user.address, market: "NVDAB_USD1" }, jobId: jobId.toString(), agentId: agentId.toString(), start: now, end, close, expiredAt };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify(out, null, 1));
}

async function warp(to: number) {
  const now = await head();
  if (to <= now) {
    console.log(`already at ${new Date(now * 1000).toISOString()} (asked ${new Date(to * 1000).toISOString()})`);
    return;
  }
  await test.setNextBlockTimestamp({ timestamp: BigInt(to) });
  await test.mine({ blocks: 1 });
  const t = await head();
  console.log(`warped to ${new Date(t * 1000).toISOString()} (${session(t)})`);
}

async function status(d: Deployment) {
  const t = await head();
  console.log(`head ${new Date(t * 1000).toISOString()} ${session(t)}, next close ${new Date(nextClose(t) * 1000).toISOString()}`);
  const demo = JSON.parse(readFileSync(OUT, "utf8"));
  const s = await accountState(pub, d, demo.account);
  console.log(`account ${s.address}: debt ${Number(s.debt / 10n ** 16n) / 100} USD1, cushion ${Number(s.cushion / 10n ** 16n) / 100}, ltv ${s.ltvBps} bps, health known ${s.healthKnown}`);
  const [job] = await readGuardianJobs(pub, d, [BigInt(demo.jobId)]);
  console.log(`job ${demo.jobId}: ${job?.status}, deliverable ${job?.deliverable}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "identity") {
    // Before the deployment exists: only the config is needed.
    await assertFork();
    const agent = privateKeyToAccount(AGENT_KEY);
    await plainEoa([agent.address]);
    console.log(`agentId ${await registerIdentity(cfg.erc8004.identity, agent)}`);
    return;
  }
  if (cmd === "automine" && (arg === "on" || arg === "off")) {
    await assertFork();
    await test.setAutomine(arg === "on");
    if (arg === "on") await test.mine({ blocks: 1 });
    console.log(`automine ${arg}${arg === "on" ? ": pending transactions mined" : ": transactions stay in the mempool until it is turned on again"}`);
    return;
  }
  const d = loadDeployment(31337, { file: process.env.DEPLOYMENT_FILE });
  if (cmd === "setup") return setup(d);
  if (cmd === "status") return status(d);
  if (cmd === "warp") {
    const demo = JSON.parse(readFileSync(OUT, "utf8"));
    const now = await head();
    if (arg === "lead") return warp(nextClose(now) - 59 * 60);
    if (arg === "end") return warp(demo.end + 90);
    if (arg && /^\d+$/.test(arg)) return warp(Number(arg));
  }
  console.error("usage: fork-demo.ts identity | setup | warp lead | warp end | warp <unix> | automine on|off | status");
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
