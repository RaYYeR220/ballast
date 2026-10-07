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

/** Re-sends a time-critical intent at its own nonce (re-planned, re-simulated, re-signed at a higher price). */
export type SlotRetry = (slot: NonceSlot) => Promise<SlotOutcome<unknown>>;

export interface SlotOutcome<T> {
  consumed: boolean;
  value: T;
  /**
   * Broadcast but not mined. With `retry` (a time-critical intent) the next run first speeds it up at the same
   * nonce; without, the next send takes the nonce and so replaces it.
   */
  stuck?: { gasPrice: bigint; retry?: SlotRetry };
}

interface StuckSlot {
  nonce: number;
  gasPrice: bigint;
  retry?: SlotRetry;
}

/**
 * Serializes every send of one key and hands out nonces. Each run starts from max(chain pending nonce,
 * the next nonce this process already used), so a send by another component sharing the key is picked up.
 *
 * Unmined transactions are remembered by nonce until the chain's latest nonce passes them. A time-critical one
 * (a shield) is sped up first by every later run: its intent is rebuilt and re-signed at the same nonce for
 * more gas, and the run's own send takes the next nonce; if the intent is no longer needed it becomes a plain
 * slot. A plain slot (a restore, a post, or one found at startup) is taken by the next send, which replaces it.
 */
export class NonceManager {
  #queue: Promise<unknown> = Promise.resolve();
  #next: number | null = null;
  readonly #stuck = new Map<number, StuckSlot>();
  #started = false;

  /**
   * @param seed gas price of our own unmined transaction at `nonce` found at startup (pending > latest), so
   *   the first send can outbid it; without it such a transaction is left alone.
   */
  constructor(
    private readonly pending: () => Promise<number>,
    private readonly latest: () => Promise<number>,
    private readonly seed?: (nonce: number) => Promise<bigint>,
  ) {}

  run<T>(fn: (nonce: number, slot: NonceSlot) => Promise<SlotOutcome<T>>): Promise<T> {
    const job = this.#queue.then(async () => {
      const latest = await this.latest();
      for (const n of [...this.#stuck.keys()]) if (n < latest) this.#stuck.delete(n); // mined or replaced
      if (!this.#started) {
        this.#started = true;
        // A restart forgets what was in flight: a transaction still pending at `latest` would wedge every
        // later nonce, so the first send replaces it.
        if (this.seed && (await this.pending()) > latest && !this.#stuck.has(latest)) {
          this.#stuck.set(latest, { nonce: latest, gasPrice: await this.seed(latest) });
        }
      }
      await this.#speedUp();
      const plain = [...this.#stuck.values()].filter((s) => !s.retry).sort((a, b) => a.nonce - b.nonce)[0];
      let nonce: number;
      let replacing: bigint | undefined;
      if (plain) {
        nonce = plain.nonce;
        replacing = plain.gasPrice;
      } else {
        const chain = await this.pending();
        const above = Math.max(-1, ...this.#stuck.keys()) + 1;
        nonce = Math.max(chain, above, this.#next ?? 0);
      }
      try {
        const r = await fn(nonce, replacing === undefined ? { nonce } : { nonce, replacing });
        if (r.stuck) {
          this.#stuck.set(nonce, { nonce, gasPrice: r.stuck.gasPrice, ...(r.stuck.retry ? { retry: r.stuck.retry } : {}) });
          this.#next = nonce + 1;
        } else {
          if (r.consumed) this.#stuck.delete(nonce);
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

  /** Re-sends every stuck time-critical intent at its own nonce, lowest first. */
  async #speedUp() {
    const critical = [...this.#stuck.values()].filter((s) => s.retry).sort((a, b) => a.nonce - b.nonce);
    for (const s of critical) {
      let r: SlotOutcome<unknown> | null = null;
      try {
        r = await (s.retry as SlotRetry)({ nonce: s.nonce, replacing: s.gasPrice });
      } catch {
        r = null; // could not be rebuilt (reads failed): treat as no longer needed
      }
      if (r?.consumed && r.stuck) this.#stuck.set(s.nonce, { nonce: s.nonce, gasPrice: r.stuck.gasPrice, retry: r.stuck.retry ?? (s.retry as SlotRetry) });
      else if (r?.consumed) this.#stuck.delete(s.nonce);
      else this.#stuck.set(s.nonce, { nonce: s.nonce, gasPrice: s.gasPrice }); // aborted: the current send takes it
    }
  }
}

const managers = new Map<string, NonceManager>();

/** The process-wide nonce manager for `address` (Studio code sharing the key must use this one too). */
export function nonceManagerFor(
  address: Address,
  pending: () => Promise<number>,
  latest: () => Promise<number>,
  seed?: (nonce: number) => Promise<bigint>,
): NonceManager {
  const k = address.toLowerCase();
  let m = managers.get(k);
  if (!m) {
    m = new NonceManager(pending, latest, seed);
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

/** A receipt log, enough to decode events. */
export interface TxLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

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
      logs?: TxLog[];
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
  /**
   * Time-critical (shields): if it is not mined in time, later sends first speed it up by rebuilding it at the
   * same nonce for more gas instead of replacing it.
   */
  critical?: boolean;
}

export interface SimulateOptions {
  /** Binance simulate and eth_call must both succeed: a disagreement fails the simulation (restores). */
  strict?: boolean;
}

export interface Confirmation {
  status: TxStatus;
  /** The transaction that was mined: a speed-up of the one asked about may have replaced it. */
  txHash?: Hex;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  blockNumber?: bigint;
  logs?: TxLog[];
}

/** What the loops need: simulate, send, the sender address and the DRY_RUN switch. */
export interface TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  simulate(tx: TxRequest, opts?: SimulateOptions): Promise<FeedSim>;
  send(tx: TxRequest | TxBuilder, opts?: SendOptions): Promise<SendResult>;
  /** Status of a transaction sent earlier (or of a speed-up that replaced it); `nonce` lets a lost one read as dropped. */
  confirm?(txHash: Hex, nonce?: number): Promise<Confirmation>;
  /** Speeds up stuck time-critical sends and cancels other stuck ones, without sending anything else. */
  unstick?(): Promise<unknown>;
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
  /** Hashes of our transactions the feed still lists as pending (to price a replacement after a restart). */
  knownPending?: () => readonly Hex[];
}

const bump = (gasPrice: bigint) => (gasPrice * REPLACEMENT_BUMP_PERMILLE + 999n) / 1000n;

type Receipt = Awaited<ReturnType<SenderClient["waitForTransactionReceipt"]>>;

const logsOf = (r: Receipt): TxLog[] => (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data }));

/** How many sent transactions confirm() can trace to their speed-ups. */
const FAMILY_MEMORY = 512;

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
  /** Every hash of one intent (the first send and its speed-ups), by each of its hashes. */
  readonly #families = new Map<string, Hex[]>();

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
    const known = o.knownPending ?? (() => []);
    this.#nonces =
      o.nonces ??
      nonceManagerFor(
        this.address,
        () => this.#client.getTransactionCount({ address: this.address, blockTag: "pending" }),
        () => this.#client.getTransactionCount({ address: this.address, blockTag: "latest" }),
        (nonce) => this.#gasPriceAt(nonce, known()),
      );
  }

  balance(): Promise<bigint> {
    return this.#client.getBalance({ address: this.address });
  }

  /** Gas price of our pending transaction at `nonce` among `hashes`, else the network price. */
  async #gasPriceAt(nonce: number, hashes: readonly Hex[]): Promise<bigint> {
    for (const hash of hashes) {
      try {
        const t = await this.#client.getTransaction({ hash });
        if (t.nonce === nonce && t.gasPrice) return t.gasPrice;
      } catch {
        // not known to the node
      }
    }
    return this.#client.getGasPrice();
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
    return this.#nonces.run((_nonce, slot) => this.#sendAt(input, opts, slot, []));
  }

  async unstick(): Promise<SendResult | null> {
    if (this.dryRun) return null;
    // The run speeds up stuck time-critical sends by itself; a plain stuck one is cancelled with a 0-value
    // transfer to ourselves at its nonce.
    return this.#nonces.run(async (_nonce, slot): Promise<SlotOutcome<SendResult | null>> => {
      if (slot.replacing === undefined) return { consumed: false, value: null };
      return this.#sendAt({ to: this.address, data: "0x", value: 0n }, {}, slot, []);
    });
  }

  /** One signed send at `slot.nonce`. Never throws once the transaction is broadcast. */
  async #sendAt(input: TxRequest | TxBuilder, opts: SendOptions, slot: NonceSlot, family: Hex[]): Promise<SlotOutcome<SendResult>> {
    const { nonce } = slot;
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
    if (slot.replacing !== undefined) notes.push(family.length ? `speeds up the unmined send at nonce ${nonce}` : `replaces an unmined transaction at nonce ${nonce}`);
    const via = await this.#broadcast(signed, opts.mevProtect === true, notes);
    family.push(txHash);
    this.#remember(txHash, family);

    // From here on nothing throws: the transaction may be in a mempool, so the nonce counts as used.
    const retry: SlotRetry | undefined = opts.critical ? (s) => this.#sendAt(input, opts, s, family) : undefined;
    const base = { ok: true as const, txHash, via, nonce, gasPrice };
    const stuck = (extra: string): SlotOutcome<SendResult> => ({
      consumed: true,
      stuck: { gasPrice, ...(retry ? { retry } : {}) },
      value: { ...base, status: "pending", note: [...notes, extra].join("; ") },
    });
    const done = (r: Receipt): SlotOutcome<SendResult> => {
      const value: SendResult = {
        ...base,
        status: r.status === "success" ? "success" : "reverted",
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        blockNumber: r.blockNumber,
        logs: logsOf(r),
      };
      if (notes.length) value.note = notes.join("; ");
      return { consumed: true, value };
    };
    const wait = (timeout: number) => this.#client.waitForTransactionReceipt({ hash: txHash, timeout });
    try {
      try {
        return done(await wait(this.#receiptMs));
      } catch {
        // No receipt in time: find out whether it is still coming, was lost, or lost its nonce.
      }
      const latest = await this.#client.getTransactionCount({ address: this.address, blockTag: "latest" });
      if (latest > nonce) {
        const r = await this.#receipt(txHash);
        if (r) return done(r);
        return { consumed: true, value: { ...base, status: "dropped", note: [...notes, `nonce ${nonce} was used by another transaction`].join("; ") } };
      }
      // A MEV-protected send is private: the public node never sees it, so resend it the same way.
      if (via === "binance" || !(await this.#known(txHash))) {
        notes.push(`not seen after ${this.#receiptMs / 1000} s: rebroadcast once`);
        await this.#rebroadcast(signed, via === "binance", notes);
        try {
          return done(await wait(this.#retryMs));
        } catch {
          // still not mined
        }
      }
      return stuck(retry ? "not mined yet: the next send speeds it up at the same nonce" : "not mined yet: the next send replaces it");
    } catch (err) {
      return stuck(`could not follow it up (${safeMessage(err)}): treated as pending`);
    }
  }

  /** Sends signed bytes: MEV-protected through Binance when asked and keyed, else (or on its error) the RPC. */
  async #broadcast(signed: Hex, mevProtect: boolean, notes: string[]): Promise<"binance" | "rpc"> {
    if (mevProtect && this.#binance) {
      try {
        await this.#binance.broadcast({ binanceChainId: BINANCE_BSC, signedTransaction: signed, address: this.address, enableMevProtection: true });
        return "binance";
      } catch (err) {
        notes.push(`binance broadcast failed, sent through the public RPC: ${safeMessage(err)}`);
      }
    }
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      const m = safeMessage(err);
      // The Binance attempt may have reached the mempool already: the same bytes are then "known".
      if (!alreadyKnown(m)) throw new Error(`broadcast failed: ${m}`);
    }
    return "rpc";
  }

  /** A second broadcast of the same bytes, the way the first went (Binance first for a protected send). */
  async #rebroadcast(signed: Hex, viaBinance: boolean, notes: string[]) {
    if (viaBinance && this.#binance) {
      try {
        await this.#binance.broadcast({ binanceChainId: BINANCE_BSC, signedTransaction: signed, address: this.address, enableMevProtection: true });
        notes.push("rebroadcast through Binance with MEV protection");
        return;
      } catch (err) {
        notes.push(`binance rebroadcast failed (${safeMessage(err)}), sent through the public RPC`);
      }
    } else {
      notes.push("rebroadcast through the RPC");
    }
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      const m = safeMessage(err);
      if (!alreadyKnown(m)) notes.push(`rebroadcast failed: ${m}`);
    }
  }

  #remember(hash: Hex, family: Hex[]) {
    this.#families.set(hash.toLowerCase(), family);
    while (this.#families.size > FAMILY_MEMORY) this.#families.delete(this.#families.keys().next().value as string);
  }

  async confirm(txHash: Hex, nonce?: number): Promise<Confirmation> {
    // Latest first: a transaction mined between the two reads then shows its receipt instead of reading as dropped.
    const latest = nonce === undefined ? undefined : await this.#client.getTransactionCount({ address: this.address, blockTag: "latest" });
    const family = this.#families.get(txHash.toLowerCase()) ?? [txHash];
    for (const hash of family) {
      const r = await this.#receipt(hash);
      if (r) {
        return {
          status: r.status === "success" ? "success" : "reverted",
          txHash: hash,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          blockNumber: r.blockNumber,
          logs: logsOf(r),
        };
      }
    }
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
