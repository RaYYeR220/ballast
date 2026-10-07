// The desk's books: income (guardian payouts), gas spent on every broadcast transaction, and x402 data
// payments under a daily cap. Persisted as one JSON file in the data dir (<dataDir>/ledger.json), rewritten
// atomically on every change; amounts are decimal strings so nothing loses precision.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatUnits, type Address, type Hex } from "viem";
import type { TxRequest } from "@ballast/sdk";
import type { SendResult, TxSender } from "./tx";

export type LedgerSource = "publisher" | "keeper" | "guardian" | "x402" | "other";

interface Base {
  id: number;
  /** Unix seconds. */
  ts: number;
}

/** Gas paid for one broadcast transaction (reverted ones included). */
export interface GasEntry extends Base {
  kind: "gas";
  source: LedgerSource;
  txHash: Hex;
  status: "success" | "reverted";
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

  /** Appends an entry and persists the book. Returns the stored entry. */
  async record(input: LedgerInput): Promise<LedgerEntry> {
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

/**
 * Wraps a sender so every broadcast transaction with a receipt books its gas (reverted ones too). Ledger
 * failures never reach the caller: the send result is what the loop acts on.
 */
export function ledgerSender(inner: TxSender, ledger: Ledger, source: LedgerSource, onError?: (m: string) => void): TxSender {
  return {
    address: inner.address,
    dryRun: inner.dryRun,
    simulate: (tx: TxRequest) => inner.simulate(tx),
    async send(tx: TxRequest): Promise<SendResult> {
      const r = await inner.send(tx);
      if (r.ok && r.status !== "unknown" && r.gasUsed !== undefined && r.effectiveGasPrice !== undefined) {
        try {
          await ledger.record({
            kind: "gas",
            source,
            txHash: r.txHash,
            status: r.status,
            gasUsed: r.gasUsed.toString(),
            effectiveGasPrice: r.effectiveGasPrice.toString(),
            feeWei: (r.gasUsed * r.effectiveGasPrice).toString(),
          });
        } catch (err) {
          onError?.(`ledger gas entry failed: ${(err as Error).message}`);
        }
      }
      return r;
    },
  };
}
