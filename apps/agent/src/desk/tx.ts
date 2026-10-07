// Simulation and broadcast for the desk key. Every write is simulated first: through the Binance
// Transaction API when a key is configured on BSC mainnet, else with eth_call on our RPC. Sends are signed
// locally, serialized through one nonce manager per key, and broadcast through the Binance Transaction API
// with MEV protection when keyed, else straight to the RPC. Raw signed transactions never leave this module.
import { decodeBallastError, isRevert, type TxRequest } from "@ballast/sdk";
import { transaction, type Web3Client } from "@ballast/binance";
import { keccak256, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import type { FeedError, FeedSim } from "./feed";

/** The subset of a viem PublicClient the sender uses. */
export type SenderClient = Pick<
  PublicClient,
  "call" | "estimateGas" | "getGasPrice" | "getTransactionCount" | "sendRawTransaction" | "waitForTransactionReceipt"
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
const RECEIPT_TIMEOUT_MS = 120_000;

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

// ------------------------------------------------------------------- nonces

/**
 * Serializes every send of one key and hands out nonces. Each run starts from max(chain pending nonce,
 * the next nonce this process already used), so a send by another component sharing the key is picked up.
 */
export class NonceManager {
  #queue: Promise<unknown> = Promise.resolve();
  #next: number | null = null;

  constructor(private readonly pending: () => Promise<number>) {}

  run<T>(fn: (nonce: number) => Promise<{ consumed: boolean; value: T }>): Promise<T> {
    const job = this.#queue.then(async () => {
      const chain = await this.pending();
      const nonce = this.#next === null ? chain : Math.max(chain, this.#next);
      try {
        const r = await fn(nonce);
        this.#next = r.consumed ? nonce + 1 : nonce;
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
export function nonceManagerFor(address: Address, pending: () => Promise<number>): NonceManager {
  const k = address.toLowerCase();
  let m = managers.get(k);
  if (!m) {
    m = new NonceManager(pending);
    managers.set(k, m);
  }
  return m;
}

// ------------------------------------------------------------------- sender

export type SendResult =
  | {
      ok: true;
      txHash: Hex;
      via: "binance" | "rpc";
      /** "unknown" when no receipt arrived in time. */
      status: "success" | "reverted" | "unknown";
      gasUsed?: bigint;
      effectiveGasPrice?: bigint;
      blockNumber?: bigint;
      note?: string;
    }
  | { ok: false; stage: "estimate"; error: FeedError };

/** What the loops need: simulate, send, the sender address and the DRY_RUN switch. */
export interface TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  simulate(tx: TxRequest): Promise<FeedSim>;
  send(tx: TxRequest): Promise<SendResult>;
}

export interface ChainSenderOptions {
  client: SenderClient;
  account: LocalAccount;
  chainId: number;
  dryRun: boolean;
  /** Keyed Binance Transaction API; null or absent means RPC only. */
  binance?: BinanceTxApi | null;
  nonces?: NonceManager;
}

export class ChainSender implements TxSender {
  readonly address: Address;
  readonly dryRun: boolean;
  readonly #client: SenderClient;
  readonly #account: LocalAccount;
  readonly #chainId: number;
  readonly #binance: BinanceTxApi | null;
  readonly #nonces: NonceManager;

  constructor(o: ChainSenderOptions) {
    this.#client = o.client;
    this.#account = o.account;
    this.address = o.account.address;
    this.#chainId = o.chainId;
    this.dryRun = o.dryRun;
    // Binance simulates and broadcasts against BSC mainnet only: never for a fork or testnet.
    this.#binance = o.chainId === 56 ? (o.binance ?? null) : null;
    this.#nonces = o.nonces ?? nonceManagerFor(this.address, () => this.#client.getTransactionCount({ address: this.address, blockTag: "pending" }));
  }

  async simulate(tx: TxRequest): Promise<FeedSim> {
    if (this.#binance) {
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
      if (r.status === "SUCCESS") return { via: "binance", ok: true };
      // Binance reports a reason string; replay on the RPC for the decoded custom error. When the replay
      // succeeds the two simulators disagree: eth_call against the head decides, and the note keeps both.
      const reason = r.failReason ?? "simulation failed";
      let replay: FeedSim;
      try {
        replay = await this.#rpcSimulate(tx);
      } catch {
        return { via: "binance", ok: false, error: { name: "SimulationFailed", message: reason } };
      }
      if (replay.ok) return { via: "rpc", ok: true, note: `binance simulate reported FAILED (${reason}) but eth_call succeeded` };
      return { via: "binance", ok: false, error: replay.error ?? { name: "SimulationFailed", message: reason } };
    }
    return this.#rpcSimulate(tx);
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

  send(tx: TxRequest): Promise<SendResult> {
    if (this.dryRun) return Promise.reject(new Error("DRY_RUN is on: simulate only, nothing is sent"));
    return this.#nonces.run(async (nonce) => {
      let gas: bigint;
      try {
        gas = await this.#client.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value });
      } catch (err) {
        const error = revertError(err);
        if (!error) throw err;
        return { consumed: false, value: { ok: false, stage: "estimate", error } as SendResult };
      }
      const gasPrice = await this.#client.getGasPrice();
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
      let via: "binance" | "rpc" = "rpc";
      let note: string | undefined;
      if (this.#binance) {
        try {
          await this.#binance.broadcast({ binanceChainId: BINANCE_BSC, signedTransaction: signed, address: this.address, enableMevProtection: true });
          via = "binance";
        } catch (err) {
          note = `binance broadcast failed, sent through the RPC: ${safeMessage(err)}`;
        }
      }
      if (via === "rpc") {
        try {
          await this.#client.sendRawTransaction({ serializedTransaction: signed });
        } catch (err) {
          const m = safeMessage(err);
          // The Binance attempt may have reached the mempool already: the same bytes are then "known".
          if (!/already known|known transaction/i.test(m)) throw new Error(`broadcast failed: ${m}`);
        }
      }
      try {
        const r = await this.#client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
        const value: SendResult = {
          ok: true,
          txHash,
          via,
          status: r.status === "success" ? "success" : "reverted",
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
          blockNumber: r.blockNumber,
        };
        if (note) value.note = note;
        return { consumed: true, value };
      } catch (err) {
        const value: SendResult = { ok: true, txHash, via, status: "unknown", note: [note, `no receipt yet: ${safeMessage(err)}`].filter(Boolean).join("; ") };
        return { consumed: true, value };
      }
    });
  }
}
