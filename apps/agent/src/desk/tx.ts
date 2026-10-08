// Simulation and broadcast for the desk key.
//
// Every write is simulated first: through the Binance Transaction API when a key is configured on BSC
// mainnet, else with eth_call on our RPC.
//
// Sending is deliberately simple. ONE transaction of the key is outstanding at a time: sends run one after
// another and no new nonce is signed while the previous one is unmined. A send waits for its receipt; when
// none comes in time the same intent is rebuilt and replaced at the same nonce for 12.5% more gas (by a
// 0-value cancel when it is no longer needed), a bounded number of times and never above the gas price cap.
// When that is not enough, or the key runs out of money, the hourly fee budget is used up or a transaction
// that is not ours sits in the way, the sender HALTS: it signs nothing more until the chain shows the way is
// clear, and says so (halted results, state()).
//
// One sender per key: nothing else may sign with the desk key while the desk runs. Collateral sales are only
// ever broadcast through the Binance MEV-protected endpoint, never to the public mempool. Raw signed
// transactions never leave this module.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeBallastError, isRevert, type TxRequest } from "@ballast/sdk";
import { transaction, type Web3Client } from "@ballast/binance";
import { formatEther, formatGwei, keccak256, parseEther, parseGwei, zeroHash, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import type { Feed, FeedError, FeedSim, FeedSource } from "./feed";

/** The subset of a viem PublicClient the sender uses. */
export type SenderClient = Pick<
  PublicClient,
  "call" | "estimateGas" | "getGasPrice" | "getTransactionCount" | "sendRawTransaction" | "getTransaction" | "getTransactionReceipt" | "getBalance"
>;

type SimulationResult = Awaited<ReturnType<typeof transaction.simulate>>;
type BroadcastResult = Awaited<ReturnType<typeof transaction.broadcast>>;

/** Binance Transaction API calls the sender needs (simulate, broadcast). */
export interface BinanceTxApi {
  simulate(body: Parameters<typeof transaction.simulate>[1]): Promise<SimulationResult>;
  broadcast(body: Parameters<typeof transaction.broadcast>[1]): Promise<BroadcastResult>;
}

export function binanceTxApi(c: Web3Client): BinanceTxApi {
  return { simulate: (b) => transaction.simulate(c, b), broadcast: (b) => transaction.broadcast(c, b) };
}

/** Binance's chain id for BSC; their simulator and broadcaster only know mainnet state. */
const BINANCE_BSC = "56";
/** Gas limit headroom over the estimate. */
const GAS_HEADROOM_PCT = 120n;
/** A first send pays this much of the network price. */
const NETWORK_PREMIUM_PCT = 110n;
/** A replacement outbids the transaction it replaces by this much (nodes require 10%). */
export const REPLACEMENT_BUMP_PERMILLE = 1125n;
/** The least a node accepts as a replacement. */
const MIN_REPLACEMENT_PERMILLE = 1100n;
const CANCEL_GAS = 21_000n;
const POLL_MS = 1_500;
const HOUR_MS = 3_600_000;
export const DEFAULT_MIN_BNB = 0.003;

/** The sender's hard limits. */
export interface SenderLimits {
  /** Never sign above this gas price, wei. */
  maxGasPriceWei: bigint;
  /** How long to wait for a receipt before replacing, ms. */
  receiptTimeoutMs: number;
  /** Replacement rounds per nonce before halting. */
  maxBumps: number;
  /** gasLimit x gasPrice of everything signed within an hour (replacements included), wei. */
  maxFeeWeiPerHour: bigint;
}

/** Sized for BSC: blocks are sub-second and gas costs a small fraction of a gwei. */
export const DEFAULT_LIMITS: SenderLimits = {
  maxGasPriceWei: parseGwei("1"),
  receiptTimeoutMs: 20_000,
  maxBumps: 4,
  maxFeeWeiPerHour: parseEther("0.003"),
};

/** Limits from the desk config (MAX_GAS_PRICE_GWEI, RECEIPT_TIMEOUT_SEC, MAX_BUMPS, MAX_FEE_BNB_PER_HOUR). */
export function senderLimits(c: { maxGasPriceGwei: number; receiptTimeoutSec: number; maxBumps: number; maxFeeBnbPerHour: number }): SenderLimits {
  return {
    maxGasPriceWei: parseGwei(c.maxGasPriceGwei.toFixed(9)),
    receiptTimeoutMs: Math.round(c.receiptTimeoutSec * 1000),
    maxBumps: c.maxBumps,
    maxFeeWeiPerHour: parseEther(c.maxFeeBnbPerHour.toFixed(18)),
  };
}

/** The sender's limits and state file from the desk config: `<dataDir>/sender.json`. */
export function senderOptions(c: { dataDir: string; maxGasPriceGwei: number; receiptTimeoutSec: number; maxBumps: number; maxFeeBnbPerHour: number }): {
  limits: SenderLimits;
  stateFile: string;
} {
  return { limits: senderLimits(c), stateFile: path.join(c.dataDir, "sender.json") };
}

// ------------------------------------------------------------------- errors

const stringify = (v: unknown): string => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * One line for logs and the feed: viem's short message plus details, request bodies dropped and long hex
 * (raw transactions, calldata) elided.
 */
export function safeMessage(err: unknown): string {
  const e = (err ?? {}) as { shortMessage?: unknown; details?: unknown; message?: unknown };
  let m: string;
  if (typeof e.shortMessage === "string") m = typeof e.details === "string" && e.details ? `${e.shortMessage} (${e.details})` : e.shortMessage;
  else if (typeof e.message === "string") m = e.message;
  else m = String(err);
  m = m.replace(/Request body:[\s\S]*?(?=\n\n|$)/g, "");
  m = m.replace(/0x[0-9a-fA-F]{200,}/g, (h) => `0x[${h.length - 2} hex chars]`);
  m = m.replace(/\s+/g, " ").trim();
  return m.length > 400 ? `${m.slice(0, 400)}...` : m;
}

/** A revert as a feed error, or null when `err` carries no revert (an RPC or network failure). */
export function revertError(err: unknown): FeedError | null {
  const d = decodeBallastError(err);
  if (d) {
    const out: FeedError = { name: d.name, message: d.message, args: d.args.map(stringify) };
    if (d.reason) out.reason = d.reason;
    return out;
  }
  if (isRevert(err)) return { name: "Reverted", message: safeMessage(err) };
  return null;
}

type Chained = { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; status?: unknown; cause?: unknown };

function chain(err: unknown): Chained[] {
  const out: Chained[] = [];
  for (let e = err as Chained | undefined, i = 0; e && typeof e === "object" && i < 10; e = e.cause as Chained | undefined, i++) out.push(e);
  return out;
}

/** viem's "not found" errors for a transaction or its receipt (any other failure is real). */
function isNotFound(err: unknown): boolean {
  return chain(err).some((e) => typeof e.name === "string" && /NotFound/.test(e.name));
}

/**
 * What a failed broadcast means. Nothing is guessed: each class has one handling.
 * - known: the node already has these bytes (sent).
 * - nonce-too-low: the nonce was mined meanwhile (resolve it from the receipts).
 * - underpriced: something at this nonce pays more than we offered (raise the price, under the cap).
 * - insufficient-funds: the key cannot pay (halt).
 * - possibly-sent: the request died on the way (timeout, network, 5xx): the node may have it.
 * - rejected: the node answered and refused it for another reason (not sent).
 */
export type BroadcastError = "known" | "nonce-too-low" | "underpriced" | "insufficient-funds" | "possibly-sent" | "rejected";

const TRANSPORT_NAMES = /^(HttpRequestError|TimeoutError|WebSocketRequestError|SocketClosedError|AbortError|FetchError)$/;
const TRANSPORT_TEXT = /fetch failed|timed out|timeout|econnreset|econnrefused|etimedout|enotfound|socket hang up|network error|bad gateway|service unavailable|gateway time/;

export function classifyBroadcastError(err: unknown): BroadcastError {
  const links = chain(err);
  const text = (links.length ? links : [{ message: String(err) }])
    .flatMap((e) => [e.message, e.shortMessage, e.details])
    .filter((s): s is string => typeof s === "string")
    .join(" | ")
    .toLowerCase();
  if (/already known|known transaction|already imported|alreadyknown/.test(text)) return "known";
  if (/nonce too low|nonce is too low|nonce has already been used|oldnonce/.test(text)) return "nonce-too-low";
  if (/underpriced|fee too low|gas price too low to replace/.test(text)) return "underpriced";
  if (/insufficient funds|insufficient balance/.test(text)) return "insufficient-funds";
  const transport = links.some((e) => (typeof e.name === "string" && TRANSPORT_NAMES.test(e.name)) || (typeof e.status === "number" && (e.status >= 500 || e.status === 429)));
  if (transport || TRANSPORT_TEXT.test(text)) return "possibly-sent";
  return "rejected";
}

// ------------------------------------------------------------------- sender

/**
 * success / reverted: mined. pending: broadcast but not mined (only when the sender halted on it, or when it
 * was found at startup). dropped: the nonce went to another transaction: our own cancel (`minedAs: "cancel"`,
 * the intent was no longer needed) or one that is not ours.
 */
export type TxStatus = "success" | "reverted" | "pending" | "dropped";

/** Which transaction of an intent a hash is: the intent itself, a sale's cushion-repay stand-in, or a cancel. */
export type TxKind = "intent" | "fallback" | "cancel";

export type HaltReason =
  /** Not mined after every allowed replacement. */
  | "STUCK"
  /** A replacement would need a gas price above the cap. */
  | "GAS_CAP"
  /** The intent could not be rebuilt in any round (reads failing). */
  | "BUILD_FAILED"
  | "INSUFFICIENT_FUNDS"
  /** The hourly fee budget is used up. */
  | "FEE_BUDGET"
  /** A pending transaction of the key that this sender did not sign sits at a lower nonce. */
  | "FOREIGN_BLOCKER";

export interface HaltInfo {
  reason: HaltReason;
  message: string;
  /** The nonce the halt is about (null when nothing was signed). */
  nonce: number | null;
  /** Unix seconds. */
  since: number;
}

/** A receipt log, enough to decode events. */
export interface TxLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export type SendResult =
  | {
      ok: true;
      /** The mined transaction, or the latest one signed while it is pending. */
      txHash: Hex;
      via: "binance" | "rpc";
      status: TxStatus;
      nonce: number;
      gasPrice: bigint;
      /** Which of the intent's transactions was mined. */
      minedAs?: TxKind;
      gasUsed?: bigint;
      effectiveGasPrice?: bigint;
      blockNumber?: bigint;
      logs?: TxLog[];
      note?: string;
      /** The sender halted with this transaction outstanding. */
      halted?: HaltInfo;
    }
  | { ok: false; stage: "estimate"; error: FeedError }
  /** The builder returned null: nothing was signed. */
  | { ok: false; stage: "aborted" }
  /** The sender is halted: nothing was signed. */
  | { ok: false; stage: "halted"; halt: HaltInfo };

/**
 * Builds the transaction inside the send queue. Round 0 is the first build (null aborts the send); rounds 1+
 * are rebuilds after a receipt timeout (null means "no longer needed": the nonce is cancelled). A throw in a
 * rebuild leaves the outstanding transaction as it is.
 */
export type TxBuilder = (ctx: { round: number }) => Promise<TxRequest | null>;

export interface SendOptions {
  /** A collateral sale: broadcast only through the Binance MEV-protected endpoint (BSC mainnet), never publicly. */
  mevProtect?: boolean;
  /**
   * A sale's stand-in (its cushion repay): sent publicly at the same nonce when the protected broadcast
   * errors or the sale is no longer valid. Null result or no fallback: a cancel.
   */
  fallback?: TxBuilder;
}

export interface SimulateOptions {
  /** Binance simulate and eth_call must both succeed: a disagreement fails the simulation (restores). */
  strict?: boolean;
}

export interface Confirmation {
  status: TxStatus;
  /** The transaction that was mined at that nonce (a replacement of the one asked about, possibly). */
  txHash?: Hex;
  minedAs?: TxKind;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  blockNumber?: bigint;
  logs?: TxLog[];
}

export interface SenderState {
  /**
   * How collateral sales leave: through the protected endpoint, publicly (off mainnet, where there is no public
   * mempool to fear), or not at all (mainnet without a Binance key: their cushion repay goes instead).
   */
  sales: "protected" | "public" | "disabled";
  halted: HaltInfo | null;
  outstanding: { nonce: number; hashes: Hex[]; gasPrice: bigint; rounds: number; kind: TxKind } | null;
  /** gasLimit x gasPrice signed within the last hour, wei. */
  spentLastHourWei: bigint;
}

/** What the loops need: simulate, send, the sender address and the DRY_RUN switch. */
export interface TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  simulate(tx: TxRequest, opts?: SimulateOptions): Promise<FeedSim>;
  /** Resolves when the transaction is mined, dropped or cancelled, or when the sender halted on it. */
  send(tx: TxRequest | TxBuilder, opts?: SendOptions): Promise<SendResult>;
  /** Status of a transaction sent earlier, or of the one mined at its nonce instead. */
  confirm?(txHash: Hex, nonce?: number): Promise<Confirmation>;
  /** BNB balance of the desk key, wei. */
  balance?(): Promise<bigint>;
  /** Settles what is in flight and lifts a halt that has cleared, without sending anything new. */
  recover?(): Promise<unknown>;
  /** Halt and outstanding-nonce status, for alerts and the read API. No I/O (call recover() first for a fresh view). */
  state?(): SenderState;
}

export interface ChainSenderOptions {
  client: SenderClient;
  account: LocalAccount;
  chainId: number;
  dryRun: boolean;
  /** Keyed Binance Transaction API; null or absent means RPC only (and no sales on mainnet). */
  binance?: BinanceTxApi | null;
  limits?: Partial<SenderLimits>;
  /** File that keeps the outstanding nonce and every hash signed for it across restarts (in the data dir). */
  stateFile?: string;
  pollMs?: number;
  /** Milliseconds; test seam. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface FamilyEntry {
  hash: Hex;
  gasPrice: bigint;
  kind: TxKind;
  via: "binance" | "rpc";
}

interface Intent {
  build: TxBuilder;
  kind: TxKind;
  /** A sale: re-sent only through the protected endpoint. */
  mev: boolean;
}

/** The one unmined nonce of the key and everything signed for it. */
interface Outstanding {
  nonce: number;
  family: FamilyEntry[];
  /** Highest price signed at this nonce (0 when adopted at startup without a record). */
  gasPrice: bigint;
  rounds: number;
  buildFailures: number;
  /** Re-sends of a sale through the protected endpoint so far (at most one). */
  privateResends: number;
  /** What a timeout rebuilds; null when unknown (adopted at startup): a cancel. */
  intent: Intent | null;
  fallback: TxBuilder | null;
  notes: string[];
}

type Halt = HaltInfo & { needWei?: bigint };
type Pushed = "sent" | "taken" | "halted" | "kept";
type Receipt = Awaited<ReturnType<SenderClient["getTransactionReceipt"]>>;

const bump = (gasPrice: bigint) => (gasPrice * REPLACEMENT_BUMP_PERMILLE + 999n) / 1000n;
const big = (a: bigint, b: bigint) => (a > b ? a : b);
const small = (a: bigint, b: bigint) => (a < b ? a : b);
const gwei = (wei: bigint) => `${formatGwei(wei)} gwei`;
const logsOf = (r: Receipt): TxLog[] => (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data }));
const cancelBuilder: TxBuilder = async () => null;

/** How many resolved nonces confirm() can still trace to their replacements. */
const HISTORY = 256;

export class ChainSender implements TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  readonly #client: SenderClient;
  readonly #account: LocalAccount;
  readonly #chainId: number;
  readonly #binance: BinanceTxApi | null;
  readonly #limits: SenderLimits;
  readonly #file: string | null;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #queue: Promise<unknown> = Promise.resolve();
  #out: Outstanding | null = null;
  #halt: Halt | null = null;
  #adopted = false;
  /** The highest "latest" nonce any read has shown: a lagging backend cannot un-mine a transaction. */
  #seenLatest = 0;
  #spends: { at: number; wei: bigint }[] = [];
  /** Every hash signed for a resolved nonce, by nonce. */
  readonly #history = new Map<number, FamilyEntry[]>();

  constructor(o: ChainSenderOptions) {
    this.#client = o.client;
    this.#account = o.account;
    this.address = o.account.address;
    this.#chainId = o.chainId;
    this.dryRun = o.dryRun;
    // Binance simulates and broadcasts against BSC mainnet only: never for a fork or testnet.
    this.#binance = o.chainId === 56 ? (o.binance ?? null) : null;
    this.#limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.#file = o.stateFile ?? null;
    this.#pollMs = o.pollMs ?? POLL_MS;
    this.#now = o.now ?? (() => Date.now());
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  balance(): Promise<bigint> {
    return this.#client.getBalance({ address: this.address });
  }

  state(): SenderState {
    const o = this.#out;
    return {
      sales: this.#chainId !== 56 ? "public" : this.#binance ? "protected" : "disabled",
      halted: this.#halt ? this.#publicHalt() : null,
      outstanding: o ? { nonce: o.nonce, hashes: o.family.map((e) => e.hash), gasPrice: o.gasPrice, rounds: o.rounds, kind: o.intent?.kind ?? "cancel" } : null,
      spentLastHourWei: this.#spent(),
    };
  }

  // -------------------------------------------------------------- simulate

  async simulate(tx: TxRequest, opts: SimulateOptions = {}): Promise<FeedSim> {
    if (!this.#binance) return this.#rpcSimulate(tx);
    let r: SimulationResult;
    try {
      r = await this.#binance.simulate({
        binanceChainId: BINANCE_BSC,
        evmTx: { from: this.address, to: tx.to, value: tx.value.toString(), data: tx.data },
      });
    } catch (err) {
      const sim = await this.#rpcSimulate(tx);
      return { ...sim, note: `binance simulate unavailable, used eth_call: ${safeMessage(err)}` };
    }
    const failed = r.status !== "SUCCESS";
    if (!failed && !opts.strict) return { via: "binance", ok: true };
    // Replay on the RPC: for the decoded custom error, and in strict mode to confirm a success.
    const reason = r.failReason ?? "simulation failed";
    let replay: FeedSim;
    try {
      replay = await this.#rpcSimulate(tx);
    } catch {
      return failed
        ? { via: "binance", ok: false, error: { name: "SimulationFailed", message: reason } }
        : { via: "binance", ok: false, error: { name: "SimulationUnconfirmed", message: "eth_call is unavailable to confirm the Binance simulation" } };
    }
    if (!failed) {
      if (replay.ok) return { via: "binance", ok: true };
      const message = `Binance simulate succeeded but eth_call reverted: ${replay.error?.message ?? "reverted"}`;
      return { via: "binance", ok: false, disagree: true, error: { name: "SimulatorsDisagree", message } };
    }
    if (replay.ok) {
      const message = `binance simulate reported FAILED (${reason}) but eth_call succeeded`;
      // Shields and posts go with eth_call against the head; restores (strict) do not.
      if (opts.strict) return { via: "binance", ok: false, disagree: true, error: { name: "SimulatorsDisagree", message } };
      return { via: "rpc", ok: true, disagree: true, note: message };
    }
    return { via: "binance", ok: false, error: replay.error ?? { name: "SimulationFailed", message: reason } };
  }

  async #rpcSimulate(tx: TxRequest): Promise<FeedSim> {
    try {
      await this.#client.call({ account: this.address, to: tx.to, data: tx.data, value: tx.value });
      return { via: "rpc", ok: true };
    } catch (err) {
      const error = revertError(err);
      if (!error) throw err; // transport failure, not a refusal
      return { via: "rpc", ok: false, error };
    }
  }

  // ------------------------------------------------------------------ send

  send(input: TxRequest | TxBuilder, opts: SendOptions = {}): Promise<SendResult> {
    if (this.dryRun) return Promise.reject(new Error("DRY_RUN is on: simulate only, nothing is sent"));
    return this.#enqueue(() => this.#sendNew(input, opts));
  }

  /**
   * Settles whatever the key has in flight (found at startup, or left by a halt that has cleared) without
   * sending anything new. Call it once at startup; every send does the same before signing.
   */
  recover(): Promise<SendResult | null> {
    if (this.dryRun) return Promise.resolve(null);
    return this.#enqueue(() => this.#catchUp());
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.#queue.then(fn);
    this.#queue = job.catch(() => undefined);
    return job;
  }

  async #latest(): Promise<number> {
    const n = await this.#client.getTransactionCount({ address: this.address, blockTag: "latest" });
    if (n > this.#seenLatest) this.#seenLatest = n;
    return this.#seenLatest;
  }

  async #pending(): Promise<number> {
    return Math.max(await this.#client.getTransactionCount({ address: this.address, blockTag: "pending" }), this.#seenLatest);
  }

  /** Before any new signature: adopt what a restart left, lift a halt that has cleared, settle the outstanding nonce. */
  async #catchUp(): Promise<SendResult | null> {
    await this.#adopt();
    await this.#checkResume();
    if (!this.#out) return null;
    if (!this.#halt) return this.#resolve(this.#out);
    // Halted for another reason: the outstanding nonce may have been mined all the same.
    if ((await this.#latest()) > this.#out.nonce) return this.#finish(this.#out);
    return this.#pendingResult(this.#out);
  }

  async #sendNew(input: TxRequest | TxBuilder, opts: SendOptions): Promise<SendResult> {
    await this.#catchUp();
    if (this.#halt) return { ok: false, stage: "halted", halt: this.#publicHalt() };
    // Nothing of ours is outstanding here. Anything pending at the key is not ours: never sign behind it.
    let [latest, pending] = await Promise.all([this.#latest(), this.#pending()]);
    if (pending > latest) {
      // One read can come from a backend a block behind: look once more before calling it a blocker.
      await this.#sleep(this.#pollMs);
      [latest, pending] = await Promise.all([this.#latest(), this.#pending()]);
    }
    if (pending > latest) {
      this.#doHalt("FOREIGN_BLOCKER", `a transaction this sender did not sign is pending at nonce ${latest}; one sender per key`, latest);
      return { ok: false, stage: "halted", halt: this.#publicHalt() };
    }
    const nonce = latest;
    const notes: string[] = [];
    const build: TxBuilder = typeof input === "function" ? input : async () => input;
    let kind: TxKind = "intent";
    let mev = opts.mevProtect === true && this.#chainId === 56;
    let tx = await build({ round: 0 });
    if (!tx) return { ok: false, stage: "aborted" };
    let intent: Intent = { build, kind, mev };
    if (mev && !this.#binance) {
      // No protected endpoint: the sale was planned (the caller knows what it wanted) but is not sent at all;
      // its cushion repay goes instead, or nothing.
      tx = opts.fallback ? await opts.fallback({ round: 0 }) : null;
      if (!tx || !opts.fallback) return { ok: false, stage: "aborted" };
      kind = "fallback";
      mev = false;
      intent = { build: opts.fallback, kind, mev };
      notes.push("no Binance key: a sale is never broadcast publicly, its cushion repay is sent instead");
    }
    let gas: bigint;
    try {
      gas = await this.#gasFor(tx);
    } catch (err) {
      const error = revertError(err);
      if (!error) throw err;
      return { ok: false, stage: "estimate", error };
    }
    const price = small((await this.#client.getGasPrice()) * NETWORK_PREMIUM_PCT / 100n, this.#limits.maxGasPriceWei);
    const out: Outstanding = { nonce, family: [], gasPrice: 0n, rounds: 0, buildFailures: 0, privateResends: 0, intent, fallback: opts.fallback ?? null, notes };
    this.#out = out;
    let pushed: Pushed;
    try {
      pushed = await this.#push(out, tx, gas, price, kind, mev);
    } catch (err) {
      this.#out = null; // refused before anything could have been sent
      await this.#save();
      throw err;
    }
    if (out.family.length === 0) {
      // Halted (budget, cap, funds) before a transaction went out: nothing is outstanding.
      this.#out = null;
      await this.#save();
      return { ok: false, stage: "halted", halt: this.#publicHalt() };
    }
    if (pushed === "taken") return this.#finish(out);
    if (pushed === "halted") return this.#pendingResult(out);
    return this.#resolve(out);
  }

  /** Waits for the outstanding nonce to be mined, replacing it round by round. Never throws. */
  async #resolve(out: Outstanding): Promise<SendResult> {
    for (;;) {
      if (await this.#waitMined(out.nonce)) return this.#finish(out);
      if (out.rounds >= this.#limits.maxBumps) {
        const failing = out.buildFailures >= this.#limits.maxBumps && out.buildFailures === out.rounds;
        this.#doHalt(
          failing ? "BUILD_FAILED" : "STUCK",
          failing ? `nonce ${out.nonce} is not mined and its intent could not be rebuilt in ${out.rounds} rounds` : `nonce ${out.nonce} is not mined after ${out.rounds} replacement rounds`,
          out.nonce,
        );
        return this.#pendingResult(out);
      }
      const pushed = await this.#round(out);
      if (pushed === "taken") return this.#finish(out);
      if (pushed === "halted") return this.#pendingResult(out);
    }
  }

  /**
   * True once the latest nonce passed `nonce`, false on a timeout. Our nonce is always the latest one we have
   * seen (and that never counts backwards), so nothing can sit below it.
   */
  async #waitMined(nonce: number): Promise<boolean> {
    const end = this.#now() + this.#limits.receiptTimeoutMs;
    for (;;) {
      try {
        if ((await this.#latest()) > nonce) return true;
      } catch {
        // the read failed: keep waiting until the deadline
      }
      if (this.#now() >= end) return false;
      await this.#sleep(this.#pollMs);
    }
  }

  /** One replacement round after a timeout: rebuild the same intent and re-sign it at the same nonce. */
  async #round(out: Outstanding): Promise<Pushed> {
    out.rounds++;
    try {
      const it = out.intent;
      if (!it) return await this.#replace(out, null, "cancel"); // found at startup: cancel it
      if (!it.mev) return await this.#replace(out, it.build, it.kind);
      // A sale gets ONE more try through the protected endpoint. After that (or when it is no longer valid, or
      // would need more than the cap) its nonce is settled in public, by its cushion repay or a cancel: a
      // private transaction that never lands must not hold the key.
      if (out.privateResends === 0) {
        const tx = await it.build({ round: out.rounds });
        const gas = tx && this.#binance ? await this.#gasOrNull(tx) : null;
        const price = tx && gas !== null ? await this.#replacementPrice(out) : null;
        if (tx && gas !== null && price !== null) {
          out.privateResends++;
          return await this.#push(out, tx, gas, price, "intent", true);
        }
        out.notes.push(`round ${out.rounds}: the sale cannot go out again, settling nonce ${out.nonce} in public`);
      } else {
        out.notes.push(`the sale was not mined after a private re-send: its cushion repay settles nonce ${out.nonce} in public`);
      }
      return await this.#replace(out, out.fallback, "fallback");
    } catch (err) {
      // A read or the builder failed before anything new was signed: the outstanding transaction stays.
      out.buildFailures++;
      out.notes.push(`round ${out.rounds}: could not rebuild (${safeMessage(err)}), left as it is`);
      return "kept";
    }
  }

  /** Signs `builder`'s transaction (or a cancel) at the outstanding nonce and broadcasts it publicly. */
  async #replace(out: Outstanding, builder: TxBuilder | null, kind: TxKind): Promise<Pushed> {
    let k = kind;
    let tx = builder ? await builder({ round: out.rounds }) : null;
    let gas = CANCEL_GAS;
    if (tx) {
      const g = await this.#gasOrNull(tx);
      if (g === null) {
        out.notes.push(`round ${out.rounds}: the ${k} would revert now, cancelling`);
        tx = null;
      } else gas = g;
    }
    if (!tx) {
      tx = { to: this.address, data: "0x", value: 0n };
      k = "cancel";
      gas = CANCEL_GAS;
    }
    const price = await this.#replacementPrice(out);
    if (price === null) return this.#capHit(out);
    out.intent = k === "cancel" || !builder ? { build: cancelBuilder, kind: "cancel", mev: false } : { build: builder, kind: k, mev: false };
    return this.#push(out, tx, gas, price, k, false);
  }

  #capHit(out: Outstanding): Pushed {
    this.#doHalt("GAS_CAP", `replacing nonce ${out.nonce} needs more than the gas price cap of ${gwei(this.#limits.maxGasPriceWei)}`, out.nonce);
    return "halted";
  }

  /**
   * Signs one transaction at the outstanding nonce and broadcasts it. Every signed hash joins the family (and
   * the state file) before it leaves, and stays unless the node refused it by name. Throws only when a first
   * transaction is rejected outright.
   */
  async #push(out: Outstanding, tx: TxRequest, gas: bigint, price: bigint, kind: TxKind, mev: boolean): Promise<Pushed> {
    const fresh = out.family.length === 0;
    let p = price;
    for (;;) {
      if (p > this.#limits.maxGasPriceWei) return this.#capHit(out);
      const cost = gas * p + tx.value;
      if (this.#spent() + gas * p > this.#limits.maxFeeWeiPerHour) {
        this.#doHalt("FEE_BUDGET", `the fee budget of ${formatEther(this.#limits.maxFeeWeiPerHour)} BNB per hour is used up`, fresh ? null : out.nonce, gas * p);
        return "halted";
      }
      const signed = await this.#account.signTransaction({ type: "legacy", chainId: this.#chainId, nonce: out.nonce, to: tx.to, data: tx.data, value: tx.value, gas, gasPrice: p });
      const entry: FamilyEntry = { hash: keccak256(signed), gasPrice: p, kind, via: mev ? "binance" : "rpc" };
      this.#spends.push({ at: this.#now(), wei: gas * p });
      out.family.push(entry);
      out.gasPrice = big(out.gasPrice, p);
      await this.#save();
      const drop = () => {
        out.family.splice(out.family.indexOf(entry), 1);
      };

      if (mev) {
        try {
          await (this.#binance as BinanceTxApi).broadcast({ binanceChainId: BINANCE_BSC, signedTransaction: signed, address: this.address, enableMevProtection: true });
          return "sent";
        } catch (err) {
          // It may have been relayed. It is never sent publicly: the cushion repay takes the nonce instead,
          // which cancels the sale if it was not relayed and loses to it if it was.
          out.notes.push(`binance broadcast failed (${safeMessage(err)}): the sale is not sent publicly, its cushion repay replaces it at nonce ${out.nonce}`);
          out.rounds++;
          try {
            return await this.#replace(out, out.fallback, "fallback");
          } catch (e) {
            out.buildFailures++;
            out.notes.push(`the cushion repay could not be built (${safeMessage(e)})`);
            return "kept";
          }
        }
      }

      let failure: BroadcastError | null = null;
      let why = "";
      try {
        await this.#client.sendRawTransaction({ serializedTransaction: signed });
      } catch (err) {
        failure = classifyBroadcastError(err);
        why = safeMessage(err);
      }
      switch (failure) {
        case null:
        case "known":
          return "sent";
        case "possibly-sent":
          out.notes.push(`broadcast of nonce ${out.nonce} got no answer (${why}): treated as sent`);
          return "sent";
        case "nonce-too-low":
          return "taken";
        case "underpriced":
          // The node holds something at this nonce that pays more: outbid the price just tried, under the cap.
          drop();
          out.notes.push(`${gwei(p)} was underpriced at nonce ${out.nonce}`);
          p = bump(p);
          continue;
        case "insufficient-funds":
          drop();
          this.#doHalt("INSUFFICIENT_FUNDS", `the desk key cannot pay for a transaction (${formatEther(cost)} BNB needed): top up ${this.address}`, fresh ? null : out.nonce, cost);
          return "halted";
        case "rejected":
          drop();
          if (out.family.length === 0) throw new Error(`broadcast rejected: ${why}`);
          out.notes.push(`replacement at nonce ${out.nonce} rejected (${why}), the earlier one stays`);
          return "kept";
      }
    }
  }

  /** Gas limit for `tx`. Throws on a revert (and on transport errors). */
  async #gasFor(tx: TxRequest): Promise<bigint> {
    return ((await this.#client.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value })) * GAS_HEADROOM_PCT) / 100n;
  }

  /** Gas limit, or null when the transaction would revert now. Transport errors throw. */
  async #gasOrNull(tx: TxRequest): Promise<bigint | null> {
    try {
      return await this.#gasFor(tx);
    } catch (err) {
      if (revertError(err)) return null;
      throw err;
    }
  }

  /** Price for the next transaction at an outstanding nonce, or null when the cap forbids a valid replacement. */
  async #replacementPrice(out: Outstanding): Promise<bigint | null> {
    const cap = this.#limits.maxGasPriceWei;
    const network = await this.#client.getGasPrice();
    // Found at startup with no record of what it pays: outbid generously, under the cap.
    if (out.gasPrice === 0n) return small(network * 2n, cap);
    const want = big(bump(out.gasPrice), (network * NETWORK_PREMIUM_PCT) / 100n);
    if (want <= cap) return want;
    return cap * 1000n >= out.gasPrice * MIN_REPLACEMENT_PERMILLE ? cap : null;
  }

  /** The nonce was mined: find which of our hashes it was. Never throws. */
  async #finish(out: Outstanding): Promise<SendResult> {
    let found: { entry: FamilyEntry; receipt: Receipt } | null = null;
    for (let attempt = 0; attempt < 3 && !found; attempt++) {
      if (attempt > 0) await this.#sleep(this.#pollMs); // receipts can trail the nonce by a moment
      for (const entry of [...out.family].reverse()) {
        try {
          const receipt = await this.#receipt(entry.hash);
          if (receipt) {
            found = { entry, receipt };
            break;
          }
        } catch {
          // unreadable right now: try again
        }
      }
    }
    this.#out = null;
    this.#history.set(out.nonce, out.family);
    while (this.#history.size > HISTORY) this.#history.delete(this.#history.keys().next().value as number);
    await this.#save();
    const last = out.family[out.family.length - 1];
    if (!found) {
      const note = [...out.notes, `nonce ${out.nonce} went to a transaction that is not ours`].join("; ");
      return { ok: true, status: "dropped", txHash: last?.hash ?? zeroHash, via: last?.via ?? "rpc", nonce: out.nonce, gasPrice: out.gasPrice, note };
    }
    const { entry, receipt } = found;
    const cancelled = entry.kind === "cancel";
    const notes = cancelled ? [...out.notes, "cancelled: no longer needed"] : out.notes;
    const value: SendResult = {
      ok: true,
      status: cancelled ? "dropped" : receipt.status === "success" ? "success" : "reverted",
      txHash: entry.hash,
      via: entry.via,
      nonce: out.nonce,
      gasPrice: entry.gasPrice,
      minedAs: entry.kind,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      blockNumber: receipt.blockNumber,
      logs: logsOf(receipt),
    };
    if (notes.length) value.note = notes.join("; ");
    return value;
  }

  #pendingResult(out: Outstanding): SendResult {
    const last = out.family[out.family.length - 1];
    const value: SendResult = { ok: true, status: "pending", txHash: last?.hash ?? zeroHash, via: last?.via ?? "rpc", nonce: out.nonce, gasPrice: out.gasPrice };
    if (out.notes.length) value.note = out.notes.join("; ");
    if (this.#halt) value.halted = this.#publicHalt();
    return value;
  }

  // ------------------------------------------------------------------ halt

  #publicHalt(): HaltInfo {
    const h = this.#halt as Halt;
    return { reason: h.reason, message: h.message, nonce: h.nonce, since: h.since };
  }

  #doHalt(reason: HaltReason, message: string, nonce: number | null, needWei?: bigint) {
    if (this.#halt) return; // the first reason stands
    this.#halt = { reason, message, nonce, since: Math.floor(this.#now() / 1000), ...(needWei !== undefined ? { needWei } : {}) };
  }

  /** Lifts the halt once its cause is gone. */
  async #checkResume() {
    const h = this.#halt;
    if (!h) return;
    const latest = await this.#latest();
    const mined = h.nonce !== null && latest > h.nonce;
    let clear = false;
    switch (h.reason) {
      case "STUCK":
      case "GAS_CAP":
      case "BUILD_FAILED":
      case "FOREIGN_BLOCKER":
        clear = mined || (await this.#vanished(latest));
        break;
      case "INSUFFICIENT_FUNDS":
        clear = mined || (await this.balance()) >= (h.needWei ?? 0n);
        break;
      case "FEE_BUDGET":
        clear = this.#spent() + (h.needWei ?? 0n) <= this.#limits.maxFeeWeiPerHour;
        break;
    }
    if (clear) this.#halt = null;
  }

  /**
   * True when nothing of the key is pending and no node knows any hash signed for the outstanding nonce (the
   * rule confirm() uses for "dropped"): the mempool let go of it, so the nonce is free and the halt is moot.
   * The outstanding nonce is given up with it.
   */
  async #vanished(latest: number): Promise<boolean> {
    if ((await this.#pending()) !== latest) return false;
    const out = this.#out;
    if (!out) return true;
    for (const e of out.family) if (await this.#known(e.hash)) return false;
    this.#out = null;
    this.#history.set(out.nonce, out.family);
    await this.#save();
    return true;
  }

  #spent(): bigint {
    const from = this.#now() - HOUR_MS;
    this.#spends = this.#spends.filter((s) => s.at > from);
    return this.#spends.reduce((sum, s) => sum + s.wei, 0n);
  }

  // --------------------------------------------------------------- restart

  /** Once per process: take over the nonce a restart left unmined, with the hashes the state file kept. */
  async #adopt() {
    if (this.#adopted) return;
    const [latest, pending] = await Promise.all([this.#latest(), this.#pending()]);
    const saved = await this.#load();
    this.#adopted = true;
    if (pending > latest) {
      const family = saved && saved.nonce === latest ? saved.family : [];
      this.#out = {
        nonce: latest,
        family,
        gasPrice: family.reduce((m, e) => big(m, e.gasPrice), 0n),
        rounds: 0,
        buildFailures: 0,
        privateResends: 0,
        intent: null,
        fallback: null,
        notes: [`nonce ${latest} was pending at startup: cancelled unless it is mined first`],
      };
      await this.#save();
      return;
    }
    // Nothing of the key is pending: what the file names was mined, or the node lost it (confirm() says which).
    if (saved) {
      this.#history.set(saved.nonce, saved.family);
      await this.#save();
    }
  }

  async #save() {
    if (!this.#file) return;
    try {
      const o = this.#out;
      if (!o || o.family.length === 0) {
        await rm(this.#file, { force: true });
        return;
      }
      const body = JSON.stringify({ nonce: o.nonce, family: o.family.map((e) => ({ ...e, gasPrice: e.gasPrice.toString() })) });
      await mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.#file); // atomic: a crash leaves the old file or the new one
    } catch (err) {
      this.#out?.notes.push(`sender state not saved: ${safeMessage(err)}`);
    }
  }

  async #load(): Promise<{ nonce: number; family: FamilyEntry[] } | null> {
    if (!this.#file) return null;
    try {
      const j = JSON.parse(await readFile(this.#file, "utf8")) as { nonce?: unknown; family?: unknown };
      if (typeof j.nonce !== "number" || !Array.isArray(j.family)) return null;
      const family: FamilyEntry[] = [];
      for (const e of j.family as Record<string, unknown>[]) {
        if (typeof e.hash !== "string" || typeof e.gasPrice !== "string") continue;
        family.push({ hash: e.hash as Hex, gasPrice: BigInt(e.gasPrice), kind: e.kind === "fallback" || e.kind === "cancel" ? e.kind : "intent", via: e.via === "binance" ? "binance" : "rpc" });
      }
      return { nonce: j.nonce, family };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- confirm

  async confirm(txHash: Hex, nonce?: number): Promise<Confirmation> {
    // Latest first: a transaction mined between the two reads then shows its receipt instead of reading as dropped.
    const latest = nonce === undefined ? undefined : await this.#latest();
    // Only the hashes signed for the same intent count: another intent may have used this nonce since.
    const has = (list: readonly FamilyEntry[] | undefined) => (list?.some((e) => e.hash.toLowerCase() === txHash.toLowerCase()) ? list : undefined);
    const ours = has(this.#out?.family);
    if (ours && latest !== undefined && latest <= (this.#out as Outstanding).nonce) return { status: "pending" }; // the sender is working on it
    const past = ours ?? has([...this.#history.values()].find((f) => has(f)));
    const family = new Map<string, FamilyEntry | { hash: Hex; kind?: undefined }>([[txHash.toLowerCase(), { hash: txHash }]]);
    for (const e of past ?? []) family.set(e.hash.toLowerCase(), e);
    for (const e of family.values()) {
      const r = await this.#receipt(e.hash);
      if (!r) continue;
      const kind: TxKind = e.kind ?? "intent";
      return {
        status: kind === "cancel" ? "dropped" : r.status === "success" ? "success" : "reverted",
        txHash: e.hash,
        minedAs: kind,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        blockNumber: r.blockNumber,
        logs: logsOf(r),
      };
    }
    if (latest === undefined || nonce === undefined) return { status: "pending" };
    if (latest > nonce) return { status: "dropped" };
    // Still the next nonce, with nothing of the key pending and no node knowing it: it was lost, not delayed.
    if (latest === nonce && (await this.#pending()) === latest) {
      for (const e of family.values()) if (await this.#known(e.hash)) return { status: "pending" };
      return { status: "dropped" };
    }
    return { status: "pending" };
  }

  async #receipt(hash: Hex): Promise<Receipt | null> {
    try {
      return await this.#client.getTransactionReceipt({ hash });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async #known(hash: Hex): Promise<boolean> {
    try {
      await this.#client.getTransaction({ hash });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

// ---------------------------------------------------------------- gas watch

/** One alert when the desk key's BNB balance drops below the threshold, and again after each recovery. */
export class GasWatch {
  #low = false;

  constructor(private readonly o: { sender: Pick<TxSender, "address" | "balance">; feed: Feed; minWei: bigint }) {}

  /** The balance (null when unreadable); records the alert on the way down. */
  async check(source: FeedSource): Promise<bigint | null> {
    if (!this.o.sender.balance) return null;
    let b: bigint;
    try {
      b = await this.o.sender.balance();
    } catch {
      return null;
    }
    if (b >= this.o.minWei) {
      this.#low = false;
      return b;
    }
    if (!this.#low) {
      this.#low = true;
      await this.o.feed.record({
        kind: "alert",
        source,
        reason: `the desk key ${this.o.sender.address} holds ${formatEther(b)} BNB, below ${formatEther(this.o.minWei)} BNB: top it up or shields will fail`,
        data: { balance: b, min: this.o.minWei },
      });
    }
    return b;
  }
}
