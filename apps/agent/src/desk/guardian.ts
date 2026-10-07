// Guardian loop. Every 10 min: scan new ERC-8183 kernel jobs whose evaluator is the Ballast guardian and
// whose provider is this desk (a persisted cursor over job ids), refresh the ones still open, and once a
// job's guarded window is over: submit the evidence hash (keccak256 of the feed events for that account in
// [start, end], kept under <dataDir>/evidence/<jobId>.json), then settle it on the guardian. The guardian
// pays the desk only if the account was never liquidated and is healthy; CannotEvaluateNow (health unknown,
// e.g. while the venue cannot price) is retried on the next loop, never forced. Outcomes go to the ledger.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ballastGuardianAbi,
  guardianJobs,
  kernelAbi,
  readGuardianJobs,
  writes,
  type Deployment,
  type GuardianJob,
  type GuardianJobsPage,
  type ReadClient,
  type TxRequest,
} from "@ballast/sdk";
import { erc20Abi, keccak256, parseEventLogs, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import type { Feed, FeedError, FeedEvent, FeedInput, FeedSim } from "./feed";
import { stableUsd, type Ledger } from "./ledger";
import { safeMessage, type SendResult, type TxSender } from "./tx";

export const GUARDIAN_TICK_SEC = 600;
/** Job ids scanned per call, and calls per tick (later ids wait for the next tick). */
export const SCAN_LIMIT = 1000;
export const MAX_SCAN_PAGES = 5;
/** After a refused submit or settle (other than CannotEvaluateNow), leave the job alone this long. */
export const REFUSAL_BACKOFF_SEC = 30 * 60;
/** A repeated identical wait (e.g. CannotEvaluateNow every loop) is re-recorded in the feed at most this often. */
export const REPEAT_EVENT_SEC = 3600;

// ------------------------------------------------------------------ reads

export interface PaymentToken {
  token: Address;
  symbol: string;
  decimals: number;
}

export interface SettleOutcome {
  /** From the guardian's Settled event; null when the receipt carries none. */
  survived: boolean | null;
  /** Payment token sent to the desk in that transaction. */
  paid: bigint;
}

export interface GuardianReads {
  /** Head block timestamp. */
  now(): Promise<number>;
  scan(fromJobId: bigint, provider: Address, limit: number): Promise<GuardianJobsPage>;
  refresh(ids: readonly bigint[]): Promise<GuardianJob[]>;
  paymentToken(jobId: bigint): Promise<PaymentToken>;
  settleOutcome(txHash: Hex, jobId: bigint, token: Address, to: Address): Promise<SettleOutcome>;
}

type GuardianClient = ReadClient & Pick<PublicClient, "getTransactionReceipt">;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Guardian reads over the deployment with the SDK (pass the desk client: cacheTime 0). */
export function chainGuardianReads(c: GuardianClient, d: Deployment): GuardianReads {
  const tokens = new Map<string, Promise<{ symbol: string; decimals: number }>>();
  const tokenInfo = (token: Address) => {
    const k = token.toLowerCase();
    let p = tokens.get(k);
    if (!p) {
      p = Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
        c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      ]).then(([symbol, decimals]) => ({ symbol, decimals }));
      p.catch(() => tokens.delete(k));
      tokens.set(k, p);
    }
    return p;
  };
  return {
    now: async () => Number((await c.getBlock({ blockTag: "latest" })).timestamp),
    scan: (fromJobId, provider, limit) => guardianJobs(c, d, { fromJobId, provider, limit }),
    refresh: (ids) => readGuardianJobs(c, d, ids),
    async paymentToken(jobId) {
      const token = await c.readContract({ address: d.external.kernel, abi: kernelAbi, functionName: "jobPaymentToken", args: [jobId] });
      return { token, ...(await tokenInfo(token)) };
    },
    async settleOutcome(txHash, jobId, token, to) {
      const r = await c.getTransactionReceipt({ hash: txHash });
      const settled = parseEventLogs({ abi: ballastGuardianAbi, eventName: "Settled", logs: r.logs }).find(
        (l) => same(l.address, d.guardian) && l.args.jobId === jobId,
      );
      const paid = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: r.logs })
        .filter((l) => same(l.address, token) && same(l.args.to, to))
        .reduce((s, l) => s + l.args.value, 0n);
      return { survived: settled ? settled.args.survived : null, paid };
    },
  };
}

// --------------------------------------------------------------- evidence

export interface EvidenceInput {
  chainId: number;
  kernel: Address;
  guardian: Address;
  agent: Address;
  jobId: bigint;
  account: Address;
  start: number;
  end: number;
  /** Every feed event the desk holds for the account (any order); the window filter is applied here. */
  events: readonly FeedEvent[];
}

/**
 * The evidence a guardian job is submitted with: the desk's own feed events for the guarded account inside
 * the window, oldest first, in a fixed key order. The deliverable is keccak256 of these exact bytes.
 */
export function buildEvidence(i: EvidenceInput): { json: string; hash: Hex } {
  const events = i.events
    .filter((e) => e.account !== undefined && same(e.account, i.account) && e.ts >= i.start && e.ts <= i.end)
    .sort((a, b) => a.seq - b.seq);
  const doc = {
    kind: "ballast-guardian-evidence",
    version: 1,
    chainId: i.chainId,
    kernel: i.kernel,
    guardian: i.guardian,
    agent: i.agent,
    jobId: i.jobId.toString(),
    account: i.account,
    window: { start: i.start, end: i.end },
    events,
  };
  const json = `${JSON.stringify(doc, null, 1)}\n`;
  return { json, hash: keccak256(stringToBytes(json)) };
}

export const evidenceFile = (dir: string, jobId: bigint | string) => path.join(dir, "evidence", `${jobId.toString()}.json`);

// ------------------------------------------------------------------ state

interface JobRecord {
  firstSeen: number;
  deliverable?: Hex;
  submitTx?: Hex;
  settleTx?: Hex;
}

interface StateFile {
  cursor: string;
  jobs: Record<string, JobRecord>;
}

/** The scan cursor and the open jobs, in <dataDir>/guardian.json. */
export class GuardianState {
  readonly file: string;
  cursor: bigint | null = null;
  jobs = new Map<string, JobRecord>();
  readonly #onError: (m: string) => void;
  #writes: Promise<void> = Promise.resolve();

  constructor(dir: string, onError: (m: string) => void = (m) => console.error(m)) {
    this.file = path.join(dir, "guardian.json");
    this.#onError = onError;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#onError(`guardian state load failed: ${(err as Error).message}`);
      return;
    }
    try {
      const j = JSON.parse(text) as StateFile;
      if (typeof j.cursor === "string" && /^\d+$/.test(j.cursor)) this.cursor = BigInt(j.cursor);
      this.jobs = new Map(Object.entries(j.jobs ?? {}).filter(([k]) => /^\d+$/.test(k)));
    } catch (err) {
      // Never silently restart the scan from the deployment: keep the bad file and start from it on purpose.
      this.#onError(`guardian state unreadable, kept as guardian.json.bad: ${(err as Error).message}`);
      await rename(this.file, `${this.file}.bad`).catch(() => undefined);
    }
  }

  save(): Promise<void> {
    const body: StateFile = { cursor: (this.cursor ?? 0n).toString(), jobs: Object.fromEntries(this.jobs) };
    const write = this.#writes.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, `${JSON.stringify(body, null, 1)}\n`, "utf8");
        await rename(`${this.file}.tmp`, this.file);
      } catch (err) {
        this.#onError(`guardian state write failed: ${(err as Error).message}`);
      }
    });
    this.#writes = write;
    return write;
  }
}

// ---------------------------------------------------------------- guardian

export interface GuardianOptions {
  deployment: Deployment;
  reads: GuardianReads;
  sender: TxSender;
  feed: Feed;
  ledger: Ledger;
  state: GuardianState;
  /** Data dir: evidence files go to <dataDir>/evidence/. */
  dataDir: string;
  log?: (line: string) => void;
}

export interface GuardianReport {
  at: number;
  cursor: string;
  head: string;
  open: number;
  submitted: string[];
  settled: string[];
  errors: string[];
}

export class Guardian {
  readonly #o: GuardianOptions;
  readonly #me: Address;
  readonly #backoff = new Map<string, number>();
  readonly #waits = new Map<string, { key: string; at: number }>();

  constructor(o: GuardianOptions) {
    this.#o = o;
    this.#me = o.sender.address;
  }

  async tick(): Promise<GuardianReport> {
    const { reads, state, deployment } = this.#o;
    const at = await reads.now();
    const report: GuardianReport = { at, cursor: "0", head: "0", open: 0, submitted: [], settled: [], errors: [] };

    // 1. New jobs for this provider since the cursor (persisted; first run starts at the guardian's deployment).
    let cursor = state.cursor ?? deployment.guardianStartJobId ?? 0n;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const p = await reads.scan(cursor, this.#me, SCAN_LIMIT);
      for (const j of p.jobs) {
        const k = j.jobId.toString();
        if (!state.jobs.has(k)) state.jobs.set(k, { firstSeen: at });
      }
      const moved = p.nextCursor !== cursor;
      cursor = p.nextCursor;
      report.head = p.head.toString();
      if (!moved || cursor >= p.head) break;
    }
    state.cursor = cursor;
    report.cursor = cursor.toString();
    await state.save();

    // 2. Refresh every open job and act on it.
    const ids = [...state.jobs.keys()].map((k) => BigInt(k));
    const jobs = ids.length ? await reads.refresh(ids) : [];
    const found = new Set(jobs.map((j) => j.jobId.toString()));
    for (const k of [...state.jobs.keys()]) if (!found.has(k)) state.jobs.delete(k); // not a guardian job (any more)
    for (const job of jobs) {
      try {
        await this.#job(job, at, report);
      } catch (err) {
        const m = `job ${job.jobId}: ${safeMessage(err)}`;
        report.errors.push(m);
        this.#o.log?.(`guardian ${m}`);
      }
    }
    report.open = state.jobs.size;
    await state.save();
    return report;
  }

  async #job(job: GuardianJob, at: number, report: GuardianReport): Promise<void> {
    const k = job.jobId.toString();
    if (!same(job.provider, this.#me)) {
      this.#done(k);
      return;
    }
    switch (job.status) {
      case "Open":
        if (at >= job.expiredAt) this.#done(k); // never funded
        return;
      case "Funded": {
        const t = job.terms;
        if (!t || at < t.end) return; // the window is still running
        if (at >= job.expiredAt) {
          await this.#event({ kind: "alert", job, reason: "the job expired before the desk could submit; the client can claim a refund from the kernel" });
          this.#done(k);
          return;
        }
        if ((this.#backoff.get(k) ?? 0) > at) return;
        const submitted = await this.#submit(job, at, report);
        if (submitted) await this.#settle({ ...job, status: "Submitted" }, at, report);
        return;
      }
      case "Submitted": {
        const t = job.terms;
        if (!t || at < t.end) return;
        if ((this.#backoff.get(k) ?? 0) > at) return;
        await this.#settle(job, at, report);
        return;
      }
      case "Completed":
      case "Rejected": {
        // Our settle that was still pending last loop, or someone else's (settle is permissionless).
        const settleTx = this.#o.state.jobs.get(k)?.settleTx;
        if (settleTx) {
          const own = await this.#outcomeOf(job, settleTx);
          if (own.survived !== null) {
            report.settled.push(k);
            await this.#bookOutcome(job, own.survived, settleTx, own.paid, false, own.token);
            this.#done(k);
            return;
          }
        }
        await this.#bookOutcome(job, job.status === "Completed", null, job.status === "Completed" ? job.budget : 0n, true);
        this.#done(k);
        return;
      }
      case "Expired":
        await this.#event({ kind: "alert", job, reason: "the job expired and was refunded to the client" });
        this.#done(k);
        return;
    }
  }

  // ------------------------------------------------------------------ submit

  async #submit(job: GuardianJob, at: number, report: GuardianReport): Promise<boolean> {
    const { sender, deployment, state } = this.#o;
    const k = job.jobId.toString();
    const ev = await this.#evidence(job);
    const tx = writes.submit(deployment, job.jobId, ev.hash);
    const data = { deliverable: ev.hash, evidence: `/evidence/${k}`, events: ev.events };
    const sim = await sender.simulate(tx);
    if (!sim.ok) {
      await this.#refused(job, at, "submit", sim, sim.error);
      return false;
    }
    if (sender.dryRun) {
      await this.#wait(job, at, "submit", { kind: "submit", job, sim, dryRun: true, reason: "dry run: submit simulated, not sent", data });
      return false;
    }
    const sent = await this.#broadcast(job, at, "submit", tx, sim, data);
    if (!sent) return false;
    const rec = state.jobs.get(k);
    if (rec) Object.assign(rec, { deliverable: ev.hash, submitTx: sent.txHash });
    await state.save();
    report.submitted.push(k);
    await this.#event({ kind: "submit", job, sim, txHash: sent.txHash, reason: "window over: evidence submitted", data: { ...data, via: sent.via } });
    this.#o.log?.(`guardian submitted job ${k} in ${sent.txHash}`);
    return true;
  }

  /** The evidence for a job: written once, so a retried submit carries the same hash. */
  async #evidence(job: GuardianJob): Promise<{ hash: Hex; events: number }> {
    const t = job.terms as NonNullable<GuardianJob["terms"]>;
    const file = evidenceFile(this.#o.dataDir, job.jobId);
    try {
      const json = await readFile(file, "utf8");
      return { hash: keccak256(stringToBytes(json)), events: (JSON.parse(json) as { events?: unknown[] }).events?.length ?? 0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const { deployment, feed } = this.#o;
    const events = feed.list({ account: t.account });
    const ev = buildEvidence({
      chainId: deployment.chainId,
      kernel: deployment.external.kernel,
      guardian: deployment.guardian,
      agent: this.#me,
      jobId: job.jobId,
      account: t.account,
      start: t.start,
      end: t.end,
      events,
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, ev.json, { encoding: "utf8", flag: "wx" }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const stored = await readFile(file, "utf8");
    return { hash: keccak256(stringToBytes(stored)), events: (JSON.parse(stored) as { events?: unknown[] }).events?.length ?? 0 };
  }

  // ------------------------------------------------------------------ settle

  async #settle(job: GuardianJob, at: number, report: GuardianReport): Promise<void> {
    const { sender, deployment, state, reads } = this.#o;
    const k = job.jobId.toString();
    const tx = writes.settle(deployment, job.jobId);
    const sim = await sender.simulate(tx);
    if (!sim.ok) {
      if (sim.error?.name === "CannotEvaluateNow") {
        // Health is unknown right now (the venue cannot price): try again next loop, never force.
        await this.#wait(job, at, "cannot-evaluate", { kind: "noop", job, sim, error: sim.error, reason: "account health cannot be read right now; settling on a later loop" });
        return;
      }
      await this.#refused(job, at, "settle", sim, sim.error);
      return;
    }
    if (sender.dryRun) {
      await this.#wait(job, at, "settle", { kind: "settle", job, sim, dryRun: true, reason: "dry run: settle simulated, not sent" });
      return;
    }
    const sent = await this.#broadcast(job, at, "settle", tx, sim);
    if (!sent) return;
    const rec = state.jobs.get(k);
    if (rec) rec.settleTx = sent.txHash;
    const outcome = await this.#outcomeOf(job, sent.txHash);
    const token = outcome.token;
    // Without the event, the job status after settlement is the truth: refresh once.
    let survived = outcome.survived;
    if (survived === null) {
      const [fresh] = await reads.refresh([job.jobId]).catch(() => [] as GuardianJob[]);
      survived = fresh ? fresh.status === "Completed" : null;
    }
    report.settled.push(k);
    await this.#bookOutcome(job, survived, sent.txHash, outcome.paid, false, token, sim);
    this.#done(k);
    this.#o.log?.(`guardian settled job ${k} (${survived === null ? "unknown" : survived ? "complete" : "reject"}) in ${sent.txHash}`);
  }

  /** Outcome and payout from our settle receipt; survived null when it cannot be read. */
  async #outcomeOf(job: GuardianJob, txHash: Hex): Promise<SettleOutcome & { token: PaymentToken | null }> {
    try {
      const token = await this.#o.reads.paymentToken(job.jobId);
      return { ...(await this.#o.reads.settleOutcome(txHash, job.jobId, token.token, this.#me)), token };
    } catch (err) {
      this.#o.log?.(`guardian job ${job.jobId}: settle receipt unreadable: ${safeMessage(err)}`);
      return { survived: null, paid: 0n, token: null };
    }
  }

  /**
   * Sends a submit or settle and records every outcome that is not a mined success: a refusal (estimate
   * revert, on-chain revert, broadcast failure), a wait (CannotEvaluateNow at estimate), a replacement
   * (dropped: retried next loop) or a pending transaction (the next loop's job refresh shows whether it landed).
   */
  async #broadcast(job: GuardianJob, at: number, step: "submit" | "settle", tx: TxRequest, sim: FeedSim, data: Record<string, unknown> = {}): Promise<{ txHash: Hex; via: string } | null> {
    const k = job.jobId.toString();
    let sent: SendResult;
    try {
      sent = await this.#o.sender.send(tx);
    } catch (err) {
      await this.#refused(job, at, step, sim, { name: "BroadcastFailed", message: safeMessage(err) });
      return null;
    }
    if (!sent.ok) {
      if (sent.stage === "estimate" && sent.error.name === "CannotEvaluateNow") {
        await this.#wait(job, at, "cannot-evaluate", { kind: "noop", job, sim, error: sent.error, reason: "account health cannot be read right now; settling on a later loop" });
        return null;
      }
      await this.#refused(job, at, step, sim, sent.stage === "estimate" ? sent.error : { name: "Aborted", message: `${step} was not sent` });
      return null;
    }
    const rec = this.#o.state.jobs.get(k);
    if (sent.status === "pending") {
      if (rec) {
        if (step === "submit") rec.submitTx = sent.txHash;
        else rec.settleTx = sent.txHash;
      }
      await this.#o.state.save();
      await this.#event({ kind: "pending", job, sim, txHash: sent.txHash, reason: `${step} sent but not mined yet; the next loop reads the job again`, data: { ...data, step, nonce: sent.nonce } });
      return null;
    }
    if (sent.status === "dropped") {
      await this.#refused(job, at, step, sim, { name: "Dropped", message: `${step} was replaced before it was mined` }, sent.txHash, 0);
      return null;
    }
    if (sent.status === "reverted") {
      await this.#refused(job, at, step, sim, { name: "Reverted", message: `${step} reverted on-chain` }, sent.txHash);
      return null;
    }
    return { txHash: sent.txHash, via: sent.via };
  }

  async #bookOutcome(
    job: GuardianJob,
    survived: boolean | null,
    txHash: Hex | null,
    paid: bigint,
    estimated: boolean,
    knownToken?: PaymentToken | null,
    sim?: FeedSim,
  ): Promise<void> {
    const k = job.jobId.toString();
    let token = knownToken ?? null;
    if (!token) token = await this.#o.reads.paymentToken(job.jobId).catch(() => null);
    const outcome = survived === null ? "unknown" : survived ? "complete" : "reject";
    await this.#event({
      kind: "settle",
      job,
      ...(sim ? { sim } : {}),
      ...(txHash ? { txHash } : {}),
      reason: survived === null ? "settled; outcome unread" : survived ? "the account survived the window: the desk is paid" : "the account did not survive the window: the client is refunded",
      data: { outcome, payout: paid.toString(), token: token?.symbol ?? null, by: estimated ? "another caller" : "desk" },
    });
    if (survived === null) return;
    try {
      await this.#o.ledger.record({
        kind: "income",
        source: "guardian",
        jobId: k,
        token: token?.token ?? ("0x0000000000000000000000000000000000000000" as Address),
        symbol: token?.symbol ?? "?",
        amount: paid.toString(),
        decimals: token?.decimals ?? 18,
        usd: token ? stableUsd(token.symbol, paid, token.decimals) : null,
        outcome: survived ? "complete" : "reject",
        ...(txHash ? { txHash } : {}),
        ...(estimated ? { estimated: true } : {}),
      });
    } catch (err) {
      this.#o.log?.(`guardian job ${k}: ledger entry failed: ${safeMessage(err)}`);
    }
  }

  // ----------------------------------------------------------------- helpers

  #done(k: string) {
    this.#o.state.jobs.delete(k);
    this.#backoff.delete(k);
    this.#waits.delete(k);
  }

  async #refused(job: GuardianJob, at: number, step: "submit" | "settle", sim: FeedSim, error: FeedError | undefined, txHash?: Hex, backoffSec = REFUSAL_BACKOFF_SEC) {
    const k = job.jobId.toString();
    this.#backoff.set(k, at + backoffSec);
    this.#waits.delete(k);
    const e = error ?? { name: "SimulationFailed", message: `${step} simulation failed` };
    await this.#event({ kind: "refused", job, sim, error: e, reason: `${step}: ${e.message}`, ...(txHash ? { txHash } : {}), data: { step, backoffUntil: at + backoffSec } });
  }

  /** Records a waiting event, re-recording an identical one at most every REPEAT_EVENT_SEC. */
  async #wait(job: GuardianJob, at: number, key: string, e: EventArgs) {
    const k = job.jobId.toString();
    const last = this.#waits.get(k);
    if (last && last.key === key && at - last.at < REPEAT_EVENT_SEC) {
      this.#o.log?.(`guardian job ${k}: ${e.reason ?? key} (repeat)`);
      return;
    }
    this.#waits.set(k, { key, at });
    await this.#event(e);
  }

  async #event(e: EventArgs) {
    const { job, ...rest } = e;
    const input: FeedInput = {
      source: "guardian",
      jobId: job.jobId.toString(),
      ...(job.terms ? { account: job.terms.account, window: { kind: "GUARD", startsAt: job.terms.start, endsAt: job.terms.end, gapBps: 0 } } : {}),
      ...rest,
      data: { status: job.status, client: job.client, budget: job.budget.toString(), expiredAt: job.expiredAt, ...(rest.data ?? {}) },
    };
    await this.#o.feed.record(input);
  }
}

type EventArgs = Omit<FeedInput, "source" | "jobId" | "account" | "window"> & { job: GuardianJob };
