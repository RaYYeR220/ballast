// Simulation and broadcast for the desk key. Every write is simulated first: through the Binance
// Transaction API when a key is configured on BSC mainnet, else with eth_call on our RPC. Sends are signed
// locally and serialized through one nonce manager per key. Collateral sales (shieldDeleverage) go through
// the Binance Transaction API with MEV protection when keyed; everything else goes straight to the RPC.
// Raw signed transactions never leave this module.
import { decodeBallastError, isRevert, type TxRequest } from "@ballast/sdk";
import { transaction, type Web3Client } from "@ballast/binance";
import { formatEther, keccak256, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import type { Feed, FeedError, FeedSim, FeedSource } from "./feed";

/** The subset of a viem PublicClient the sender uses. */
export type SenderClient = Pick<
  PublicClient,
  | "call"
  | "estimateGas"
  | "getGasPrice"
  | "getTransactionCount"
  | "sendRawTransaction"
  | "waitForTransactionReceipt"
  | "getTransaction"
  | "getTransactionReceipt"
  | "getBalance"
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
/** A replacement must outbid our own stuck transaction by at least this much (nodes require 10%). */
export const REPLACEMENT_BUMP_PERMILLE = 1125n;
const RECEIPT_TIMEOUT_MS = 60_000;
const RETRY_TIMEOUT_MS = 20_000;
export const DEFAULT_MIN_BNB = 0.003;

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

/** viem's "not found" errors for a transaction or its receipt (any other failure is real). */
function isNotFound(err: unknown): boolean {
  for (let e = err as { name?: unknown; cause?: unknown } | undefined, i = 0; e && i < 10; e = e.cause as typeof e, i++) {
    if (typeof e.name === "string" && /NotFound/.test(e.name)) return true;
  }
  return false;
}

const alreadyKnown = (m: string) => /already known|known transaction/i.test(m);

// ------------------------------------------------------------------- nonces

/** What run() hands to a send: the nonce and, when it replaces our own unmined transaction, that one's gas price. */
export interface NonceSlot {
  nonce: number;
  replacing?: bigint;
}

export interface SlotOutcome<T> {
  consumed: boolean;
  value: T;
  /** Broadcast but not mined: release the nonce so the next send replaces this transaction. */
  stuck?: { gasPrice: bigint };
}

/**
 * Serializes every send of one key and hands out nonces. Each run starts from max(chain pending nonce,
 * the next nonce this process already used), so a send by another component sharing the key is picked up.
 * A transaction left unmined is remembered: until the chain's latest nonce passes it, the next send reuses
 * its nonce at a higher gas price and so replaces it.
 */
export class NonceManager {
  #queue: Promise<unknown> = Promise.resolve();
  #next: number | null = null;
  #stuck: { nonce: number; gasPrice: bigint } | null = null;

  constructor(
    private readonly pending: () => Promise<number>,
    private readonly latest: () => Promise<number> = pending,
  ) {}

  run<T>(fn: (nonce: number, slot: NonceSlot) => Promise<SlotOutcome<T>>): Promise<T> {
    const job = this.#queue.then(async () => {
      const chain = await this.pending();
      let nonce = this.#next === null ? chain : Math.max(chain, this.#next);
      let replacing: bigint | undefined;
      if (this.#stuck) {
        if ((await this.latest()) > this.#stuck.nonce) this.#stuck = null; // mined (or replaced) meanwhile
        else {
          nonce = this.#stuck.nonce;
          replacing = this.#stuck.gasPrice;
        }
      }
      try {
        const r = await fn(nonce, replacing === undefined ? { nonce } : { nonce, replacing });
        if (r.stuck) {
          this.#stuck = { nonce, gasPrice: r.stuck.gasPrice };
          this.#next = null;
        } else {
          if (r.consumed && this.#stuck?.nonce === nonce) this.#stuck = null;
          this.#next = r.consumed ? nonce + 1 : nonce;
        }
        return r.value;
      } catch (err) {
        this.#next = null; // unknown outcome: trust the chain next time
        throw err;
      }
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }
}

const managers = new Map<string, NonceManager>();

/** The process-wide nonce manager for `address` (Studio code sharing the key must use this one too). */
export function nonceManagerFor(address: Address, pending: () => Promise<number>, latest?: () => Promise<number>): NonceManager {
  const k = address.toLowerCase();
  let m = managers.get(k);
  if (!m) {
    m = new NonceManager(pending, latest);
    managers.set(k, m);
  }
  return m;
}

// ------------------------------------------------------------------- sender

/**
 * success / reverted: mined. pending: broadcast but not mined yet (record it as pending, confirm later).
 * dropped: the nonce was taken by another transaction (a replacement) before this one was mined.
 */
export type TxStatus = "success" | "reverted" | "pending" | "dropped";

export type SendResult =
  | {
      ok: true;
      txHash: Hex;
      via: "binance" | "rpc";
      status: TxStatus;
      nonce: number;
      gasPrice: bigint;
      gasUsed?: bigint;
      effectiveGasPrice?: bigint;
      blockNumber?: bigint;
      note?: string;
    }
  | { ok: false; stage: "estimate"; error: FeedError }
  /** The builder returned null: nothing was signed and the nonce stays free. */
  | { ok: false; stage: "aborted" };

/** Builds the transaction inside the send critical section (after the nonce wait); null aborts the send. */
export type TxBuilder = () => Promise<TxRequest | null>;

export interface SendOptions {
  /** Broadcast through the Binance Transaction API with MEV protection (keyed mainnet only). For sales. */
  mevProtect?: boolean;
}

export interface SimulateOptions {
  /** Binance simulate and eth_call must both succeed: a disagreement fails the simulation (restores). */
  strict?: boolean;
}

export interface Confirmation {
  status: TxStatus;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  blockNumber?: bigint;
}

/** What the loops need: simulate, send, the sender address and the DRY_RUN switch. */
export interface TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  simulate(tx: TxRequest, opts?: SimulateOptions): Promise<FeedSim>;
  send(tx: TxRequest | TxBuilder, opts?: SendOptions): Promise<SendResult>;
  /** Status of a transaction sent earlier; `nonce` lets one replaced by another transaction read as dropped. */
  confirm?(txHash: Hex, nonce?: number): Promise<Confirmation>;
  /** BNB balance of the desk key, wei. */
  balance?(): Promise<bigint>;
}

export interface ChainSenderOptions {
  client: SenderClient;
  account: LocalAccount;
  chainId: number;
  dryRun: boolean;
  /** Keyed Binance Transaction API; null or absent means RPC only. */
  binance?: BinanceTxApi | null;
  nonces?: NonceManager;
  receiptTimeoutMs?: number;
  /** Wait after a rebroadcast of a transaction the node had lost. */
  retryTimeoutMs?: number;
}

const bump = (gasPrice: bigint) => (gasPrice * REPLACEMENT_BUMP_PERMILLE + 999n) / 1000n;

type Receipt = Awaited<ReturnType<SenderClient["waitForTransactionReceipt"]>>;

export class ChainSender implements TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  readonly #client: SenderClient;
  readonly #account: LocalAccount;
  readonly #chainId: number;
  readonly #binance: BinanceTxApi | null;
  readonly #nonces: NonceManager;
  readonly #receiptMs: number;
  readonly #retryMs: number;

  constructor(o: ChainSenderOptions) {
    this.#client = o.client;
    this.#account = o.account;
    this.address = o.account.address;
    this.#chainId = o.chainId;
    this.dryRun = o.dryRun;
    // Binance simulates and broadcasts against BSC mainnet only: never for a fork or testnet.
    this.#binance = o.chainId === 56 ? (o.binance ?? null) : null;
    this.#receiptMs = o.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
    this.#retryMs = o.retryTimeoutMs ?? RETRY_TIMEOUT_MS;
    this.#nonces =
      o.nonces ??
      nonceManagerFor(
        this.address,
        () => this.#client.getTransactionCount({ address: this.address, blockTag: "pending" }),
        () => this.#client.getTransactionCount({ address: this.address, blockTag: "latest" }),
      );
  }

  balance(): Promise<bigint> {
    return this.#client.getBalance({ address: this.address });
  }

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

  send(input: TxRequest | TxBuilder, opts: SendOptions = {}): Promise<SendResult> {
    if (this.dryRun) return Promise.reject(new Error("DRY_RUN is on: simulate only, nothing is sent"));
    return this.#nonces.run(async (nonce, slot): Promise<SlotOutcome<SendResult>> => {
      const tx = typeof input === "function" ? await input() : input;
      if (!tx) return { consumed: false, value: { ok: false, stage: "aborted" } };
      let gas: bigint;
      try {
        gas = await this.#client.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value });
      } catch (err) {
        const error = revertError(err);
        if (!error) throw err;
        return { consumed: false, value: { ok: false, stage: "estimate", error } };
      }
      let gasPrice = await this.#client.getGasPrice();
      if (slot.replacing !== undefined && gasPrice < bump(slot.replacing)) gasPrice = bump(slot.replacing);
      const signed = await this.#account.signTransaction({
        type: "legacy",
        chainId: this.#chainId,
        nonce,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: (gas * GAS_HEADROOM_PCT) / 100n,
        gasPrice,
      });
      const txHash = keccak256(signed);
      const notes: string[] = [];
      if (slot.replacing !== undefined) notes.push(`replaces an unmined transaction at nonce ${nonce}`);
      let via: "binance" | "rpc" = "rpc";
      if (opts.mevProtect && this.#binance) {
        try {
          await this.#binance.broadcast({ binanceChainId: BINANCE_BSC, signedTransaction: signed, address: this.address, enableMevProtection: true });
          via = "binance";
        } catch (err) {
          notes.push(`binance broadcast failed, sent through the RPC: ${safeMessage(err)}`);
        }
      }
      if (via === "rpc") {
        try {
          await this.#client.sendRawTransaction({ serializedTransaction: signed });
        } catch (err) {
          const m = safeMessage(err);
          // The Binance attempt may have reached the mempool already: the same bytes are then "known".
          if (!alreadyKnown(m)) throw new Error(`broadcast failed: ${m}`);
        }
      }
      const base = { ok: true as const, txHash, via, nonce, gasPrice };
      const done = (r: Receipt, extra: string[] = []): SlotOutcome<SendResult> => {
        const value: SendResult = {
          ...base,
          status: r.status === "success" ? "success" : "reverted",
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          blockNumber: r.blockNumber,
        };
        const n = [...notes, ...extra];
        if (n.length) value.note = n.join("; ");
        return { consumed: true, value };
      };
      try {
        return done(await this.#client.waitForTransactionReceipt({ hash: txHash, timeout: this.#receiptMs }));
      } catch {
        // No receipt in time: find out whether it is still coming, was lost, or lost its nonce.
      }
      const latest = await this.#client.getTransactionCount({ address: this.address, blockTag: "latest" });
      if (latest > nonce) {
        const r = await this.#receipt(txHash);
        if (r) return done(r);
        return { consumed: true, value: { ...base, status: "dropped", note: [...notes, `nonce ${nonce} was used by another transaction`].join("; ") } };
      }
      if (!(await this.#known(txHash))) {
        notes.push("the node lost the transaction: rebroadcast once");
        try {
          await this.#client.sendRawTransaction({ serializedTransaction: signed });
        } catch (err) {
          const m = safeMessage(err);
          if (!alreadyKnown(m)) notes.push(`rebroadcast failed: ${m}`);
        }
        try {
          return done(await this.#client.waitForTransactionReceipt({ hash: txHash, timeout: this.#retryMs }));
        } catch {
          // still not mined
        }
      }
      notes.push("not mined yet: the next send replaces it at a higher gas price");
      return { consumed: true, stuck: { gasPrice }, value: { ...base, status: "pending", note: notes.join("; ") } };
    });
  }

  async confirm(txHash: Hex, nonce?: number): Promise<Confirmation> {
    const latest = nonce === undefined ? undefined : await this.#client.getTransactionCount({ address: this.address, blockTag: "latest" });
    const r = await this.#receipt(txHash);
    if (r) return { status: r.status === "success" ? "success" : "reverted", gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber };
    if (latest !== undefined && nonce !== undefined && latest > nonce) return { status: "dropped" };
    return { status: "pending" };
  }

  async #receipt(hash: Hex) {
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
    } catch {
      return false; // not found, or the node cannot say: rebroadcasting the same bytes is harmless
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
