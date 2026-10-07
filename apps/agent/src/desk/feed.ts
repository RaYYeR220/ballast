// The desk's audit feed: every publisher and keeper attempt, appended as one JSON line to
// <dataDir>/feed.jsonl and kept in a bounded in-memory ring for the read API.
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import type { Address, Hex } from "viem";

export type FeedKind = "shield" | "restore" | "refused" | "alert" | "noop" | "publish" | "finding" | "submit" | "settle" | "payment";
export type FeedSource = "keeper" | "publisher" | "guardian" | "x402";

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
  /** ERC-8183 kernel job id (guardian events). */
  jobId?: string;
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
  /** Strings that must never reach the feed (RPC URL, API keys): replaced by "[redacted]". */
  secrets?: readonly string[];
  /** Unix seconds. */
  clock?: () => number;
  onError?: (message: string) => void;
}

const FILE = "feed.jsonl";
/** How much of the file's tail load() reads back. */
const TAIL_BYTES = 4 * 1024 * 1024;

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();

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
    this.#secrets = [...new Set((o.secrets ?? []).filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
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
   * Debt (loan-token units) before the first broadcast shield since the account's last broadcast restore:
   * the level a restore borrows back toward. Null when no shield cycle is open.
   */
  preShieldDebt(account: string): bigint | null {
    let found: bigint | null = null;
    for (let i = this.#ring.length - 1; i >= 0; i--) {
      const e = this.#ring[i] as FeedEvent;
      if (!same(e.account, account) || !e.txHash || e.cover) continue;
      if (e.kind === "restore") break;
      const before = e.kind === "shield" ? e.plan?.debtBefore : undefined;
      if (typeof before === "string" && /^\d+$/.test(before)) found = BigInt(before);
    }
    return found;
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
