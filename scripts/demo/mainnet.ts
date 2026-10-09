// The Ballast demo position on BSC mainnet, one small step at a time.
//
//   tsx scripts/demo/mainnet.ts status
//   tsx scripts/demo/mainnet.ts open-venus [--usdt 5.6] [--ltv-bps 5350] [--route binance|pancake]
//   tsx scripts/demo/mainnet.ts restore [--amount 0.05]             # owner, market open: succeeds
//   tsx scripts/demo/mainnet.ts guardian-job [--start +5] [--end +65] [--token USD1|U] [--swap-usdt 0.1]
//   tsx scripts/demo/mainnet.ts refused-restore [--amount 0.05]     # owner, market closed: mined, reverts
//
// Common options: --desk-url <url>, --target-hf <n> (default: what the desk's /health reports),
// --proof-file <path>, --env-file <path>; --again repeats a restore, refused-restore or guardian-job already
// on record; --no-binance-sim goes by eth_call alone if the Binance simulate endpoint misbehaves.
//
// DRY RUN BY DEFAULT: every step is simulated and printed, nothing is signed. `--send` broadcasts; on real
// BSC mainnet it also needs `--confirm-mainnet`. `--fork-rpc <url>` runs against a local anvil fork of
// mainnet instead (the node must be anvil on loopback). Any other chain is refused.
//
// Hard caps (scripts/demo/mainnet-lib.ts): at most 6 USDT leaves the wallet and at most 0.001 BNB of gas is
// signed for, summed over every transaction recorded in the proof file; never above 1 gwei. Each sent
// transaction is appended to data/proof-txs.json ({ label, txHash, at, note }) and printed with its BscScan
// link. Re-runs are safe: a step whose result is already on-chain (account, allowance, collateral, loan,
// guardian job) or on record in the proof file (restore, refused restore) is skipped.
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
  DEFAULT_TARGET_HF,
  accountState,
  ballastAccountBaseAbi,
  ballastFactoryAbi,
  ballastGuardianAbi,
  comptrollerAbi,
  decodeBallastError,
  identityRegistryAbi,
  kernelAbi,
  loadDeployment,
  oracleSnapshot,
  planForAccount,
  readGuardianJobs,
  sessionCalendarAbi,
  sessionOracleAbi,
  sessionState,
  venusOracleAbi,
  writes,
  type AccountState,
  type Deployment,
  type SessionState,
  type TxRequest,
} from "@ballast/sdk";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  MAX_GAS_WEI,
  MAX_USDT_SPEND,
  SpendGuard,
  addRiskWindow,
  amountOption,
  appendProof,
  bscScanTx,
  checkBinanceSwap,
  checkRestore,
  expectRefusal,
  guardWindow,
  intOption,
  lastJobId,
  minOut,
  parseArgs,
  parseWhen,
  planVenusOpen,
  priorSpend,
  readProofs,
  utc,
  type Cli,
} from "./mainnet-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYMBOL = "TSLA";
/** maxLtv is the Venus collateral factor (the venue refuses more anyway); the keeper may restore. */
const MANDATE = { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true };
const SLIPPAGE_BPS = 150;
const DEFAULT_DESK_URL = "https://34-185-146-173.sslip.io";
/** Where a rehearsal runs its own desk against the fork. */
const FORK_DESK_URL = "http://127.0.0.1:8789";
/** The desk's ERC-8004 identity on BSC (checked on-chain against the oracle's publisher before it is used). */
const DESK_AGENT_ID = "368122";
const RESTORE_LABEL = "restore (owner, market open)";
const REFUSED_LABEL = "refused restore (owner, market closed)";
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
  /** Dry run only: what --send would sign for. */
  tally: { steps: number; usdt: bigint; gasWei: bigint; unpriced: number };
  deskUrl: string;
  desk: { status: number; body: DeskHealth } | { error: string };
  /** The keeper's target health after the gap: what the desk reports, or --target-hf. */
  targetHf: number;
}

interface DeskHealth {
  ok?: boolean;
  dryRun?: boolean;
  agent?: string;
  targetHfAfterGap?: number;
  sender?: { halted?: { reason?: string } | null; sales?: string };
  loops?: { name: string; failures: number; lastError: string | null }[];
}

async function deskHealth(url: string): Promise<Ctx["desk"]> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: (await res.json()) as DeskHealth };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  // A fork never asks the live desk: its policy and state belong to the other chain.
  const deskUrl = (cli.options["desk-url"] ?? (fork ? FORK_DESK_URL : (process.env.DESK_URL ?? DEFAULT_DESK_URL))).replace(/\/$/, "");
  const desk = await deskHealth(deskUrl);
  const reported = "body" in desk ? desk.body.targetHfAfterGap : undefined;
  let targetHf = DEFAULT_TARGET_HF;
  let targetFrom = "error" in desk ? `the planner default: the desk at ${deskUrl} did not answer` : "the planner default: the desk reports no target";
  if (cli.options["target-hf"] !== undefined) {
    targetHf = Number(cli.options["target-hf"]);
    if (!(targetHf >= 1.01 && targetHf <= 2)) throw new Error("--target-hf must be a health factor from 1.01 to 2.0");
    targetFrom = "--target-hf";
  } else if (typeof reported === "number" && reported >= 1.01 && reported <= 2) {
    targetHf = reported;
    targetFrom = `reported by the desk at ${deskUrl}`;
  }
  log(`${fork ? `FORK of BSC (chain ${chainId}) at ${rpc}` : "BSC MAINNET"} | ${cli.send ? "SENDING" : "DRY RUN (nothing is signed; add --send to broadcast)"}`);
  log(`owner ${owner} | keeper (desk) ${keeper} | proofs ${path.relative(ROOT, proofFile)}`);
  log(`caps: ${f(guard.usdt, 2)} of 6 USDT spent, ${formatEther(guard.gasWei)} of 0.001 BNB gas signed for so far`);
  log(`keeper target health after the gap: ${targetHf} (${targetFrom})`);
  return { cli, client, chainId, fork, d, owner, signer, keeper, binance, guard, proofFile, ahead: false, tally: { steps: 0, usdt: 0n, gasWei: 0n, unpriced: 0 }, deskUrl, desk, targetHf };
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
  /** Typical gas used (measured in the fork rehearsal): shown in a dry run when the step cannot be simulated. */
  gasHint?: bigint;
  /**
   * The transaction must be mined and REVERT with RestoreRefused(<this oracle reason>). The simulation has to
   * fail for exactly that reason first; then it is sent with `gasLimit` (a reverting call cannot be estimated).
   */
  expectRefusal?: string;
  gasLimit?: bigint;
  /** The guardian job the transaction belongs to, for the proof file. */
  jobId?: bigint | ((receipt: TransactionReceipt) => bigint);
}

function explain(err: unknown): string {
  const d = decodeBallastError(err);
  if (d) return `${d.name}: ${d.message}`;
  const e = err as { shortMessage?: string; details?: string; message?: string };
  return [e.shortMessage ?? e.message ?? String(err), e.details].filter(Boolean).join(" | ").slice(0, 300);
}

/** What a step sends, in full when it is short enough to read. */
function dataLine(data: Hex): string {
  const n = (data.length - 2) / 2;
  return n <= 324 ? data : `${data.slice(0, 10)}... (${n} bytes, keccak256 ${keccak256(data)})`;
}

function tally(ctx: Ctx, s: Step, feeWei: bigint | null) {
  ctx.tally.steps += 1;
  ctx.tally.usdt += s.usdt ?? 0n;
  if (feeWei === null) ctx.tally.unpriced += 1;
  else ctx.tally.gasWei += feeWei;
}

/** Ends a dry run: the most --send would move and sign for, against the caps. */
function drySummary(ctx: Ctx) {
  const t = ctx.tally;
  log(`\nDRY RUN complete: nothing was signed. With --send this command sends ${t.steps} transaction${t.steps === 1 ? "" : "s"} from ${ctx.owner}, in the order above:`);
  log(`  USDT leaving the wallet: ${f(t.usdt, 2)} (then ${f(ctx.guard.usdt + t.usdt, 2)} of the ${f(MAX_USDT_SPEND, 0)} USDT cap is used)`);
  log(`  gas: at most about ${formatEther(t.gasWei)} BNB (then ${formatEther(ctx.guard.gasWei + t.gasWei)} of the ${formatEther(MAX_GAS_WEI)} BNB cap is used)${t.unpriced ? `; ${t.unpriced} step(s) above have no gas figure yet` : ""}`);
}

/** Simulates a step and, with --send, signs and broadcasts it and waits for the receipt. */
async function run(ctx: Ctx, s: Step): Promise<TransactionReceipt | null> {
  const { client, owner } = ctx;
  const call = { account: owner, to: s.tx.to, data: s.tx.data, value: s.tx.value };
  log(`\n> ${s.label}: ${s.note}`);
  log(`  to ${/^0x0{40}$/.test(s.tx.to) ? "(the account, once it exists)" : s.tx.to} value ${s.tx.value}`);
  log(`  data ${dataLine(s.tx.data)}`);
  if (s.usdt) log(`  USDT leaving the wallet: ${f(s.usdt, 2)}`);
  const gasPrice = ((await client.getGasPrice()) * 110n) / 100n;
  if (ctx.ahead && !s.standalone) {
    log("  not simulated: it needs the steps above on-chain first (they run in order with --send)");
    const hint = s.gasLimit ?? (s.gasHint ? (s.gasHint * 120n) / 100n : null);
    if (hint) log(`  gas limit about ${hint} (from the fork rehearsal) at ${formatUnits(gasPrice, 9)} gwei = at most about ${formatEther(hint * gasPrice)} BNB`);
    tally(ctx, s, hint ? hint * gasPrice : null);
    return null;
  }
  let refusal: string | null = null;
  if (s.expectRefusal) {
    let decoded: ReturnType<typeof decodeBallastError> = null;
    let failed = false;
    try {
      await client.call(call);
    } catch (err) {
      failed = true;
      decoded = decodeBallastError(err);
      if (!decoded) throw new Error(`${s.label}: the simulation fails with something other than a Ballast error, not sending: ${explain(err)}`);
    }
    refusal = expectRefusal(failed ? decoded : null, s.expectRefusal);
    log(`  eth_call simulation: reverts with ${refusal} (${decoded?.message})`);
  } else {
    try {
      await client.call(call);
    } catch (err) {
      throw new Error(`${s.label} would revert: ${explain(err)}`);
    }
    log("  eth_call simulation: ok");
    if (ctx.binance && !ctx.fork && !ctx.cli.noBinanceSim) {
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
  }
  const gas = s.gasLimit ?? ((await client.estimateGas(call)) * 120n) / 100n;
  log(`  gas limit ${gas}${s.gasLimit ? " (fixed: a reverting call cannot be estimated)" : ""} at ${formatUnits(gasPrice, 9)} gwei = at most ${formatEther(gas * gasPrice)} BNB`);
  if (!ctx.cli.send || !ctx.signer) {
    ctx.ahead = true;
    tally(ctx, s, gas * gasPrice);
    log("  DRY RUN: not sent");
    return null;
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
  const mined = receipt.status === "success";
  let note = `${s.note}${mined ? "" : " (REVERTED)"}`;
  let reason = "";
  if (refusal) {
    if (mined) note = `${s.note} (UNEXPECTED: the transaction went through)`;
    else {
      // What the chain refused it for, read back at the block it was mined in.
      try {
        await client.call({ ...call, blockNumber: receipt.blockNumber });
        reason = "the replay at that block does not revert";
      } catch (err) {
        const d = decodeBallastError(err);
        reason = d ? `${d.name}${d.reason ? `(${d.reason})` : ""}: ${d.message}` : explain(err);
      }
      note = `${s.note} | REVERTED as expected: ${reason}`;
    }
  }
  const jobId = typeof s.jobId === "function" ? (mined ? s.jobId(receipt) : undefined) : s.jobId;
  appendProof(ctx.proofFile, {
    label: s.label,
    txHash,
    at: new Date().toISOString(),
    note,
    chainId: ctx.chainId,
    ...(s.usdt ? { usdtSpent: s.usdt.toString() } : {}),
    feeWei: (gas * gasPrice).toString(),
    ...(jobId === undefined ? {} : { jobId: jobId.toString() }),
  });
  log(`  ${mined ? "MINED" : "REVERTED"} via ${via} in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  log(`  ${ctx.fork ? `(fork) ${txHash}` : bscScanTx(txHash)}`);
  if (refusal) {
    if (mined) throw new Error(`${s.label} went through on-chain (${txHash}): it was expected to revert with ${refusal}`);
    log(`  decoded revert at block ${receipt.blockNumber}: ${reason}`);
    return receipt;
  }
  if (!mined) throw new Error(`${s.label} reverted on-chain (${txHash})`);
  return receipt;
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
    steps.push({ label: "approve USDT to the swap contract", tx: checked.approve, note: `exactly ${f(amountIn, 2)} USDT to ${checked.spender} (the quote's approveTarget)`, gasHint: 46_200n });
  }
  steps.push({
    label: "buy TSLAB",
    tx: checked.swap,
    note: `${f(amountIn, 2)} USDT -> about ${f(checked.expectedOut, 6)} TSLAB, at least ${f(checked.minOut, 6)} (${SLIPPAGE_BPS / 100}% slippage), Binance Trading API via ${checked.vendor}`,
    usdt: amountIn,
    mev: true,
    gasHint: 325_000n,
  });
  return { route: `Binance Trading API (${checked.vendor})`, steps, expectedOut: checked.expectedOut, minOut: checked.minOut };
}

/** An exact-input swap through one PancakeSwap v3 pool from the config. */
async function pancakeSwap(
  ctx: Ctx,
  p: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; slippageBps: number; label: string; inName: string; outName: string; outDigits: number; pool: string; gasHint: bigint },
): Promise<{ steps: Step[]; expectedOut: bigint; floor: bigint }> {
  const router = ctx.d.external.pancakeV3Router;
  const quoted = await ctx.client.simulateContract({
    address: getAddress(bscConfig.pancake.quoterV2),
    abi: pancakeQuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
  });
  const expectedOut = quoted.result[0];
  const floor = minOut(expectedOut, p.slippageBps);
  // The chain's clock, not this machine's: a rehearsal fork may have been warped.
  const deadline = (await ctx.client.getBlock({ blockTag: "latest" })).timestamp + 1200n;
  const tx: TxRequest = {
    to: router,
    data: encodeFunctionData({
      abi: pancakeRouterAbi,
      functionName: "exactInputSingle",
      args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: ctx.owner, deadline, amountIn: p.amountIn, amountOutMinimum: floor, sqrtPriceLimitX96: 0n }],
    }),
    value: 0n,
  };
  const steps: Step[] = [];
  if ((await allowance(ctx.client, p.tokenIn, ctx.owner, router)) < p.amountIn) {
    steps.push({ label: `approve ${p.inName} to PancakeSwap v3`, tx: approveTx(p.tokenIn, router, p.amountIn), note: `exactly ${f(p.amountIn, 2)} ${p.inName} to the v3 router ${router}`, gasHint: 46_200n });
  }
  steps.push({
    label: p.label,
    tx,
    note: `${f(p.amountIn, 2)} ${p.inName} -> about ${f(expectedOut, p.outDigits)} ${p.outName}, at least ${f(floor, p.outDigits)} (${p.slippageBps / 100}% slippage), PancakeSwap v3 ${p.pool}`,
    usdt: p.amountIn,
    gasHint: p.gasHint,
  });
  return { steps, expectedOut, floor };
}

async function buyViaPancake(ctx: Ctx, usdt: Address, tslab: Address, amountIn: bigint): Promise<Buy> {
  // config: pancake.pools.TSLAB_USDT_2500
  const swap = await pancakeSwap(ctx, { tokenIn: usdt, tokenOut: tslab, fee: 2500, amountIn, slippageBps: SLIPPAGE_BPS, label: "buy TSLAB", inName: "USDT", outName: "TSLAB", outDigits: 6, pool: "TSLAB/USDT 0.25% pool", gasHint: 200_000n });
  return { route: "PancakeSwap v3 TSLAB/USDT 0.25% pool (fallback)", steps: swap.steps, expectedOut: swap.expectedOut, minOut: swap.floor };
}

// ------------------------------------------------------------- open-venus

function printPlan(ctx: Ctx, v: Venus, collateral: bigint, ltvBps: number, gap: { window: string; gapBps: number; startsAt: number }) {
  const plan = planVenusOpen({ collateralTokens: Number(formatUnits(collateral, 18)), collateralPriceUsd: v.collateralPriceUsd, loanPriceUsd: v.loanPriceUsd, collateralFactor: v.collateralFactor, liquidationThreshold: v.liquidationThreshold, ltvBps, gapBps: gap.gapBps, targetHfAfterGap: ctx.targetHf });
  log("\nplanned position");
  log(`  collateral   ${f(collateral, 6)} TSLAB = $${plan.collateralValueUsd.toFixed(2)} at the Venus oracle price $${v.collateralPriceUsd.toFixed(2)}`);
  log(`  Venus        collateral factor ${(v.collateralFactor * 100).toFixed(0)}% (borrow limit), liquidation threshold ${(v.liquidationThreshold * 100).toFixed(0)}%`);
  log(`  borrow       ${plan.borrowTokens.toFixed(2)} USDT, kept in the account as the cushion -> LTV ${(plan.ltvBps / 100).toFixed(2)}%, health ${plan.hfNow.toFixed(3)} (1 = liquidation)`);
  log(`  mandate      maxLtv ${MANDATE.maxLtvBps} bps, shieldLtv ${MANDATE.shieldLtvBps} bps, maxSlippage ${MANDATE.maxSlippageBps} bps, autoRestore ${MANDATE.autoRestore}`);
  log(`  next closure ${gap.window} from ${new Date(gap.startsAt * 1000).toISOString()}, gap ${gap.gapBps} bps -> health after the gap ${plan.hfAfterGap.toFixed(3)}`);
  if (plan.shield.kind === "repay") {
    log(`  keeper       WILL shield in the hour before the close (target health ${ctx.targetHf}): shieldRepay about ${plan.shield.repayUsd.toFixed(2)} USDT from the cushion,`);
    log(`               then restore about ${plan.restoreUsd.toFixed(2)} USDT after the next open plus the restore delay`);
  } else {
    log(`  keeper       will NOT shield before this closure (${plan.shield.reason}).`);
    log(`               It shields only above LTV ${(plan.shieldAboveLtvBps / 100).toFixed(2)}% for this gap at its target health ${ctx.targetHf}; Venus lends at most ${(v.collateralFactor * 100).toFixed(0)}%.`);
  }
  return plan;
}

async function openVenus(ctx: Ctx) {
  const { client, d, owner } = ctx;
  const usdt = d.external.tokens.USDT as Address;
  const tslab = getAddress(tickerBySymbol(SYMBOL).bStock);
  const amountIn = amountOption(ctx.cli.options, "usdt", "5.6");
  const ltvBps = intOption(ctx.cli.options, "ltv-bps", 5350, 100, 9000);
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
    printPlan(ctx, v, buy.expectedOut, ltvBps, gap);
    planned = true;
    let bought = true;
    for (const s of buy.steps) bought = (await run(ctx, s)) !== null && bought;
    if (bought) {
      const got = (await balanceOf(client, tslab, owner)) - walletTslab;
      log(`  received ${f(got, 6)} TSLAB (floor ${f(buy.minOut, 6)})`);
      if (got < buy.minOut) throw new Error("received less TSLAB than the floor: stop and look");
      toDeposit = await balanceOf(client, tslab, owner);
    } else toDeposit = buy.expectedOut;
  }
  if (!planned && (collateral > 0n || toDeposit > 0n)) printPlan(ctx, v, collateral > 0n ? collateral : toDeposit, ltvBps, gap);

  // 2. The Ballast account, kept by the desk.
  if (account) log(`\nskip the account: ${account.address} exists (keeper ${account.keeper})`);
  else {
    const made = await run(ctx, {
      label: "create the Ballast Venus account",
      tx: writes.createVenusAccount(d, { vCollateral: v.vCollateral, vDebt: v.vDebt, symbol: SYMBOL, keeper: ctx.keeper, mandate: MANDATE }),
      note: `vTSLAB collateral, vUSDT debt, keeper = the desk ${ctx.keeper}, mandate maxLtv ${MANDATE.maxLtvBps} / shieldLtv ${MANDATE.shieldLtvBps} / slippage ${MANDATE.maxSlippageBps} bps / autoRestore ${MANDATE.autoRestore}`,
      standalone: true,
      gasHint: 552_000n,
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
      await run(ctx, { label: "approve TSLAB to the account", tx: approveTx(tslab, at, toDeposit), note: `exactly ${f(toDeposit, 6)} TSLAB`, gasHint: 54_500n });
    }
    const done = await run(ctx, { label: "deposit the collateral", tx: writes.depositCollateral(at, toDeposit), note: `${f(toDeposit, 6)} TSLAB into Venus through the account`, gasHint: 354_200n });
    if (done) collateral = (await accountState(client, d, at)).collateral;
    else collateral = toDeposit;
  }

  // 4. Borrow; the loan stays in the account as its cushion.
  const state = account ? await accountState(client, d, at) : null;
  if (state && state.debt > 0n) {
    log(`\nskip the borrow: the account already owes ${f(state.debt, 4)} USDT (cushion ${f(state.cushion, 4)})`);
  } else if (collateral > 0n) {
    const plan = planVenusOpen({ collateralTokens: Number(formatUnits(collateral, 18)), collateralPriceUsd: v.collateralPriceUsd, loanPriceUsd: v.loanPriceUsd, collateralFactor: v.collateralFactor, liquidationThreshold: v.liquidationThreshold, ltvBps, gapBps: gap.gapBps, targetHfAfterGap: ctx.targetHf });
    const assets = parseUnits(plan.borrowTokens.toFixed(2), 18);
    await run(ctx, { label: "borrow into the cushion", tx: writes.borrow(at, assets, at), note: `${plan.borrowTokens.toFixed(2)} USDT from Venus, kept in the account (LTV ${(plan.ltvBps / 100).toFixed(2)}%)`, gasHint: 786_000n });
  }
  if (!ctx.ahead) await status(ctx);
  else drySummary(ctx);
}

// ----------------------------------------------------------------- status

/** The regular session in progress, or the next one. */
async function sessionTimes(ctx: Ctx, session: SessionState): Promise<{ openAt: number; closeAt: number }> {
  const cal = { address: ctx.d.calendar, abi: sessionCalendarAbi } as const;
  if (session.session === "REGULAR") {
    const [day] = await ctx.client.readContract({ ...cal, functionName: "localDay", args: [BigInt(session.at)] });
    return { openAt: Number(await ctx.client.readContract({ ...cal, functionName: "regularOpenAt", args: [day] })), closeAt: session.nextClose };
  }
  return { openAt: session.nextOpen, closeAt: Number(await ctx.client.readContract({ ...cal, functionName: "nextClose", args: [BigInt(session.nextOpen)] })) };
}

/** When the owner's restore can go through, and when the keeper shields. */
async function printRiskWindow(ctx: Ctx, session: SessionState, params: { restoreDelay: number; horizon: number }) {
  const t = await sessionTimes(ctx, session);
  const w = addRiskWindow({ openAt: t.openAt, closeAt: t.closeAt, restoreDelay: params.restoreDelay, horizon: params.horizon });
  log(`  add risk     ${session.session === "REGULAR" ? "this" : "the next"} regular session is ${utc(t.openAt)} to ${utc(t.closeAt)}: ${w ? `restore allowed from ${utc(w.from)} until ${utc(w.until)}` : "restore is never allowed in it"}`);
  log(`               (restore delay ${params.restoreDelay} s after the open, horizon ${params.horizon} s before the close); the keeper shields from ${utc(t.closeAt - 3600)}`);
}

async function status(ctx: Ctx) {
  const { client, d } = ctx;
  const [session, snap, v] = await Promise.all([sessionState(client, d), oracleSnapshot(client, d, SYMBOL), venusMarket(ctx)]);
  log(`\nstatus at ${utc(session.at)} (block ${session.blockNumber})`);
  log(`  session      ${session.session}; next close ${utc(session.nextClose)}, next open ${utc(session.nextOpen)}`);
  log(`  oracle ${SYMBOL}  canAddRisk ${snap.canAddRisk} (${snap.reason}: ${snap.reasonText}); overlay ${snap.overlay.fresh ? "fresh" : "STALE"} until ${utc(snap.overlay.validUntil)}`);
  log(`               window ahead ${snap.windowAhead.window} from ${utc(snap.windowAhead.startsAt)}, gap ${snap.windowAhead.gapBps} bps; per-share $${snap.perShare === null ? "n/a" : f(snap.perShare, 2, 8)}`);
  await printRiskWindow(ctx, session, snap.params);
  const account = await findAccount(ctx);
  if (!account) log(`  account      none: ${ctx.owner} has no ${SYMBOL} Venus account kept by the desk yet`);
  else {
    const value = Number(formatUnits(account.collateral, 18)) * v.collateralPriceUsd;
    const debtUsd = Number(formatUnits(account.debt, 18)) * v.loanPriceUsd;
    log(`  account      ${account.address} (owner ${account.owner}, keeper ${account.keeper})`);
    log(`               collateral ${f(account.collateral, 6)} TSLAB = $${value.toFixed(2)}; debt ${f(account.debt, 4)} USDT; cushion ${f(account.cushion, 4)} USDT`);
    log(`               LTV ${account.ltvBps === null ? "n/a" : `${(account.ltvBps / 100).toFixed(2)}%`}; health ${debtUsd > 0 ? ((value * v.liquidationThreshold) / debtUsd).toFixed(3) : "no debt"}; healthy ${account.healthy}; liquidated ${account.liquidated}`);
    log(`               mandate maxLtv ${account.mandate.maxLtvBps}, shieldLtv ${account.mandate.shieldLtvBps}, slippage ${account.mandate.maxSlippageBps}, autoRestore ${account.mandate.autoRestore}`);
    const plan = planForAccount(account, snap, { targetHfAfterGap: ctx.targetHf });
    const steps = plan.steps.map((s) => `${s.fn}(${"assets" in s ? f(s.assets, 4) : ""})`).join(", ");
    log(`  plan now     ${plan.kind}${"reason" in plan ? `: ${plan.reason}` : ""}${steps ? ` -> ${steps}` : ""} (gap ${plan.gapBps} bps, target health ${plan.targetHfAfterGap})`);
    log(`               the keeper shields above LTV ${(((v.liquidationThreshold * (1 - plan.gapBps / 10_000)) / plan.targetHfAfterGap) * 100).toFixed(2)}% for this gap; Venus lends up to ${(v.collateralFactor * 100).toFixed(0)}%`);
  }
  const jobId = lastJobId(readProofs(ctx.proofFile), ctx.chainId);
  if (jobId !== null) {
    const [job] = await readGuardianJobs(client, d, [jobId]);
    if (!job) log(`  guardian job ${jobId}: not a Ballast guardian job`);
    else {
      log(`  guardian job ${job.jobId}: ${job.status}, budget ${f(job.budget, 4)}, expires ${utc(job.expiredAt)}${job.submittedAt ? `, submitted ${utc(job.submittedAt)}` : ""}`);
      log(`               ${job.terms ? `window ${utc(job.terms.start)} to ${utc(job.terms.end)} over ${job.terms.account}, settled ${job.terms.settled}` : "terms not bound yet (not funded)"}`);
    }
  }
  if ("error" in ctx.desk) log(`  desk         ${ctx.deskUrl}/health unreachable: ${ctx.desk.error}`);
  else {
    const h = ctx.desk.body;
    const loops = (h.loops ?? []).map((l) => `${l.name}${l.lastError ? ` FAILING (${l.lastError.slice(0, 60)})` : " ok"}`).join(", ");
    log(`  desk         ${ctx.deskUrl}/health -> HTTP ${ctx.desk.status}, ok ${h.ok}, dryRun ${h.dryRun}, agent ${h.agent}${h.agent && !same(h.agent, ctx.keeper) ? " (NOT the on-chain publisher!)" : ""}`);
    log(`               target health after the gap ${h.targetHfAfterGap ?? "not reported"}; sender ${h.sender?.halted ? `HALTED (${h.sender.halted.reason})` : "not halted"}, sales ${h.sender?.sales ?? "?"}; loops: ${loops}`);
  }
}

// ---------------------------------------------------------------- restore

function onRecord(ctx: Ctx, label: string): string | null {
  if (ctx.cli.again) return null;
  const prior = readProofs(ctx.proofFile).filter((p) => p.chainId === ctx.chainId && p.label === label).pop();
  return prior ? prior.txHash : null;
}

async function theAccount(ctx: Ctx): Promise<AccountState> {
  const account = await findAccount(ctx);
  if (!account) throw new Error(`${ctx.owner} has no ${SYMBOL} Venus account kept by the desk: run open-venus first`);
  return account;
}

/** The owner borrows a little back into the cushion while the Session Oracle allows added risk. */
async function restoreOpen(ctx: Ctx) {
  const { client, d } = ctx;
  const amount = amountOption(ctx.cli.options, "amount", "0.05");
  const done = onRecord(ctx, RESTORE_LABEL);
  if (done) return log(`\nskip: a restore is already on record (${done}); add --again to send another`);
  const account = await theAccount(ctx);
  const [session, snap, v] = await Promise.all([sessionState(client, d), oracleSnapshot(client, d, SYMBOL), venusMarket(ctx)]);
  const value = Number(formatUnits(account.collateral, 18)) * v.collateralPriceUsd;
  const debtUsd = Number(formatUnits(account.debt, 18)) * v.loanPriceUsd;
  log(`\nrestore: the owner calls restore(${f(amount, 4)} USDT) on ${account.address}`);
  log(`  oracle       session ${snap.session}; canAddRisk ${snap.canAddRisk} (${snap.reason}: ${snap.reasonText})`);
  await printRiskWindow(ctx, session, snap.params);
  log(`  now          debt ${f(account.debt, 4)} USDT, cushion ${f(account.cushion, 4)} USDT, LTV ${account.ltvBps === null ? "n/a" : `${(account.ltvBps / 100).toFixed(2)}%`}`);
  const { ltvAfterBps } = checkRestore({
    canAddRisk: snap.canAddRisk,
    reason: snap.reason,
    debtUsd,
    addUsd: Number(formatUnits(amount, 18)) * v.loanPriceUsd,
    collateralValueUsd: value,
    maxLtvBps: account.mandate.maxLtvBps,
    venueLimitBps: Math.round(v.collateralFactor * 10_000),
  });
  log(`  after        debt ${f(account.debt + amount, 4)} USDT, cushion ${f(account.cushion + amount, 4)} USDT, LTV about ${(ltvAfterBps / 100).toFixed(2)}% (mandate cap ${account.mandate.maxLtvBps} bps, Venus limit ${Math.round(v.collateralFactor * 10_000)} bps)`);
  log("  expected     the transaction is mined and the account emits Restored(assets, ltvBps); no USDT leaves the wallet");
  const receipt = await run(ctx, {
    label: RESTORE_LABEL,
    tx: writes.restore(account.address, amount),
    note: `restore(${f(amount, 4)} USDT): borrowed back into the cushion while the Session Oracle allows added risk (${snap.reason})`,
  });
  if (!receipt) return drySummary(ctx);
  const ev = parseEventLogs({ abi: ballastAccountBaseAbi, eventName: "Restored", logs: receipt.logs }).find((l) => same(l.address, account.address));
  if (!ev) throw new Error("mined, but the account emitted no Restored event");
  log(`  Restored(assets ${f(ev.args.assets, 4)} USDT, ltv ${ev.args.ltvBps} bps)`);
  await status(ctx);
}

/** The same call while the market is closed: it is mined, and reverts with the oracle's reason. */
async function refusedRestore(ctx: Ctx) {
  const { client, d } = ctx;
  const amount = amountOption(ctx.cli.options, "amount", "0.05");
  const expected = (ctx.cli.options.expect ?? "NOT_REGULAR").toUpperCase();
  const gasLimit = BigInt(intOption(ctx.cli.options, "gas-limit", 300_000, 100_000, 1_000_000));
  const done = onRecord(ctx, REFUSED_LABEL);
  if (done) return log(`\nskip: a refused restore is already on record (${done}); add --again to send another`);
  const account = await theAccount(ctx);
  const snap = await oracleSnapshot(client, d, SYMBOL);
  log(`\nrefused restore: the owner calls restore(${f(amount, 4)} USDT) on ${account.address} while the oracle refuses added risk`);
  log(`  oracle       session ${snap.session}; canAddRisk ${snap.canAddRisk} (${snap.reason}: ${snap.reasonText})`);
  log(`  now          debt ${f(account.debt, 4)} USDT, cushion ${f(account.cushion, 4)} USDT`);
  log(`  expected     the transaction is mined and REVERTS with RestoreRefused(${expected}); nothing is borrowed, only gas is spent`);
  const receipt = await run(ctx, {
    label: REFUSED_LABEL,
    tx: writes.restore(account.address, amount),
    note: `restore(${f(amount, 4)} USDT) sent while the Session Oracle refuses added risk`,
    expectRefusal: expected,
    gasLimit,
  });
  if (!receipt) return drySummary(ctx);
  const after = await accountState(client, d, account.address);
  log(`  after        debt ${f(after.debt, 4)} USDT, cushion ${f(after.cushion, 4)} USDT${after.cushion === account.cushion ? " (the cushion is unchanged: nothing was borrowed)" : ""}`);
}

// ----------------------------------------------------------- guardian-job

/** The owner hires the desk as guardian of the account for a window: an ERC-8183 job the guardian contract settles. */
async function guardianJob(ctx: Ctx) {
  const { client, d, owner } = ctx;
  const usdt = d.external.tokens.USDT as Address;
  const tokenName = (ctx.cli.options.token ?? "USD1").toUpperCase();
  if (tokenName !== "USD1" && tokenName !== "U") throw new Error("--token must be USD1 or U");
  const token = d.external.tokens[tokenName] as Address;
  const account = await theAccount(ctx);
  if (account.debt === 0n) throw new Error("the account has no debt: the guardian binds only a live loan");
  if (account.liquidated) throw new Error("the account is liquidated");
  const guardian = { address: d.guardian, abi: ballastGuardianAbi } as const;
  const [minBudget, minGrace, block, held] = await Promise.all([
    client.readContract({ ...guardian, functionName: "minBudget" }),
    client.readContract({ ...guardian, functionName: "minGrace" }),
    client.getBlock({ blockTag: "latest" }),
    balanceOf(client, token, owner),
  ]);
  const now = Number(block.timestamp);
  const budget = ctx.cli.options.budget === undefined ? minBudget : amountOption(ctx.cli.options, "budget", "0");
  if (budget < minBudget) throw new Error(`--budget is below the guardian's minimum, ${f(minBudget, 4)} ${tokenName}`);

  // The guardian pays only an ERC-8004 agent: the provider must own the identity or be its wallet.
  const rawId = ctx.cli.options["agent-id"] ?? process.env.AGENT_ID ?? DESK_AGENT_ID;
  if (!/^\d+$/.test(rawId)) throw new Error("--agent-id must be a whole number");
  const agentId = BigInt(rawId);
  const identity = { address: d.external.identityRegistry, abi: identityRegistryAbi } as const;
  const agentOwner = await client.readContract({ ...identity, functionName: "ownerOf", args: [agentId] });
  let wallet: Address | null = null;
  try {
    wallet = await client.readContract({ ...identity, functionName: "getAgentWallet", args: [agentId] });
  } catch {
    // no wallet set
  }
  if (!same(agentOwner, ctx.keeper) && !(wallet && same(wallet, ctx.keeper))) throw new Error(`ERC-8004 agent ${agentId} is not the desk ${ctx.keeper} (its owner is ${agentOwner})`);
  if (same(owner, ctx.keeper) || same(owner, agentOwner)) throw new Error("the client cannot be the agent itself");

  // An earlier run may have created, or created and funded, the job.
  let job = null as Awaited<ReturnType<typeof readGuardianJobs>>[number] | null;
  const recorded = lastJobId(readProofs(ctx.proofFile), ctx.chainId);
  if (recorded !== null) job = (await readGuardianJobs(client, d, [recorded]))[0] ?? null;
  if (job && (!same(job.client, owner) || !same(job.provider, ctx.keeper))) job = null;
  if (job && job.status !== "Open" && !ctx.cli.again) {
    log(`\nskip: guardian job ${job.jobId} is already ${job.status} (budget ${f(job.budget, 4)}, expires ${utc(job.expiredAt)}); add --again for a new job`);
    if (job.terms) log(`      window ${utc(job.terms.start)} to ${utc(job.terms.end)} over ${job.terms.account}, settled ${job.terms.settled}`);
    return;
  }
  if (job && job.status !== "Open") job = null;

  const start = parseWhen(ctx.cli.options.start ?? "+5", now);
  const end = parseWhen(ctx.cli.options.end ?? "+65", now);
  const reopen = Number(await client.readContract({ address: d.calendar, abi: sessionCalendarAbi, functionName: "nextOpen", args: [BigInt(end)] }));
  const w = guardWindow({ now, start, end, reopen, minGrace: Number(minGrace) });
  if (job && job.expiredAt < reopen + Number(minGrace)) {
    log(`\njob ${job.jobId} from an earlier run expires too early for this window: creating a new one`);
    job = null;
  }
  const expiredAt = job ? job.expiredAt : w.expiredAt;
  log(`\nguardian job over ${account.address} (debt ${f(account.debt, 4)} USDT)`);
  log(`  provider     the desk ${ctx.keeper}, ERC-8004 agent ${agentId}; evaluator and hook: BallastGuardian ${d.guardian}`);
  log(`  window       ${utc(w.start)} to ${utc(w.end)} (${Math.round((w.end - w.start) / 60)} min; the contract asks for at least 60)`);
  log(`  expiry       ${utc(expiredAt)} (next regular open after the window ${utc(reopen)} + grace ${minGrace} s + 1 h)`);
  log(`  budget       ${f(budget, 4)} ${tokenName} (guardian minimum ${f(minBudget, 4)}); paid to the desk if the loan is healthy when the job is settled after the window, refunded otherwise`);
  log(`  wallet       ${f(held, 4)} ${tokenName}`);

  // 1. The budget token.
  if (held < budget) {
    if (tokenName !== "USD1") throw new Error("the config has a USDT pool for USD1 only: fund the wallet with U, or use --token USD1");
    const swapIn = amountOption(ctx.cli.options, "swap-usdt", "0.1");
    // config: pancake.pools.USDT_USD1_100
    const swap = await pancakeSwap(ctx, { tokenIn: usdt, tokenOut: token, fee: 100, amountIn: swapIn, slippageBps: 50, label: "swap USDT to USD1", inName: "USDT", outName: "USD1", outDigits: 4, pool: "USDT/USD1 0.01% pool", gasHint: 170_000n });
    if (held + swap.floor < budget) throw new Error(`${f(swapIn, 2)} USDT buys at least ${f(swap.floor, 4)} USD1: not enough for the budget, raise --swap-usdt`);
    for (const s of swap.steps) await run(ctx, s);
  } else log(`\nskip the swap: the wallet already holds the budget`);

  // 2. The job on the ERC-8183 kernel.
  let jobId = job?.jobId ?? 0n;
  if (job) log(`\nskip the creation: job ${job.jobId} exists and is not funded yet`);
  else {
    const created = await run(ctx, {
      label: "create the guardian job",
      tx: writes.createJobWithToken(d, { provider: ctx.keeper, expiredAt, description: `guard my ${SYMBOL} loan ${utc(w.start)} to ${utc(w.end)}`, token }),
      note: `ERC-8183 kernel ${d.external.kernel}: provider = the desk, evaluator = hook = BallastGuardian, paid in ${tokenName}, expires ${utc(expiredAt)}`,
      standalone: true,
      gasHint: 282_000n,
      jobId: jobIdOf,
    });
    if (created) {
      jobId = jobIdOf(created);
      log(`  job id ${jobId}`);
    }
  }
  const pending = jobId === 0n ? " (the id comes from the step above)" : "";

  // 3. Budget, allowance, funding. The guardian binds the terms when the job is funded.
  if (!job || job.budget !== budget) await run(ctx, { label: "set the job budget", tx: writes.setBudget(d, jobId, budget), note: `job ${jobId === 0n ? "<new>" : jobId}: ${f(budget, 4)} ${tokenName}${pending}`, gasHint: 88_500n, jobId });
  if ((await allowance(client, token, owner, d.external.kernel)) < budget) {
    await run(ctx, { label: "approve the budget to the kernel", tx: approveTx(token, d.external.kernel, budget), note: `exactly ${f(budget, 4)} ${tokenName} to the ERC-8183 kernel ${d.external.kernel}`, standalone: true, gasHint: 60_600n });
  }
  const funded = await run(ctx, {
    label: "fund the guardian job",
    tx: writes.fund(d, { jobId, expectedBudget: budget, terms: { account: account.address, start: w.start, end: w.end, agentId } }),
    note: `job ${jobId === 0n ? "<new>" : jobId}: ${f(budget, 4)} ${tokenName} into escrow with the terms (account ${account.address}, ${utc(w.start)} to ${utc(w.end)}, agent ${agentId})${pending}`,
    gasHint: 327_500n,
    jobId,
  });
  if (!funded) return drySummary(ctx);
  const [after] = await readGuardianJobs(client, d, [jobId]);
  if (!after?.terms) throw new Error(`job ${jobId} is funded but the guardian bound no terms`);
  log(`  job ${jobId}: ${after.status}; the guardian bound ${utc(after.terms.start)} to ${utc(after.terms.end)} over ${after.terms.account}`);
  await status(ctx);
}

function jobIdOf(receipt: TransactionReceipt): bigint {
  const ev = parseEventLogs({ abi: kernelAbi, eventName: "JobCreated", logs: receipt.logs })[0];
  if (!ev) throw new Error("no JobCreated event in the receipt");
  return ev.args.jobId;
}

// ------------------------------------------------------------------- main

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  status,
  "open-venus": openVenus,
  restore: restoreOpen,
  "refused-restore": refusedRestore,
  "guardian-job": guardianJob,
};

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const command = COMMANDS[cli.command];
  if (!command) throw new Error(`unknown subcommand ${cli.command}: ${Object.keys(COMMANDS).join(" | ")}`);
  return command(await context(cli));
}

// The exit code is set and the process is left to end by itself: process.exit() right after a failed request
// trips a libuv assertion on Windows. The timer only cuts short a connection that is kept alive.
function finish(code: number) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2500).unref();
}

main().then(
  () => finish(0),
  (err) => {
    console.error(`
STOPPED: ${err instanceof Error ? err.message : String(err)}`);
    finish(1);
  },
);
