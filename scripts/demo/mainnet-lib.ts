// Pure parts of the mainnet demo CLI (scripts/demo/mainnet.ts): argument parsing, the spend and gas caps,
// the proof file, the checks on what the Binance Trading API hands back, and the sizing of the Venus loan.
// Nothing here talks to a chain or an API, so all of it is unit-tested.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planShield, type ShieldPlan } from "@ballast/risk";
import { decodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, isHex, pad, parseEther, parseUnits, toHex, type Address, type Hex } from "viem";

// ------------------------------------------------------------------- args

export interface Cli {
  command: string;
  /** Broadcast. Without it every step is simulated and printed only. */
  send: boolean;
  /** A local anvil fork to run against instead of BSC mainnet. */
  forkRpc: string | null;
  /** Required with --send on real BSC mainnet. */
  confirmMainnet: boolean;
  options: Record<string, string>;
}

const BOOLEAN_FLAGS = new Set(["send", "confirm-mainnet"]);

export function parseArgs(argv: readonly string[]): Cli {
  const [command, ...rest] = argv;
  if (!command || command.startsWith("-")) throw new Error("missing subcommand");
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    options[name] = value;
    i++;
  }
  const forkRpc = options["fork-rpc"] ?? null;
  delete options["fork-rpc"];
  return { command, send: flags.has("send"), forkRpc, confirmMainnet: flags.has("confirm-mainnet"), options };
}

/** A decimal option as token units; throws on anything that is not a plain positive decimal. */
export function amountOption(options: Record<string, string>, name: string, fallback: string, decimals = 18): bigint {
  const raw = options[name] ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`--${name} must be a decimal amount`);
  const v = parseUnits(raw, decimals);
  if (v <= 0n) throw new Error(`--${name} must be above 0`);
  return v;
}

export function intOption(options: Record<string, string>, name: string, fallback: number, min: number, max: number): number {
  const raw = options[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return n;
}

// ------------------------------------------------------------------- caps

/** The most USDT the demo may move out of the owner wallet, over all runs recorded in the proof file. */
export const MAX_USDT_SPEND = parseUnits("6", 18);
/** The most gas (limit x price) the demo may sign for, over all runs recorded in the proof file. */
export const MAX_GAS_WEI = parseEther("0.001");
/** Never sign above this gas price: BSC gas is a small fraction of a gwei. */
export const MAX_GAS_PRICE_WEI = parseUnits("1", 9);

/** Running totals against the hard caps. Each add throws before the cap is crossed. */
export class SpendGuard {
  usdt: bigint;
  gasWei: bigint;

  constructor(prior: { usdt?: bigint; gasWei?: bigint } = {}) {
    this.usdt = prior.usdt ?? 0n;
    this.gasWei = prior.gasWei ?? 0n;
  }

  addUsdt(amount: bigint): void {
    if (amount < 0n) throw new Error("negative spend");
    if (this.usdt + amount > MAX_USDT_SPEND) {
      throw new Error(`USDT cap: ${formatUnits(this.usdt, 18)} already spent, ${formatUnits(amount, 18)} more would exceed ${formatUnits(MAX_USDT_SPEND, 18)}`);
    }
    this.usdt += amount;
  }

  addGas(gasLimit: bigint, gasPrice: bigint): void {
    if (gasPrice > MAX_GAS_PRICE_WEI) throw new Error(`gas price ${formatUnits(gasPrice, 9)} gwei is above the ${formatUnits(MAX_GAS_PRICE_WEI, 9)} gwei cap`);
    const fee = gasLimit * gasPrice;
    if (this.gasWei + fee > MAX_GAS_WEI) {
      throw new Error(`gas cap: ${formatEther(this.gasWei)} BNB already signed for, ${formatEther(fee)} more would exceed ${formatEther(MAX_GAS_WEI)} BNB`);
    }
    this.gasWei += fee;
  }
}

// ------------------------------------------------------------------ proofs

export interface ProofTx {
  label: string;
  txHash: Hex;
  /** ISO time the receipt was seen. */
  at: string;
  note: string;
  chainId: number;
  /** USDT that left the owner wallet in this transaction (wei), for the spend cap. */
  usdtSpent?: string;
  /** gas limit x gas price signed for (wei), for the gas cap. */
  feeWei?: string;
}

export const bscScanTx = (hash: string) => `https://bscscan.com/tx/${hash}`;

export function readProofs(file: string): ProofTx[] {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(j)) throw new Error(`${file} is not a list of transactions`);
  return j as ProofTx[];
}

/** Appends one sent transaction; the file is rewritten through a temp file. */
export function appendProof(file: string, entry: ProofTx): void {
  const all = [...readProofs(file), entry];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  renameSync(`${file}.tmp`, file);
}

/** What earlier runs on this chain already used of the caps. */
export function priorSpend(proofs: readonly ProofTx[], chainId: number): { usdt: bigint; gasWei: bigint } {
  let usdt = 0n;
  let gasWei = 0n;
  for (const p of proofs) {
    if (p.chainId !== chainId) continue;
    usdt += BigInt(p.usdtSpent ?? "0");
    gasWei += BigInt(p.feeWei ?? "0");
  }
  return { usdt, gasWei };
}

// ----------------------------------------------------------- Binance swap

/** amountOut less the slippage allowance (default 1.5%). */
export function minOut(amountOut: bigint, slippageBps = 150): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) throw new RangeError("slippageBps out of range");
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface CheckedSwap {
  vendor: string;
  spender: Address;
  approve: { to: Address; data: Hex; value: 0n };
  swap: { to: Address; data: Hex; value: 0n };
  expectedOut: bigint;
  minOut: bigint;
}

type Json = Record<string, unknown>;
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`Binance swap check: ${what} is missing`);
  return v;
};
const addr = (v: unknown, what: string): Address => {
  const s = text(v, what);
  if (!isAddress(s, { strict: false })) throw new Error(`Binance swap check: ${what} is not an address`);
  return getAddress(s);
};

/**
 * Cross-checks what the Binance Trading API returned for a token-to-token buy before anything is signed:
 * the quote, the approval and the swap must be for these tokens, this amount and this wallet; the only
 * spender is the quote's approveTarget, approved for exactly the amount; the swap goes to that same
 * contract with no BNB attached; and the minimum received is no lower than our own slippage floor.
 * Throws on the first thing that does not match.
 */
export function checkBinanceSwap(i: { owner: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; slippageBps: number; quote: unknown; approve: unknown; swap: unknown }): CheckedSwap {
  const q = (i.quote ?? {}) as Json;
  if (q.executionMode !== "SWAP") throw new Error(`Binance swap check: execution mode ${String(q.executionMode)} is not a plain swap`);
  if (text(q.fromTokenAmount, "quote.fromTokenAmount") !== i.amountIn.toString()) throw new Error("Binance swap check: the quote is for another amount");
  for (const [side, want] of [["fromToken", i.tokenIn], ["toToken", i.tokenOut]] as const) {
    const t = (q[side] ?? {}) as Json;
    if (addr(t.tokenContractAddress, `quote.${side}`) !== getAddress(want)) throw new Error(`Binance swap check: quote.${side} is another token`);
    if (t.isHoneyPot !== false || String(t.taxRate ?? "0") !== "0") throw new Error(`Binance swap check: quote.${side} is flagged (honeypot or transfer tax)`);
  }
  const spender = addr(q.approveTarget, "quote.approveTarget");
  const expectedOut = BigInt(text(q.toTokenAmount, "quote.toTokenAmount"));
  if (expectedOut <= 0n) throw new Error("Binance swap check: the quote returns nothing");

  const approvals = Array.isArray(i.approve) ? (i.approve as Json[]) : [];
  if (approvals.length !== 1) throw new Error(`Binance swap check: expected one approval, got ${approvals.length}`);
  const ap = approvals[0] as Json;
  if (addr(ap.dexContractAddress, "approve.dexContractAddress") !== spender) throw new Error("Binance swap check: the approval names a spender other than the quote's approveTarget");
  const apData = text(ap.data, "approve.data");
  if (!isHex(apData)) throw new Error("Binance swap check: approve.data is not hex");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: apData });
  } catch {
    throw new Error("Binance swap check: approve.data is not an ERC-20 call");
  }
  if (decoded.functionName !== "approve") throw new Error(`Binance swap check: approve.data calls ${decoded.functionName}`);
  const [apSpender, apAmount] = decoded.args as readonly [Address, bigint];
  if (getAddress(apSpender) !== spender) throw new Error("Binance swap check: approve.data approves another spender");
  if (apAmount !== i.amountIn) throw new Error("Binance swap check: approve.data approves another amount (only the exact amount is accepted)");

  const s = (i.swap ?? {}) as Json;
  if (s.executionMode !== "SWAP") throw new Error("Binance swap check: the swap is not a plain swap");
  const tx = (s.tx ?? {}) as Json;
  if (addr(tx.from, "swap.tx.from") !== getAddress(i.owner)) throw new Error("Binance swap check: the swap is built for another wallet");
  if (addr(tx.to, "swap.tx.to") !== spender) throw new Error("Binance swap check: the swap goes to a contract other than the quote's approveTarget");
  if (BigInt(String(tx.value ?? "0")) !== 0n) throw new Error("Binance swap check: the swap attaches BNB");
  const data = text(tx.data, "swap.tx.data");
  if (!isHex(data) || data.length < 10) throw new Error("Binance swap check: swap.tx.data is not calldata");
  const floor = minOut(expectedOut, i.slippageBps);
  const theirs = BigInt(text(tx.minReceiveAmount, "swap.tx.minReceiveAmount"));
  if (theirs + 1n < floor) throw new Error(`Binance swap check: the swap accepts ${theirs} out, below our floor of ${floor}`);
  // The floor has to be in the calldata itself, or the number above is only a label.
  if (!data.toLowerCase().includes(pad(toHex(theirs), { size: 32 }).slice(2).toLowerCase())) {
    throw new Error("Binance swap check: the minimum received is not found in the swap calldata");
  }
  return {
    vendor: String(q.vendorName ?? "?"),
    spender,
    approve: { to: getAddress(i.tokenIn), data: apData, value: 0n },
    swap: { to: spender, data, value: 0n },
    expectedOut,
    minOut: theirs,
  };
}

// ------------------------------------------------------------------ sizing

export interface VenusOpenInput {
  /** Collateral, whole tokens. */
  collateralTokens: number;
  /** USD per collateral token and per loan token (the Venus oracle's prices). */
  collateralPriceUsd: number;
  loanPriceUsd: number;
  /** Venus collateral factor (what may be borrowed) and liquidation threshold, as fractions. */
  collateralFactor: number;
  liquidationThreshold: number;
  /** Loan to open, as LTV in bps of the collateral value. */
  ltvBps: number;
  /** Price gap of the closure ahead for this symbol, bps. */
  gapBps: number;
  /** The keeper's target health after the gap (the desk default is 1.05). */
  targetHfAfterGap: number;
}

export interface VenusOpenPlan {
  collateralValueUsd: number;
  /** Loan in loan tokens, rounded down to cents. */
  borrowTokens: number;
  borrowUsd: number;
  ltvBps: number;
  /** Liquidation threshold over LTV: 1 is liquidation. */
  hfNow: number;
  hfAfterGap: number;
  /** The keeper plans a shield only above this LTV for this gap and target. */
  shieldAboveLtvBps: number;
  /** What the keeper's planner says for this position with the whole loan as the cushion. */
  shield: ShieldPlan;
  /** What a restore would borrow back after that shield (0 when there is no shield). */
  restoreUsd: number;
}

/** Keeps the loan this far under the Venus collateral factor, so interest and a small price move do not block it. */
export const CF_HEADROOM_BPS = 100;

/**
 * Sizes the Venus loan and asks the same planner the keeper uses what it will do before the closure ahead.
 * The loan stays in the account as the cushion, so the cushion equals the loan.
 */
export function planVenusOpen(i: VenusOpenInput): VenusOpenPlan {
  const cfBps = Math.round(i.collateralFactor * 10_000);
  if (!(i.ltvBps > 0)) throw new RangeError("ltvBps must be above 0");
  if (i.ltvBps > cfBps - CF_HEADROOM_BPS) {
    throw new RangeError(`an LTV of ${i.ltvBps} bps is too close to the Venus collateral factor (${cfBps} bps): at most ${cfBps - CF_HEADROOM_BPS} bps`);
  }
  const collateralValueUsd = i.collateralTokens * i.collateralPriceUsd;
  const borrowTokens = Math.floor(((collateralValueUsd * i.ltvBps) / 10_000 / i.loanPriceUsd) * 100) / 100;
  if (!(borrowTokens > 0)) throw new RangeError("the collateral is too small to borrow a cent against");
  const borrowUsd = borrowTokens * i.loanPriceUsd;
  const ltv = borrowUsd / collateralValueUsd;
  const shield = planShield({
    position: { collateralTokens: i.collateralTokens, collateralPriceUsd: i.collateralPriceUsd, debtUsd: borrowUsd, lltv: i.liquidationThreshold, minLoanUsd: 0 },
    gapBps: i.gapBps,
    targetHfAfterGap: i.targetHfAfterGap,
    cushionUsd: borrowUsd,
    maxSlippageBps: 150,
    canSellCollateral: false,
  });
  return {
    collateralValueUsd,
    borrowTokens,
    borrowUsd,
    ltvBps: Math.round(ltv * 10_000),
    hfNow: i.liquidationThreshold / ltv,
    hfAfterGap: (i.liquidationThreshold * (1 - i.gapBps / 10_000)) / ltv,
    shieldAboveLtvBps: Math.round(((i.liquidationThreshold * (1 - i.gapBps / 10_000)) / i.targetHfAfterGap) * 10_000),
    shield,
    restoreUsd: shield.kind === "repay" ? shield.repayUsd : 0,
  };
}
