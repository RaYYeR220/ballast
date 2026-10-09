// The Ballast demo position on BSC mainnet, one small step at a time.
//
//   tsx scripts/demo/mainnet.ts status
//   tsx scripts/demo/mainnet.ts open-venus [--usdt 5.6] [--ltv-bps 5800] [--route binance|pancake]
//
// DRY RUN BY DEFAULT: every step is simulated and printed, nothing is signed. `--send` broadcasts; on real
// BSC mainnet it also needs `--confirm-mainnet`. `--fork-rpc <url>` runs against a local anvil fork of
// mainnet instead (the node must be anvil on loopback). Any other chain is refused.
//
// Hard caps (scripts/demo/mainnet-lib.ts): at most 6 USDT leaves the wallet and at most 0.001 BNB of gas is
// signed for, summed over every transaction recorded in the proof file; never above 1 gwei. Each sent
// transaction is appended to data/proof-txs.json ({ label, txHash, at, note }) and printed with its BscScan
// link. Re-runs are safe: a step whose result is already on-chain (account, allowance, collateral, loan)
// is skipped.
//
// Env (or --env-file <path>, never printed): OWNER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY (only with --send),
// OWNER_ADDRESS (dry runs without a key; default the deployment's owner), BSC_RPC_URL,
// BINANCE_WEB3_API_KEY / BINANCE_WEB3_API_SECRET (the buy goes through the Binance Trading API; without them,
// or if it fails, the PancakeSwap v3 pool from config is used and the output says so), DESK_URL.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Web3Client, trading, transaction } from "@ballast/binance";
import { bscConfig, tickerBySymbol } from "@ballast/risk";
import {
  accountState,
  ballastFactoryAbi,
  comptrollerAbi,
  decodeBallastError,
  loadDeployment,
  oracleSnapshot,
  planForAccount,
  sessionOracleAbi,
  sessionState,
  venusOracleAbi,
  writes,
  type AccountState,
  type Deployment,
  type TxRequest,
} from "@ballast/sdk";
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, http, keccak256, parseAbi, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { SpendGuard, amountOption, appendProof, bscScanTx, checkBinanceSwap, intOption, minOut, parseArgs, planVenusOpen, priorSpend, readProofs, type Cli } from "./mainnet-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYMBOL = "TSLA";
/** maxLtv is the Venus collateral factor (the venue refuses more anyway); the keeper may restore. */
const MANDATE = { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true };
const SLIPPAGE_BPS = 150;
const DEFAULT_DESK_URL = "https://34-185-146-173.sslip.io";
const E18 = 10n ** 18n;

const pancakeRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const pancakeQuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const f = (x: bigint, digits = 4, decimals = 18) => Number(formatUnits(x, decimals)).toFixed(digits);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const log = (line = "") => console.log(line);

interface Ctx {
  cli: Cli;
  client: PublicClient;
  chainId: number;
  fork: boolean;
  d: Deployment;
  owner: Address;
  signer: PrivateKeyAccount | null;
  /** The desk key: publisher of the Session Oracle and keeper of the account. */
  keeper: Address;
  binance: Web3Client | null;
  guard: SpendGuard;
  proofFile: string;
  /** Dry run only: a step above was not sent, so what follows cannot be simulated against the chain. */
  ahead: boolean;
}

async function context(cli: Cli): Promise<Ctx> {
  if (cli.options["env-file"]) process.loadEnvFile(path.resolve(cli.options["env-file"]));
  const fork = cli.forkRpc !== null;
  const rpc = cli.forkRpc ?? process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
  const probe = createPublicClient({ transport: http(rpc, { retryCount: 3 }) });
  const chainId = await probe.getChainId();
  if (fork) {
    const host = new URL(rpc).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error("--fork-rpc must be a node on loopback");
    const version = String(await probe.request({ method: "web3_clientVersion" } as never));
    if (!/anvil/i.test(version)) throw new Error(`--fork-rpc must be an anvil fork, this node is ${version}`);
  } else if (chainId !== 56) {
    throw new Error(`refusing chain ${chainId}: BSC mainnet (56) only, or a fork with --fork-rpc`);
  }
  if (cli.send && !fork && !cli.confirmMainnet) throw new Error("--send on BSC mainnet also needs --confirm-mainnet");
  const chain = defineChain({ id: chainId, name: fork ? "bsc-fork" : "bsc", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 3 }), cacheTime: 0 }) as PublicClient;
  // Always the real mainnet deployment; a fork under another chain id borrows BSC's external addresses.
  const d = loadDeployment(chainId === 56 ? 56 : 31337, { file: path.join(ROOT, "contracts", "deployments", "56.json") });

  const key = process.env.OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  const signer = cli.send ? (key ? privateKeyToAccount(key as Hex) : null) : null;
  if (cli.send && !signer) throw new Error("--send needs OWNER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY)");
  const named = process.env.OWNER_ADDRESS ? getAddress(process.env.OWNER_ADDRESS) : null;
  if (signer && named && !same(signer.address, named)) throw new Error("the private key is not the key of OWNER_ADDRESS");
  const owner = signer?.address ?? named ?? d.owner;
  if (!owner) throw new Error("no owner: set OWNER_ADDRESS");

  const keeper = await client.readContract({ address: d.sessionOracle, abi: sessionOracleAbi, functionName: "publisher" });
  let binance: Web3Client | null = null;
  if (process.env.BINANCE_WEB3_API_KEY && process.env.BINANCE_WEB3_API_SECRET) {
    // The API rejects a request whose timestamp is off by a few seconds: follow the server's clock.
    let offset = 0;
    try {
      const head = await fetch("https://web3.binance.com/", { method: "HEAD", signal: AbortSignal.timeout(8000) });
      const server = Date.parse(head.headers.get("date") ?? "");
      if (Number.isFinite(server)) offset = server - Date.now();
    } catch {
      // keep the local clock
    }
    binance = new Web3Client({ apiKey: process.env.BINANCE_WEB3_API_KEY, apiSecret: process.env.BINANCE_WEB3_API_SECRET, probe: () => {}, now: () => new Date(Date.now() + offset), recvWindowMs: 20_000 });
  }
  const proofFile = cli.options["proof-file"] ? path.resolve(cli.options["proof-file"]) : fork ? path.join(ROOT, "apps", "agent", "var", "proof-txs.fork.json") : path.join(ROOT, "data", "proof-txs.json");
  const guard = new SpendGuard(priorSpend(readProofs(proofFile), chainId));
  log(`${fork ? `FORK of BSC (chain ${chainId}) at ${rpc}` : "BSC MAINNET"} | ${cli.send ? "SENDING" : "DRY RUN (nothing is signed; add --send to broadcast)"}`);
  log(`owner ${owner} | keeper (desk) ${keeper} | proofs ${path.relative(ROOT, proofFile)}`);
  log(`caps: ${f(guard.usdt, 2)} of 6 USDT spent, ${formatEther(guard.gasWei)} of 0.001 BNB gas signed for so far`);
  return { cli, client, chainId, fork, d, owner, signer, keeper, binance, guard, proofFile, ahead: false };
}

// ------------------------------------------------------------------- send

interface Step {
  label: string;
  tx: TxRequest;
  note: string;
  /** USDT that leaves the wallet in this transaction. */
  usdt?: bigint;
  /** Broadcast through the Binance MEV-protected endpoint on mainnet (the swap). */
  mev?: boolean;
  /** Does not depend on the steps before it, so a dry run can still simulate it. */
  standalone?: boolean;
}

function explain(err: unknown): string {
  const d = decodeBallastError(err);
  if (d) return `${d.name}: ${d.message}`;
  const e = err as { shortMessage?: string; details?: string; message?: string };
  return [e.shortMessage ?? e.message ?? String(err), e.details].filter(Boolean).join(" | ").slice(0, 300);
}

/** Simulates a step and, with --send, signs and broadcasts it and waits for the receipt. */
async function run(ctx: Ctx, s: Step): Promise<boolean> {
  const { client, owner } = ctx;
  log(`\n> ${s.label}: ${s.note}`);
  log(`  to ${/^0x0{40}$/.test(s.tx.to) ? "(the account, once it exists)" : s.tx.to} data ${s.tx.data.slice(0, 10)}... (${(s.tx.data.length - 2) / 2} bytes)`);
  if (ctx.ahead && !s.standalone) {
    log("  not simulated: it needs the steps above on-chain first (they run in order with --send)");
    return false;
  }
  try {
    await client.call({ account: owner, to: s.tx.to, data: s.tx.data, value: s.tx.value });
  } catch (err) {
    throw new Error(`${s.label} would revert: ${explain(err)}`);
  }
  log("  eth_call simulation: ok");
  if (ctx.binance && !ctx.fork) {
    try {
      const sim = await transaction.simulate(ctx.binance, { binanceChainId: "56", evmTx: { from: owner, to: s.tx.to, value: s.tx.value.toString(), data: s.tx.data } });
      const moves = sim.balanceChanges.filter((b) => same(b.owner, owner)).map((b) => `${b.contractAddress.slice(0, 8)} ${b.change}`);
      log(`  Binance simulation: ${sim.status}${sim.failReason ? ` (${sim.failReason})` : ""}${moves.length ? ` | wallet ${moves.join(", ")}` : ""}`);
      if (sim.status !== "SUCCESS") throw new Error(`${s.label}: the Binance simulation failed (${sim.failReason ?? "no reason"})`);
    } catch (err) {
      if (err instanceof Error && /Binance simulation failed/.test(err.message)) throw err;
      log(`  Binance simulation unavailable (${explain(err)}): going by eth_call`);
    }
  }
  const gas = ((await client.estimateGas({ account: owner, to: s.tx.to, data: s.tx.data, value: s.tx.value })) * 120n) / 100n;
  const gasPrice = ((await client.getGasPrice()) * 110n) / 100n;
  log(`  gas limit ${gas} at ${formatUnits(gasPrice, 9)} gwei = at most ${formatEther(gas * gasPrice)} BNB`);
  if (!ctx.cli.send || !ctx.signer) {
    ctx.ahead = true;
    log("  DRY RUN: not sent");
    return false;
  }
  // The caps are checked on what is about to be signed, before it is signed.
  ctx.guard.addGas(gas, gasPrice);
  if (s.usdt) ctx.guard.addUsdt(s.usdt);
  const nonce = await client.getTransactionCount({ address: owner, blockTag: "pending" });
  const signed = await ctx.signer.signTransaction({ type: "legacy", chainId: ctx.chainId, nonce, to: s.tx.to, data: s.tx.data, value: s.tx.value, gas, gasPrice });
  const txHash = keccak256(signed);
  let via = "rpc";
  if (s.mev && ctx.binance && !ctx.fork) {
    try {
      await transaction.broadcast(ctx.binance, { binanceChainId: "56", signedTransaction: signed, address: owner, enableMevProtection: true });
      via = "Binance MEV-protected broadcast";
    } catch (err) {
      log(`  Binance broadcast failed (${explain(err)}): sending through the RPC`);
    }
  }
  if (via === "rpc") {
    try {
      await client.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      if (!/already known|known transaction/i.test(explain(err))) throw err;
    }
  }
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 180_000, pollingInterval: 1_500, retryCount: 20 });
  appendProof(ctx.proofFile, {
    label: s.label,
    txHash,
    at: new Date().toISOString(),
    note: `${s.note}${receipt.status === "success" ? "" : " (REVERTED)"}`,
    chainId: ctx.chainId,
    ...(s.usdt ? { usdtSpent: s.usdt.toString() } : {}),
    feeWei: (gas * gasPrice).toString(),
  });
  log(`  ${receipt.status === "success" ? "MINED" : "REVERTED"} via ${via} in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  log(`  ${ctx.fork ? `(fork) ${txHash}` : bscScanTx(txHash)}`);
  if (receipt.status !== "success") throw new Error(`${s.label} reverted on-chain (${txHash})`);
  return true;
}

// ------------------------------------------------------------------ reads

const balanceOf = (c: PublicClient, token: Address, who: Address) => c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const allowance = (c: PublicClient, token: Address, who: Address, spender: Address) => c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [who, spender] });
const approveTx = (token: Address, spender: Address, amount: bigint): TxRequest => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), value: 0n });

/** The owner's Venus account for the symbol that the desk keeps, if there is one. */
async function findAccount(ctx: Ctx): Promise<AccountState | null> {
  const list = await ctx.client.readContract({ address: ctx.d.factory, abi: ballastFactoryAbi, functionName: "accountsOf", args: [ctx.owner] });
  for (const a of [...list].reverse()) {
    const s = await accountState(ctx.client, ctx.d, a);
    if (s.venue === "venus" && s.symbol === SYMBOL && same(s.keeper, ctx.keeper)) return s;
  }
  return null;
}

interface Venus {
  vCollateral: Address;
  vDebt: Address;
  collateralFactor: number;
  liquidationThreshold: number;
  collateralPriceUsd: number;
  loanPriceUsd: number;
}

async function venusMarket(ctx: Ctx): Promise<Venus> {
  const vCollateral = getAddress(bscConfig.venus.vTSLAB);
  const vDebt = getAddress(bscConfig.venus.vUSDT);
  const [mk, cPrice, dPrice] = await Promise.all([
    ctx.client.readContract({ address: ctx.d.external.comptroller, abi: comptrollerAbi, functionName: "markets", args: [vCollateral] }),
    ctx.client.readContract({ address: ctx.d.external.venusOracle, abi: venusOracleAbi, functionName: "getUnderlyingPrice", args: [vCollateral] }),
    ctx.client.readContract({ address: ctx.d.external.venusOracle, abi: venusOracleAbi, functionName: "getUnderlyingPrice", args: [vDebt] }),
  ]);
  if (!mk[0]) throw new Error("vTSLAB is not listed on Venus");
  const threshold = mk[3] > 0n ? mk[3] : mk[1];
  return {
    vCollateral,
    vDebt,
    collateralFactor: Number(formatUnits(mk[1], 18)),
    liquidationThreshold: Number(formatUnits(threshold, 18)),
    collateralPriceUsd: Number(formatUnits(cPrice, 18)), // both tokens have 18 decimals
    loanPriceUsd: Number(formatUnits(dPrice, 18)),
  };
}

// -------------------------------------------------------------------- buy

interface Buy {
  route: string;
  steps: Step[];
  expectedOut: bigint;
  minOut: bigint;
}

async function buyViaBinance(ctx: Ctx, usdt: Address, tslab: Address, amountIn: bigint): Promise<Buy> {
  if (!ctx.binance) throw new Error("no Binance Web3 API key in the environment");
  const base = { binanceChainId: "56", amount: amountIn.toString(), fromTokenAddress: usdt, toTokenAddress: tslab, userWalletAddress: ctx.owner };
  const quotes = (await trading.quote(ctx.binance, base)) as { isBest?: boolean; quoteId: string; vendorName: string }[];
  const quote = quotes.find((q) => q.isBest) ?? quotes[0];
  if (!quote) throw new Error("the Trading API returned no quote");
  const approve = await trading.approveTransaction(ctx.binance, { binanceChainId: "56", tokenContractAddress: usdt, approveAmount: amountIn.toString(), vendor: quote.vendorName });
  const swap = await trading.swap(ctx.binance, { ...base, quoteId: quote.quoteId, slippagePercent: (SLIPPAGE_BPS / 100).toString(), vendor: quote.vendorName });
  const checked = checkBinanceSwap({ owner: ctx.owner, tokenIn: usdt, tokenOut: tslab, amountIn, slippageBps: SLIPPAGE_BPS, quote, approve, swap });
  if (((await ctx.client.getCode({ address: checked.spender })) ?? "0x") === "0x") throw new Error(`the swap contract ${checked.spender} has no code`);
  const steps: Step[] = [];
  if ((await allowance(ctx.client, usdt, ctx.owner, checked.spender)) < amountIn) {
    steps.push({ label: "approve USDT to the swap contract", tx: checked.approve, note: `exactly ${f(amountIn, 2)} USDT to ${checked.spender} (the quote's approveTarget)` });
  }
  steps.push({
    label: "buy TSLAB",
    tx: checked.swap,
    note: `${f(amountIn, 2)} USDT -> about ${f(checked.expectedOut, 6)} TSLAB, at least ${f(checked.minOut, 6)} (${SLIPPAGE_BPS / 100}% slippage), Binance Trading API via ${checked.vendor}`,
    usdt: amountIn,
    mev: true,
  });
  return { route: `Binance Trading API (${checked.vendor})`, steps, expectedOut: checked.expectedOut, minOut: checked.minOut };
}

async function buyViaPancake(ctx: Ctx, usdt: Address, tslab: Address, amountIn: bigint): Promise<Buy> {
  const router = ctx.d.external.pancakeV3Router;
  const fee = 2500; // config: pancake.pools.TSLAB_USDT_2500
  const quoted = await ctx.client.simulateContract({
    address: getAddress(bscConfig.pancake.quoterV2),
    abi: pancakeQuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: usdt, tokenOut: tslab, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  const expectedOut = quoted.result[0];
  const floor = minOut(expectedOut, SLIPPAGE_BPS);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const tx: TxRequest = {
    to: router,
    data: encodeFunctionData({ abi: pancakeRouterAbi, functionName: "exactInputSingle", args: [{ tokenIn: usdt, tokenOut: tslab, fee, recipient: ctx.owner, deadline, amountIn, amountOutMinimum: floor, sqrtPriceLimitX96: 0n }] }),
    value: 0n,
  };
  const steps: Step[] = [];
  if ((await allowance(ctx.client, usdt, ctx.owner, router)) < amountIn) steps.push({ label: "approve USDT to PancakeSwap v3", tx: approveTx(usdt, router, amountIn), note: `exactly ${f(amountIn, 2)} USDT to the v3 router ${router}` });
  steps.push({ label: "buy TSLAB", tx, note: `${f(amountIn, 2)} USDT -> about ${f(expectedOut, 6)} TSLAB, at least ${f(floor, 6)}, PancakeSwap v3 TSLAB/USDT 0.25% pool`, usdt: amountIn });
  return { route: "PancakeSwap v3 TSLAB/USDT 0.25% pool (fallback)", steps, expectedOut, minOut: floor };
}

// ------------------------------------------------------------- open-venus

function printPlan(v: Venus, collateral: bigint, ltvBps: number, gap: { window: string; gapBps: number; startsAt: number }) {
  const plan = planVenusOpen({ collateralTokens: Number(formatUnits(collateral, 18)), collateralPriceUsd: v.collateralPriceUsd, loanPriceUsd: v.loanPriceUsd, collateralFactor: v.collateralFactor, liquidationThreshold: v.liquidationThreshold, ltvBps, gapBps: gap.gapBps, targetHfAfterGap: 1.05 });
  log("\nplanned position");
  log(`  collateral   ${f(collateral, 6)} TSLAB = $${plan.collateralValueUsd.toFixed(2)} at the Venus oracle price $${v.collateralPriceUsd.toFixed(2)}`);
  log(`  Venus        collateral factor ${(v.collateralFactor * 100).toFixed(0)}% (borrow limit), liquidation threshold ${(v.liquidationThreshold * 100).toFixed(0)}%`);
  log(`  borrow       ${plan.borrowTokens.toFixed(2)} USDT, kept in the account as the cushion -> LTV ${(plan.ltvBps / 100).toFixed(2)}%, health ${plan.hfNow.toFixed(3)} (1 = liquidation)`);
  log(`  mandate      maxLtv ${MANDATE.maxLtvBps} bps, shieldLtv ${MANDATE.shieldLtvBps} bps, maxSlippage ${MANDATE.maxSlippageBps} bps, autoRestore ${MANDATE.autoRestore}`);
  log(`  next closure ${gap.window} from ${new Date(gap.startsAt * 1000).toISOString()}, gap ${gap.gapBps} bps -> health after the gap ${plan.hfAfterGap.toFixed(3)}`);
  if (plan.shield.kind === "repay") {
    log(`  keeper       WILL shield in the lead window: shieldRepay about ${plan.shield.repayUsd.toFixed(2)} USDT, then restore about ${plan.restoreUsd.toFixed(2)} USDT after the next open`);
  } else {
    log(`  keeper       will NOT shield before this closure (${plan.shield.reason}).`);
    log(`               It shields only above LTV ${(plan.shieldAboveLtvBps / 100).toFixed(2)}% for this gap at its target health 1.05; Venus lends at most ${(v.collateralFactor * 100).toFixed(0)}%.`);
  }
  return plan;
}

async function openVenus(ctx: Ctx) {
  const { client, d, owner } = ctx;
  const usdt = d.external.tokens.USDT as Address;
  const tslab = getAddress(tickerBySymbol(SYMBOL).bStock);
  const amountIn = amountOption(ctx.cli.options, "usdt", "5.6");
  const ltvBps = intOption(ctx.cli.options, "ltv-bps", 5800, 100, 9000);
  const route = ctx.cli.options.route ?? "binance";
  if (route !== "binance" && route !== "pancake") throw new Error("--route must be binance or pancake");
  const v = await venusMarket(ctx);
  const snap = await oracleSnapshot(client, d, SYMBOL);
  const gap = snap.windowAhead;
  let account = await findAccount(ctx);
  const [walletUsdt, walletTslab, bnb] = await Promise.all([balanceOf(client, usdt, owner), balanceOf(client, tslab, owner), client.getBalance({ address: owner })]);
  log(`wallet: ${f(walletUsdt, 4)} USDT, ${f(walletTslab, 6)} TSLAB, ${formatEther(bnb)} BNB | account: ${account ? account.address : "none yet"}`);

  // 1. Collateral: in the account already, in the wallet already, or bought now.
  let collateral = account?.collateral ?? 0n;
  let toDeposit = 0n;
  let planned = false;
  if (collateral > 0n) {
    log(`\nskip the buy and the deposit: the account already holds ${f(collateral, 6)} TSLAB`);
  } else if ((Number(formatUnits(walletTslab, 18)) * v.collateralPriceUsd) >= 5) {
    log(`\nskip the buy: the wallet already holds ${f(walletTslab, 6)} TSLAB`);
    toDeposit = walletTslab;
  } else {
    if (walletUsdt < amountIn) throw new Error(`the wallet holds ${f(walletUsdt, 4)} USDT, the buy needs ${f(amountIn, 2)}`);
    let buy: Buy;
    if (route === "pancake") buy = await buyViaPancake(ctx, usdt, tslab, amountIn);
    else {
      try {
        buy = await buyViaBinance(ctx, usdt, tslab, amountIn);
      } catch (err) {
        log(`\nBinance Trading API route not usable (${explain(err)}): falling back to PancakeSwap v3`);
        buy = await buyViaPancake(ctx, usdt, tslab, amountIn);
      }
    }
    log(`\nbuy route: ${buy.route}`);
    // Whatever the route says, the price must be near the Venus oracle's: this is the collateral's valuation.
    const worth = Number(formatUnits(buy.minOut, 18)) * v.collateralPriceUsd;
    const paid = Number(formatUnits(amountIn, 18)) * v.loanPriceUsd;
    if (worth < paid * 0.97) throw new Error(`the buy returns at least $${worth.toFixed(2)} of TSLAB for $${paid.toFixed(2)}: more than 3% under the oracle price, not buying`);
    printPlan(v, buy.expectedOut, ltvBps, gap);
    planned = true;
    let bought = true;
    for (const s of buy.steps) bought = (await run(ctx, s)) && bought;
    if (bought) {
      const got = (await balanceOf(client, tslab, owner)) - walletTslab;
      log(`  received ${f(got, 6)} TSLAB (floor ${f(buy.minOut, 6)})`);
      if (got < buy.minOut) throw new Error("received less TSLAB than the floor: stop and look");
      toDeposit = await balanceOf(client, tslab, owner);
    } else toDeposit = buy.expectedOut;
  }
  if (!planned && (collateral > 0n || toDeposit > 0n)) printPlan(v, collateral > 0n ? collateral : toDeposit, ltvBps, gap);

  // 2. The Ballast account, kept by the desk.
  if (account) log(`\nskip the account: ${account.address} exists (keeper ${account.keeper})`);
  else {
    const made = await run(ctx, {
      label: "create the Ballast Venus account",
      tx: writes.createVenusAccount(d, { vCollateral: v.vCollateral, vDebt: v.vDebt, symbol: SYMBOL, keeper: ctx.keeper, mandate: MANDATE }),
      note: `vTSLAB collateral, vUSDT debt, keeper = the desk ${ctx.keeper}`,
      standalone: true,
    });
    if (made) {
      account = await findAccount(ctx);
      if (!account) throw new Error("the account was created but is not listed for the owner yet: run again");
      log(`  account ${account.address}`);
    }
  }
  const at = account?.address ?? ("0x0000000000000000000000000000000000000000" as Address);

  // 3. Deposit the collateral.
  if (toDeposit > 0n) {
    if (!account || (await allowance(client, tslab, owner, at)) < toDeposit) {
      await run(ctx, { label: "approve TSLAB to the account", tx: approveTx(tslab, at, toDeposit), note: `exactly ${f(toDeposit, 6)} TSLAB` });
    }
    const done = await run(ctx, { label: "deposit the collateral", tx: writes.depositCollateral(at, toDeposit), note: `${f(toDeposit, 6)} TSLAB into Venus through the account` });
    if (done) collateral = (await accountState(client, d, at)).collateral;
    else collateral = toDeposit;
  }

  // 4. Borrow; the loan stays in the account as its cushion.
  const state = account ? await accountState(client, d, at) : null;
  if (state && state.debt > 0n) {
    log(`\nskip the borrow: the account already owes ${f(state.debt, 4)} USDT (cushion ${f(state.cushion, 4)})`);
  } else if (collateral > 0n) {
    const plan = planVenusOpen({ collateralTokens: Number(formatUnits(collateral, 18)), collateralPriceUsd: v.collateralPriceUsd, loanPriceUsd: v.loanPriceUsd, collateralFactor: v.collateralFactor, liquidationThreshold: v.liquidationThreshold, ltvBps, gapBps: gap.gapBps, targetHfAfterGap: 1.05 });
    const assets = parseUnits(plan.borrowTokens.toFixed(2), 18);
    await run(ctx, { label: "borrow into the cushion", tx: writes.borrow(at, assets, at), note: `${plan.borrowTokens.toFixed(2)} USDT from Venus, kept in the account (LTV ${(plan.ltvBps / 100).toFixed(2)}%)` });
  }
  if (!ctx.ahead) await status(ctx);
  else log("\nDRY RUN complete: nothing was signed. Re-run with --send to execute the steps in order.");
}

// ----------------------------------------------------------------- status

async function status(ctx: Ctx) {
  const { client, d } = ctx;
  const [session, snap, v] = await Promise.all([sessionState(client, d), oracleSnapshot(client, d, SYMBOL), venusMarket(ctx)]);
  log(`\nstatus at ${new Date(session.at * 1000).toISOString()} (block ${session.blockNumber})`);
  log(`  session      ${session.session}; next close ${new Date(session.nextClose * 1000).toISOString()}, next open ${new Date(session.nextOpen * 1000).toISOString()}`);
  log(`  oracle ${SYMBOL}  canAddRisk ${snap.canAddRisk} (${snap.reason}: ${snap.reasonText}); overlay ${snap.overlay.fresh ? "fresh" : "STALE"} until ${new Date(snap.overlay.validUntil * 1000).toISOString()}`);
  log(`               window ahead ${snap.windowAhead.window} from ${new Date(snap.windowAhead.startsAt * 1000).toISOString()}, gap ${snap.windowAhead.gapBps} bps; per-share $${snap.perShare === null ? "n/a" : f(snap.perShare, 2, 8)}`);
  const account = await findAccount(ctx);
  if (!account) log(`  account      none: ${ctx.owner} has no ${SYMBOL} Venus account kept by the desk yet`);
  else {
    const value = Number(formatUnits(account.collateral, 18)) * v.collateralPriceUsd;
    const debtUsd = Number(formatUnits(account.debt, 18)) * v.loanPriceUsd;
    log(`  account      ${account.address} (owner ${account.owner}, keeper ${account.keeper})`);
    log(`               collateral ${f(account.collateral, 6)} TSLAB = $${value.toFixed(2)}; debt ${f(account.debt, 4)} USDT; cushion ${f(account.cushion, 4)} USDT`);
    log(`               LTV ${account.ltvBps === null ? "n/a" : `${(account.ltvBps / 100).toFixed(2)}%`}; health ${debtUsd > 0 ? ((value * v.liquidationThreshold) / debtUsd).toFixed(3) : "no debt"}; healthy ${account.healthy}; liquidated ${account.liquidated}`);
    log(`               mandate maxLtv ${account.mandate.maxLtvBps}, shieldLtv ${account.mandate.shieldLtvBps}, slippage ${account.mandate.maxSlippageBps}, autoRestore ${account.mandate.autoRestore}`);
    const plan = planForAccount(account, snap);
    const steps = plan.steps.map((s) => `${s.fn}(${"assets" in s ? f(s.assets, 4) : ""})`).join(", ");
    log(`  plan now     ${plan.kind}${"reason" in plan ? `: ${plan.reason}` : ""}${steps ? ` -> ${steps}` : ""} (gap ${plan.gapBps} bps, target health ${plan.targetHfAfterGap})`);
    log(`               the keeper shields above LTV ${(((v.liquidationThreshold * (1 - plan.gapBps / 10_000)) / plan.targetHfAfterGap) * 100).toFixed(2)}% for this gap; Venus lends up to ${(v.collateralFactor * 100).toFixed(0)}%`);
  }
  const url = (ctx.cli.options["desk-url"] ?? process.env.DESK_URL ?? DEFAULT_DESK_URL).replace(/\/$/, "");
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
    const h = (await res.json()) as { ok?: boolean; dryRun?: boolean; agent?: string; sender?: { halted?: { reason?: string } | null; sales?: string }; loops?: { name: string; failures: number; lastError: string | null }[] };
    const loops = (h.loops ?? []).map((l) => `${l.name}${l.lastError ? ` FAILING (${l.lastError.slice(0, 60)})` : " ok"}`).join(", ");
    log(`  desk         ${url}/health -> HTTP ${res.status}, ok ${h.ok}, dryRun ${h.dryRun}, agent ${h.agent}${h.agent && !same(h.agent, ctx.keeper) ? " (NOT the on-chain publisher!)" : ""}`);
    log(`               sender ${h.sender?.halted ? `HALTED (${h.sender.halted.reason})` : "not halted"}, sales ${h.sender?.sales ?? "?"}; loops: ${loops}`);
  } catch (err) {
    log(`  desk         ${url}/health unreachable: ${explain(err)}`);
  }
}

// ------------------------------------------------------------------- main

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const ctx = await context(cli);
  if (cli.command === "status") return status(ctx);
  if (cli.command === "open-venus") return openVenus(ctx);
  throw new Error(`unknown subcommand ${cli.command}: status | open-venus`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nSTOPPED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
