// The desk's books: income (guardian payouts), gas spent on every broadcast transaction, and x402 data
// payments under a daily cap. Persisted as one JSON file in the data dir (<dataDir>/ledger.json), rewritten
// atomically on every change; amounts are decimal strings so nothing loses precision.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatUnits, type Address, type Hex } from "viem";
import type { TxRequest } from "@ballast/sdk";
import type { Confirmation, SendOptions, SendResult, SimulateOptions, TxBuilder, TxSender } from "./tx";

export type LedgerSource = "publisher" | "keeper" | "guardian" | "x402" | "other";

interface Base {
  id: number;
  /** Unix seconds. */
  ts: number;
}

/**
 * Gas paid for one nonce of the desk key: the transaction that was finally mined there (the intent, a
 * sale's stand-in or the cancel that replaced it), reverted ones included.
 */
export interface GasEntry extends Base {
  kind: "gas";
  source: LedgerSource;
  /** The mined transaction. */
  txHash: Hex;
  /** "cancelled": the nonce was spent on a 0-value cancel because the intent was no longer needed. */
  status: "success" | "reverted" | "cancelled";
  nonce?: number;
  /** Which transaction of the intent was mined. */
  minedAs?: "intent" | "fallback" | "cancel";
  gasUsed: string;
  effectiveGasPrice: string;
  /** gasUsed x effectiveGasPrice, in wei. */
  feeWei: string;
}

/** A guardian job payout to the desk. */
export interface IncomeEntry extends Base {
  kind: "income";
  source: "guardian";
  jobId: string;
  token: Address;
  symbol: string;
  amount: string;
  decimals: number;
  /** USD value for stablecoins, null otherwise. */
  usd: number | null;
  outcome: "complete" | "reject";
  txHash?: Hex;
  /** True when the amount is the job budget rather than a transfer read from our own settle receipt. */
  estimated?: boolean;
}

/** An x402 payment. Counted against the daily cap from the moment it is signed. */
export interface X402Entry extends Base {
  kind: "x402";
  source: "x402";
  /** Scheme, host and path only (no query). */
  resource: string;
  network: string;
  asset: Address;
  symbol: string;
  amount: string;
  usd: number;
  payTo: Address;
  status: "signed" | "settled" | "failed";
  txHash?: string;
  note?: string;
}

export type LedgerEntry = GasEntry | IncomeEntry | X402Entry;
export type LedgerInput = Omit<GasEntry, "id" | "ts"> | Omit<IncomeEntry, "id" | "ts"> | Omit<X402Entry, "id" | "ts">;

const FILE = "ledger.json";
const MAX_ENTRIES = 20_000;
const STABLES = new Set(["USD1", "U", "USDT", "USDC"]);

/** USD value of an amount of a known stablecoin, else null. */
export function stableUsd(symbol: string, amount: bigint, decimals: number): number | null {
  return STABLES.has(symbol.toUpperCase()) ? Number(formatUnits(amount, decimals)) : null;
}

const utcDay = (ts: number) => Math.floor(ts / 86_400);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface LedgerSummary {
  incomeUsd: number;
  x402Usd: number;
  gasWei: string;
  gasBnb: string;
  transactions: number;
  jobsPaid: number;
}

export interface LedgerOptions {
  dir: string;
  /** Daily x402 ceiling in USD (UTC day). */
  x402DailyCapUsd: number;
  clock?: () => number;
  onError?: (message: string) => void;
}

export class Ledger {
  readonly file: string;
  readonly capUsd: number;
  readonly #dir: string;
  readonly #clock: () => number;
  readonly #onError: (message: string) => void;
  #entries: LedgerEntry[] = [];
  #nextId = 1;
  #writes: Promise<void> = Promise.resolve();

  constructor(o: LedgerOptions) {
    this.#dir = o.dir;
    this.file = path.join(o.dir, FILE);
    this.capUsd = o.x402DailyCapUsd;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#onError = o.onError ?? ((m) => console.error(m));
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#onError(`ledger load failed: ${(err as Error).message}`);
      return;
    }
    try {
      const j = JSON.parse(text) as { entries?: LedgerEntry[] };
      this.#entries = Array.isArray(j.entries) ? j.entries.filter((e) => e && typeof e.id === "number" && typeof e.kind === "string") : [];
      this.#nextId = this.#entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    } catch (err) {
      // Keep the unreadable file aside rather than overwrite it on the next save.
      this.#onError(`ledger file unreadable, starting empty and keeping it as ${FILE}.bad: ${(err as Error).message}`);
      await rename(this.file, `${this.file}.bad`).catch(() => undefined);
    }
  }

  /**
   * Appends an entry and persists the book. Returns the stored entry. A guardian job is booked once: a second
   * income entry for the same jobId (a rescan after lost state, a retry) returns the first and adds nothing.
   */
  async record(input: LedgerInput): Promise<LedgerEntry> {
    if (input.kind === "income") {
      const booked = this.#entries.find((e) => e.kind === "income" && e.jobId === input.jobId);
      if (booked) return booked;
    }
    if (input.kind === "gas") {
      // A mined transaction is booked once, whoever reports it and however often (also across restarts).
      const hash = input.txHash.toLowerCase();
      const booked = this.#entries.find((e) => e.kind === "gas" && e.txHash.toLowerCase() === hash);
      if (booked) return booked;
    }
    const entry = { id: this.#nextId++, ts: this.#clock(), ...input } as LedgerEntry;
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    await this.#save();
    return entry;
  }

  /** Updates an x402 entry (settled with its transaction, or failed). */
  async updateX402(id: number, patch: Partial<Pick<X402Entry, "status" | "txHash" | "note">>): Promise<void> {
    const e = this.#entries.find((x) => x.id === id);
    if (!e || e.kind !== "x402") return;
    Object.assign(e, patch);
    await this.#save();
  }

  /** x402 spend counted today (UTC), failed payments included: once signed, a payment may still settle. */
  x402SpentToday(now = this.#clock()): number {
    const day = utcDay(now);
    let usd = 0;
    for (const e of this.#entries) if (e.kind === "x402" && utcDay(e.ts) === day) usd += e.usd;
    return round6(usd);
  }

  /** True when paying `usd` now keeps today's x402 spend within the cap. */
  x402Allows(usd: number, now = this.#clock()): boolean {
    return Number.isFinite(usd) && usd >= 0 && this.x402SpentToday(now) + usd <= this.capUsd + 1e-9;
  }

  /** Newest first. */
  list(q: { kind?: LedgerEntry["kind"]; limit?: number } = {}): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    const limit = q.limit ?? Number.POSITIVE_INFINITY;
    for (let i = this.#entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.#entries[i] as LedgerEntry;
      if (!q.kind || e.kind === q.kind) out.push(e);
    }
    return out;
  }

  /** Totals over all entries, or those since `since` (unix seconds). */
  summary(since = 0): LedgerSummary {
    let incomeUsd = 0;
    let x402Usd = 0;
    let gasWei = 0n;
    let transactions = 0;
    let jobsPaid = 0;
    for (const e of this.#entries) {
      if (e.ts < since) continue;
      if (e.kind === "income") {
        incomeUsd += e.usd ?? 0;
        if (BigInt(e.amount) > 0n) jobsPaid++;
      } else if (e.kind === "x402") {
        x402Usd += e.usd;
      } else {
        gasWei += BigInt(e.feeWei);
        transactions++;
      }
    }
    return { incomeUsd: round6(incomeUsd), x402Usd: round6(x402Usd), gasWei: gasWei.toString(), gasBnb: formatUnits(gasWei, 18), transactions, jobsPaid };
  }

  /** Resolves once every pending write has reached the disk (or failed). */
  flush(): Promise<void> {
    return this.#writes;
  }

  #save(): Promise<void> {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write;
    return write;
  }

  async #write(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, entries: this.#entries }, null, 1)}\n`, "utf8");
      await rename(tmp, this.file);
    } catch (err) {
      this.#onError(`ledger write failed (kept in memory): ${(err as Error).message}`);
    }
  }
}

/** What a send, recover or confirm result says about a mined transaction. */
export interface MinedReport {
  txHash?: Hex;
  nonce?: number;
  status: string;
  minedAs?: "intent" | "fallback" | "cancel";
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

/**
 * Books the gas of the desk key, once per nonce: only a result that names the mined transaction (its hash,
 * gas used and effective gas price) is booked, under the hash that was finally mined at that nonce. An intent
 * that was replaced a few times costs what its mined replacement cost; a nonce spent on a cancel is booked
 * as "cancelled". One book is shared by every loop's sender wrapper, so a transaction reported twice (by a
 * send and a later confirm, or by the startup recovery and a loop) is still one entry.
 *
 * A send that ends pending (the sender halted on it) is followed: the sender may settle that nonce later
 * inside another loop's send, where nobody sees the result, so the book asks confirm() about it before each
 * later send until it is mined or lost, and books it under the loop that sent it.
 */
export class GasBook {
  readonly #ledger: Ledger;
  readonly #onError: (m: string) => void;
  /** nonce -> the hash booked for it in this process. */
  readonly #nonces = new Map<number, string>();
  /** nonce -> a send that ended pending and is not booked yet. */
  readonly #open = new Map<number, { source: LedgerSource; txHash: Hex }>();

  constructor(ledger: Ledger, onError: (m: string) => void = (m) => console.error(m)) {
    this.#ledger = ledger;
    this.#onError = onError;
  }

  /** Remembers a send that ended pending, to book its nonce once it is mined. */
  follow(source: LedgerSource, nonce: number, txHash: Hex): void {
    if (!this.#nonces.has(nonce) && !this.#open.has(nonce)) this.#open.set(nonce, { source, txHash });
    if (this.#open.size > 1_000) this.#open.delete(this.#open.keys().next().value as number);
  }

  /** Asks about every followed send and books the ones that were mined; lost ones are let go. Never throws. */
  async settle(confirm: (txHash: Hex, nonce?: number) => Promise<Confirmation>): Promise<void> {
    for (const [nonce, o] of [...this.#open]) {
      let c: Confirmation;
      try {
        c = await confirm(o.txHash, nonce);
      } catch {
        continue; // unreadable right now: asked again later
      }
      if (c.status === "pending") continue;
      this.#open.delete(nonce);
      await this.book(o.source, { ...c, txHash: c.txHash ?? o.txHash, nonce });
    }
  }

  /** Never throws: the send result is what the loop acts on, not the bookkeeping. */
  async book(source: LedgerSource, r: MinedReport): Promise<void> {
    if (!r.txHash || r.gasUsed === undefined || r.effectiveGasPrice === undefined) return; // not mined (or not ours)
    const status = r.minedAs === "cancel" ? "cancelled" : r.status === "success" || r.status === "reverted" ? r.status : null;
    if (status === null) return;
    const hash = r.txHash.toLowerCase();
    if (r.nonce !== undefined) {
      // A nonce one loop left pending and another one saw mined belongs to the loop that sent it.
      const sentBy = this.#open.get(r.nonce);
      if (sentBy) {
        source = sentBy.source;
        this.#open.delete(r.nonce);
      }
      const seen = this.#nonces.get(r.nonce);
      if (seen !== undefined) {
        if (seen !== hash) this.#onError(`ledger: nonce ${r.nonce} was already booked as ${seen}, ignoring ${hash}`);
        return;
      }
      this.#nonces.set(r.nonce, hash);
      if (this.#nonces.size > 10_000) this.#nonces.delete(this.#nonces.keys().next().value as number);
    }
    try {
      await this.#ledger.record({
        kind: "gas",
        source,
        txHash: r.txHash,
        status,
        ...(r.nonce !== undefined ? { nonce: r.nonce } : {}),
        ...(r.minedAs ? { minedAs: r.minedAs } : {}),
        gasUsed: r.gasUsed.toString(),
        effectiveGasPrice: r.effectiveGasPrice.toString(),
        feeWei: (r.gasUsed * r.effectiveGasPrice).toString(),
      });
    } catch (err) {
      this.#onError(`ledger gas entry failed: ${(err as Error).message}`);
    }
  }
}

/**
 * The sender as one loop sees it: the same sender (every call and option passed through, optional calls only
 * when the sender has them) with its mined transactions booked under that loop's name.
 */
export function ledgerSender(inner: TxSender, book: GasBook, source: LedgerSource): TxSender {
  const wrapped: TxSender = {
    address: inner.address,
    dryRun: inner.dryRun,
    simulate: (tx: TxRequest, opts?: SimulateOptions) => inner.simulate(tx, opts),
    async send(tx: TxRequest | TxBuilder, opts?: SendOptions): Promise<SendResult> {
      if (inner.confirm) await book.settle(inner.confirm.bind(inner));
      const r = await inner.send(tx, opts);
      if (r.ok) {
        if (r.status === "pending") book.follow(source, r.nonce, r.txHash);
        else await book.book(source, r);
      }
      return r;
    },
  };
  if (inner.recover) {
    const recover = inner.recover.bind(inner);
    wrapped.recover = async (): Promise<unknown> => {
      const r = (await recover()) as SendResult | null | undefined;
      // What was in flight and is settled now: booked here, since no send will ever return it.
      if (r && typeof r === "object" && r.ok === true) {
        if (r.status === "pending") book.follow(source, r.nonce, r.txHash);
        else await book.book(source, r);
      }
      return r;
    };
  }
  if (inner.confirm) {
    const confirm = inner.confirm.bind(inner);
    wrapped.confirm = async (txHash: Hex, nonce?: number): Promise<Confirmation> => {
      const c = await confirm(txHash, nonce);
      // The mined hash may be a replacement of the one asked about.
      await book.book(source, { ...c, txHash: c.txHash ?? txHash, ...(nonce !== undefined ? { nonce } : {}) });
      return c;
    };
  }
  if (inner.balance) wrapped.balance = inner.balance.bind(inner);
  if (inner.state) wrapped.state = inner.state.bind(inner);
  return wrapped;
}
