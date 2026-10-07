// The desk's audit feed: every publisher and keeper attempt, appended as one JSON line to
// <dataDir>/feed.jsonl and kept in a bounded in-memory ring for the read API.
//
// Events are plain data and the read API serves them as stored. Never put a viem client, chain, transport,
// config or account object into an event (they carry the RPC URL and keys); pass amounts, names and hashes.
// As a second line of defence every line is scrubbed of the configured secrets before it is kept.
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import type { Address, Hex } from "viem";

export type FeedKind = "shield" | "restore" | "refused" | "alert" | "noop" | "publish" | "finding" | "pending";
export type FeedSource = "keeper" | "publisher";

/** A revert or failure as the feed shows it: decoded name, one readable sentence, stringified args. */
export interface FeedError {
  name: string;
  message: string;
  args?: string[];
  /** Oracle reason for RestoreRefused. */
  reason?: string;
}

export interface FeedSim {
  /** Which simulator answered: the Binance Transaction API or an eth_call on our RPC. */
  via: "binance" | "rpc";
  ok: boolean;
  error?: FeedError;
  note?: string;
  /** Binance simulate and eth_call disagreed. */
  disagree?: boolean;
}

export interface FeedWindow {
  kind: string;
  startsAt: number;
  endsAt: number;
  gapBps: number;
}

export interface FeedEvent {
  seq: number;
  /** Unix seconds. */
  ts: number;
  kind: FeedKind;
  source: FeedSource;
  /** Ballast account, or the user of a CushionVault cover. */
  account?: Address;
  cover?: { user: Address; key: Hex };
  symbol?: string;
  symbols?: string[];
  window?: FeedWindow;
  /** Plan summary (amounts as decimal strings). Keeper events carry plan.debtBefore for restores. */
  plan?: Record<string, unknown>;
  sim?: FeedSim;
  txHash?: Hex;
  reason?: string;
  error?: FeedError;
  /** True when DRY_RUN stopped the send after a successful simulation. */
  dryRun?: boolean;
  data?: Record<string, unknown>;
}

export type FeedInput = Omit<FeedEvent, "seq" | "ts"> & { ts?: number };

export interface FeedOptions {
  dir: string;
  ringSize?: number;
  /** Strings that must never reach the feed (RPC URL, keys, API secrets): replaced by "[redacted]". */
  secrets: readonly string[];
  /** Unix seconds. */
  clock?: () => number;
  onError?: (message: string) => void;
}

export interface ShieldCycle {
  /** Debt before the first confirmed shield of the cycle, loan-token units. */
  preShieldDebt: bigint;
  /** LTV before that shield, bps (null when it was not known). */
  preShieldLtvBps: number | null;
  /** Debt read right after the latest confirmed shield (null when that read failed). */
  postShieldDebt: bigint | null;
  /** What the keeper itself repaid in the cycle: the sum of debtBefore - debtAfter. */
  repaid: bigint;
  shields: number;
}

const FILE = "feed.jsonl";
/** How much of the file's tail load() reads back. */
const TAIL_BYTES = 4 * 1024 * 1024;

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();
const uint = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

export class Feed {
  readonly file: string;
  readonly #dir: string;
  readonly #ringSize: number;
  readonly #secrets: string[];
  readonly #clock: () => number;
  readonly #onError: (message: string) => void;
  #ring: FeedEvent[] = [];
  #seq = 0;
  #writes: Promise<void> = Promise.resolve();
  #dirReady = false;

  constructor(o: FeedOptions) {
    this.#dir = o.dir;
    this.file = path.join(o.dir, FILE);
    this.#ringSize = o.ringSize ?? 5000;
    // Longest first so a secret that contains another is replaced whole.
    this.#secrets = [...new Set(o.secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#onError = o.onError ?? ((m) => console.error(m));
  }

  /** Reads the tail of the JSONL file back into the ring (call once at startup). */
  async load(): Promise<void> {
    let text = "";
    try {
      const { size } = await stat(this.file);
      const from = Math.max(0, size - TAIL_BYTES);
      const fh = await open(this.file, "r");
      try {
        const buf = Buffer.alloc(size - from);
        await fh.read(buf, 0, buf.length, from);
        text = buf.toString("utf8");
        if (from > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#onError(`feed load failed: ${(err as Error).message}`);
      return;
    }
    const events: FeedEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as FeedEvent;
        if (typeof e.seq === "number" && typeof e.kind === "string") events.push(e);
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    this.#ring = events.slice(-this.#ringSize);
    this.#seq = events.reduce((m, e) => Math.max(m, e.seq), this.#seq);
  }

  /** Stores one event (scrubbed, bigints as strings) and resolves once it is on disk or the write failed. */
  async record(input: FeedInput): Promise<FeedEvent> {
    const { ts, ...rest } = input;
    const raw: FeedEvent = { seq: ++this.#seq, ts: ts ?? this.#clock(), ...rest };
    const line = this.#scrub(JSON.stringify(raw, bigintSafe));
    const event = JSON.parse(line) as FeedEvent;
    this.#ring.push(event);
    if (this.#ring.length > this.#ringSize) this.#ring.splice(0, this.#ring.length - this.#ringSize);
    const write = this.#writes.then(() => this.#append(`${line}\n`));
    this.#writes = write;
    await write;
    return event;
  }

  /** Newest first. */
  list(q: { account?: string; kind?: FeedKind; source?: FeedSource; limit?: number } = {}): FeedEvent[] {
    const out: FeedEvent[] = [];
    const limit = q.limit ?? Number.POSITIVE_INFINITY;
    for (let i = this.#ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.#ring[i] as FeedEvent;
      if (q.account && !same(e.account, q.account)) continue;
      if (q.kind && e.kind !== q.kind) continue;
      if (q.source && e.source !== q.source) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * The account's open shield cycle: the confirmed keeper shields since its last confirmed restore (or since
   * the keeper closed the cycle). Null when there is none.
   */
  shieldCycle(account: string): ShieldCycle | null {
    const shields: { before: bigint; after: bigint | null; ltv: number | null }[] = [];
    for (let i = this.#ring.length - 1; i >= 0; i--) {
      const e = this.#ring[i] as FeedEvent;
      if (!same(e.account, account) || e.cover || e.source !== "keeper") continue;
      if (e.kind === "restore" && e.txHash) break;
      if (e.data?.cycleClosed === true) break;
      if (e.kind !== "shield" || !e.txHash || e.dryRun) continue;
      const before = uint(e.plan?.debtBefore);
      if (before === null) continue;
      const ltv = e.plan?.ltvBps;
      shields.push({ before, after: uint(e.plan?.debtAfter), ltv: typeof ltv === "number" && Number.isFinite(ltv) ? ltv : null });
    }
    const first = shields[shields.length - 1];
    if (!first) return null;
    let repaid = 0n;
    for (const s of shields) if (s.after !== null && s.before > s.after) repaid += s.before - s.after;
    return { preShieldDebt: first.before, preShieldLtvBps: first.ltv, postShieldDebt: (shields[0] as (typeof shields)[0]).after, repaid, shields: shields.length };
  }

  /** Debt before the first shield of the open cycle: the most a restore borrows back toward. */
  preShieldDebt(account: string): bigint | null {
    return this.shieldCycle(account)?.preShieldDebt ?? null;
  }

  /**
   * `pending` events of `source` whose transaction no later event resolved, oldest first. A resolving event
   * names it by its txHash or, when a speed-up was mined instead, by `data.pendingTx`.
   */
  unresolvedPending(source: FeedSource): FeedEvent[] {
    const open = new Map<string, FeedEvent>();
    for (const e of this.#ring) {
      const pendingTx = typeof e.data?.pendingTx === "string" ? e.data.pendingTx.toLowerCase() : null;
      if (e.kind === "pending" && e.source === source && e.txHash) {
        open.set(e.txHash.toLowerCase(), e);
        continue;
      }
      if (e.txHash) open.delete(e.txHash.toLowerCase());
      if (pendingTx) open.delete(pendingTx);
    }
    return [...open.values()];
  }

  #scrub(s: string): string {
    let out = s;
    for (const secret of this.#secrets) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      out = out.split(encoded).join("[redacted]");
    }
    return out;
  }

  async #append(text: string): Promise<void> {
    try {
      if (!this.#dirReady) {
        await mkdir(this.#dir, { recursive: true });
        this.#dirReady = true;
      }
      await appendFile(this.file, text, "utf8");
    } catch (err) {
      this.#onError(`feed write failed (event kept in memory): ${(err as Error).message}`);
    }
  }
}

/**
 * Counts Binance simulate / eth_call disagreements for one loop. Three within a day make one `finding`
 * (at most one per day): the two simulators should agree, and a pattern means one of them is off.
 */
export class DisagreementWatch {
  #seen: number[] = [];
  #reportedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly feed: Feed,
    private readonly source: FeedSource,
  ) {}

  async note(sim: FeedSim, at: number, context: Record<string, unknown> = {}): Promise<void> {
    if (!sim.disagree) return;
    this.#seen = this.#seen.filter((t) => t > at - 86_400);
    this.#seen.push(at);
    if (this.#seen.length < 3 || at - this.#reportedAt < 86_400) return;
    this.#reportedAt = at;
    await this.feed.record({
      kind: "finding",
      source: this.source,
      reason: `Binance simulate and eth_call disagreed ${this.#seen.length} times in 24 h; the last one: ${sim.error?.message ?? sim.note ?? "no detail"}`,
      data: { count: this.#seen.length, ...context },
    });
  }
}
