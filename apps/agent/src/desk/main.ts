// The Risk Desk process: the read API first, then the loops (publisher, keeper, guardian, x402 earnings,
// notes), each on its own timer with jitter. A failing loop logs, backs off and tries again; it never takes
// the API or the other loops down. SIGTERM stops scheduling, lets in-flight work (a send waiting for its
// receipt) finish, closes the API and flushes the ledger and guardian state.
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PublicRwaClient, Web3Client, createProbe, type ProbeRecord } from "@ballast/binance";
import { tickers } from "@ballast/risk";
import { accountState, listAccounts, listCovers, loadDeployment, oracleSnapshot, sessionState, type AccountState, type Deployment } from "@ballast/sdk";
import { formatEther, formatGwei, parseEther, type Address, type PublicClient } from "viem";
import { loadAccount } from "./account";
import { ApiProbe, cached, closeServer, createDeskApi, listen } from "./api";
import { deskPublicClient } from "./client";
import { ConfigError, deskSecrets, loadConfig, type DeskConfig } from "./config";
import { EARNINGS_CHECK_SEC, EarningsBuyer, mergedEarnings } from "./earnings";
import { Feed } from "./feed";
import { Guardian, GuardianState, chainGuardianReads } from "./guardian";
import { KEEPER_TICK_SEC, Keeper, chainKeeperReads } from "./keeper";
import { GasBook, Ledger, ledgerSender } from "./ledger";
import { NOTES_TICK_SEC, NotesStore, NotesWorker, studioNoteModel } from "./notes";
import { Publisher, chainPublisherReads, publisherDelaySec } from "./publisher";
import { ChainSender, GasWatch, binanceTxApi, safeMessage, senderOptions, type SendResult, type SenderState } from "./tx";
import { X402Client } from "./x402";

// ------------------------------------------------------------------- loops

export interface LoopState {
  name: string;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastStartAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  nextAt: string | null;
}

export interface LoopOptions {
  name: string;
  run: () => Promise<unknown>;
  /** Seconds until the next run after a success. */
  delaySec: () => number;
  /** First run after this many seconds. */
  firstDelaySec?: number;
  /** +/- fraction applied to every delay. */
  jitter?: number;
  maxBackoffSec?: number;
  random?: () => number;
  log?: (line: string) => void;
  /** Called with each successful run's result (for logging). */
  onResult?: (result: unknown) => void;
}

/** Seconds before retrying after `n` consecutive failures: 30 s doubling to the cap. */
export const backoffSec = (n: number, cap = 900) => Math.min(cap, 30 * 2 ** Math.max(0, n - 1));

/** One periodic loop: never overlaps itself, isolates its failures and backs off while they last. */
export class Loop {
  readonly #o: LoopOptions;
  readonly #state: LoopState;
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<void> | null = null;
  #stopped = false;

  constructor(o: LoopOptions) {
    this.#o = o;
    this.#state = { name: o.name, running: false, runs: 0, failures: 0, consecutiveFailures: 0, lastStartAt: null, lastOkAt: null, lastError: null, nextAt: null };
  }

  get state(): LoopState {
    return { ...this.#state };
  }

  start(): void {
    this.#schedule(this.#o.firstDelaySec ?? 1);
  }

  /** Runs once now (tests and manual triggers); resolves when the run is over. */
  runOnce(): Promise<void> {
    if (!this.#current) this.#current = this.#run().finally(() => (this.#current = null));
    return this.#current;
  }

  /** Stops scheduling and waits for an in-flight run, at most `timeoutMs`. */
  async stop(timeoutMs = 150_000): Promise<boolean> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state.nextAt = null;
    if (!this.#current) return true;
    let t: NodeJS.Timeout | undefined;
    const done = await Promise.race([this.#current.then(() => true), new Promise<boolean>((r) => (t = setTimeout(() => r(false), timeoutMs)))]);
    if (t) clearTimeout(t);
    return done;
  }

  #schedule(sec: number) {
    if (this.#stopped) return;
    const j = this.#o.jitter ?? 0.1;
    const rnd = this.#o.random ?? Math.random;
    const delay = Math.max(0.05, sec * (1 + (rnd() * 2 - 1) * j));
    this.#state.nextAt = new Date(Date.now() + delay * 1000).toISOString();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.runOnce().then(() => {
        const next = this.#state.consecutiveFailures > 0 ? backoffSec(this.#state.consecutiveFailures, this.#o.maxBackoffSec) : this.#o.delaySec();
        this.#schedule(next);
      });
    }, delay * 1000);
    this.#timer.unref?.();
  }

  async #run(): Promise<void> {
    this.#state.running = true;
    this.#state.runs++;
    this.#state.lastStartAt = new Date().toISOString();
    try {
      const r = await this.#o.run();
      this.#state.consecutiveFailures = 0;
      this.#state.lastOkAt = new Date().toISOString();
      this.#state.lastError = null;
      this.#o.onResult?.(r);
    } catch (err) {
      this.#state.failures++;
      this.#state.consecutiveFailures++;
      this.#state.lastError = safeMessage(err);
      this.#o.log?.(`${this.#o.name} failed (${this.#state.consecutiveFailures} in a row, retry in ${backoffSec(this.#state.consecutiveFailures, this.#o.maxBackoffSec)} s): ${this.#state.lastError}`);
    } finally {
      this.#state.running = false;
    }
  }
}

/**
 * Proves the data dir can be written before anything depends on it: the feed, the ledger, the guardian
 * cursor and the evidence files all live there, and a desk that cannot persist them must not start.
 */
export async function assertWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    await mkdir(path.join(dir, "evidence"), { recursive: true });
    await writeFile(probe, "ok\n", "utf8");
    await rm(probe);
  } catch (err) {
    throw new Error(`DATA_DIR ${dir} is not writable (${(err as NodeJS.ErrnoException).code ?? "error"}): set DATA_DIR to a directory the desk user owns, e.g. /var/lib/ballast`);
  }
}

/**
 * The sender as /health shows it: why it is halted (it signs nothing until that clears), and the one
 * transaction in flight with every hash signed for its nonce.
 */
export function senderView(s: SenderState | undefined) {
  if (!s) return null;
  const o = s.outstanding;
  return {
    // How collateral sales leave: "protected" (Binance MEV-protected endpoint), "public" (not mainnet) or "disabled".
    sales: s.sales,
    halted: s.halted ? { reason: s.halted.reason, message: s.halted.message, nonce: s.halted.nonce, since: s.halted.since } : null,
    inFlight: o ? { nonce: o.nonce, kind: o.kind, rounds: o.rounds, gasPriceGwei: formatGwei(o.gasPrice), hashes: [...o.hashes] } : null,
    feeSpentLastHourBnb: formatEther(s.spentLastHourWei),
  };
}

/**
 * On BSC mainnet a collateral sale is only ever broadcast through the Binance MEV-protected endpoint.
 * Without Binance keys the sender reports sales as disabled: the desk never signs a sale, it still shields
 * with the cushion (and the keeper records the alert in the feed).
 */
export function salesWarning(sales: SenderState["sales"] | undefined): string | null {
  if (sales !== "disabled") return null;
  return "collateral sales are DISABLED: no Binance Web3 API key (set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET), and a sale is only ever broadcast through the Binance MEV-protected endpoint. A sale is never signed; the cushion still shields";
}

// -------------------------------------------------------------- read views

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

function accountView(s: AccountState, me: Address, feed: Feed) {
  const last = feed.list({ account: s.address, limit: 1 })[0];
  return {
    address: s.address,
    venue: s.venue,
    owner: s.owner,
    keeper: s.keeper,
    keptByDesk: same(s.keeper, me),
    symbol: s.symbol,
    mandate: s.mandate,
    collateral: s.collateral,
    debt: s.debt,
    cushion: s.cushion,
    ltvBps: s.ltvBps !== null && Number.isFinite(s.ltvBps) ? s.ltvBps : null,
    healthKnown: s.healthKnown,
    healthy: s.healthy,
    liquidated: s.liquidated,
    loanToken: s.loanToken,
    collateralToken: s.collateralToken,
    loanDecimals: s.loanDecimals,
    collateralDecimals: s.collateralDecimals,
    lastEvent: last ? { seq: last.seq, ts: last.ts, kind: last.kind, reason: last.reason ?? null, txHash: last.txHash ?? null } : null,
  };
}

export function readViews(client: PublicClient, d: Deployment, me: Address, feed: Feed) {
  return {
    async accounts() {
      const [list, covers] = await Promise.all([listAccounts(client, d), listCovers(client, d)]);
      const accounts = await mapLimit(list.slice(-500), 10, async (a) => {
        try {
          return accountView(await accountState(client, d, a), me, feed);
        } catch {
          return { address: a, error: "state unreadable right now" };
        }
      });
      return {
        accounts,
        covers: covers.map((c) => ({ user: c.user, key: c.key, keptByDesk: same(c.cover.keeper, me), ...c.cover })),
      };
    },
    async oracle() {
      const session = await sessionState(client, d);
      const symbols = await mapLimit(tickers, 6, async (t) => {
        try {
          return await oracleSnapshot(client, d, t.symbol, { blockNumber: session.blockNumber });
        } catch {
          return { symbol: t.symbol, error: "snapshot unreadable right now" };
        }
      });
      return { session, symbols };
    },
  };
}

// --------------------------------------------------------------------- run

export interface Desk {
  config: DeskConfig;
  stop(): Promise<void>;
  loops: Loop[];
  port: number;
}

export async function startDesk(env: Record<string, string | undefined> = process.env, log: (line: string) => void = (l) => console.log(`${new Date().toISOString()} ${l}`)): Promise<Desk> {
  const config = loadConfig(env);
  log(`desk config: ${config.describe()}`);
  await assertWritable(config.dataDir);
  const account = await loadAccount(config.signer);
  const client = deskPublicClient(config);
  const deployment = loadDeployment(config.chainId, { file: config.deploymentFile });
  const secrets = deskSecrets(config, env);
  const onError = (m: string) => log(m);

  const feed = new Feed({ dir: config.dataDir, secrets, onError });
  await feed.load();
  const ledger = new Ledger({ dir: config.dataDir, x402DailyCapUsd: config.x402DailyCapUsd, onError });
  await ledger.load();
  const notesStore = new NotesStore(config.dataDir);
  await notesStore.load();
  const guardianState = new GuardianState({ dir: config.dataDir, chainId: deployment.chainId, guardian: deployment.guardian, onError });
  await guardianState.load();

  const probe = new ApiProbe();
  const dxProbe = createProbe();
  const probeFn = (r: ProbeRecord) => {
    probe.record(r);
    dxProbe(r);
  };
  const rwa = new PublicRwaClient({ probe: probeFn });
  const web3 = config.binance ? new Web3Client({ apiKey: config.binance.apiKey.reveal(), apiSecret: config.binance.apiSecret.reveal(), probe: probeFn }) : null;
  // One sender for the key (one transaction in flight at a time, its hash family kept in DATA_DIR/sender.json).
  // Every loop gets the same sender through a wrapper that books its mined transactions in one shared gas book.
  const chainSender = new ChainSender({ client, account, chainId: config.chainId, dryRun: config.dryRun, binance: web3 ? binanceTxApi(web3) : null, ...senderOptions(config) });
  const gasBook = new GasBook(ledger, onError);
  const gas = new GasWatch({ sender: chainSender, feed, minWei: parseEther(config.minBnbBalance.toFixed(18)) });
  const sales = chainSender.state().sales;
  log(`collateral sales: ${sales}${sales === "protected" ? " (Binance MEV-protected broadcast only)" : sales === "public" ? " (not mainnet: public broadcast)" : ""}`);
  const noSales = salesWarning(sales);
  if (noSales) log(`WARNING: ${noSales}`);

  const paidEarningsFile = config.x402.earningsUrl ? path.join(config.dataDir, "earnings-paid.json") : null;
  const publisher = new Publisher({
    deployment,
    reads: chainPublisherReads(client, deployment),
    rwa,
    sender: ledgerSender(chainSender, gasBook, "publisher"),
    feed,
    earnings: mergedEarnings(config.earningsFile, paidEarningsFile),
    gas,
    // One key, one transaction at a time: a post that can wait stands back for a shield.
    busy: () => keeper.shieldBusy(),
    log,
  });
  const keeper: Keeper = new Keeper({ deployment, reads: chainKeeperReads(client, deployment), sender: ledgerSender(chainSender, gasBook, "keeper"), feed, gas, log, targetHfAfterGap: config.targetHfAfterGap });
  const guardian = new Guardian({
    deployment,
    reads: chainGuardianReads(client, deployment),
    sender: ledgerSender(chainSender, gasBook, "guardian"),
    feed,
    ledger,
    state: guardianState,
    dataDir: config.dataDir,
    // One key, one transaction at a time: a shield goes before a guardian submit or settle.
    busy: () => keeper.shieldBusy(),
    log,
  });
  const buyer =
    config.x402.earningsUrl && paidEarningsFile
      ? new EarningsBuyer({
          client: new X402Client({ account, ledger, maxUsdPerCall: config.x402.maxPriceUsd, networks: config.x402.networks, dryRun: config.dryRun }),
          urlTemplate: config.x402.earningsUrl,
          file: paidEarningsFile,
          feed,
          log,
        })
      : null;
  const model = config.notes === "auto" ? await studioNoteModel(config.studioToml, log) : null;
  const notes = model ? new NotesWorker({ feed, store: notesStore, model, secrets, dailyMax: config.notesDailyMax, log }) : null;

  const fork = config.forkTickSec;
  const every = (sec: number) => () => fork ?? sec;
  const loops: Loop[] = [
    new Loop({ name: "publisher", run: () => publisher.tick(), delaySec: () => fork ?? publisherDelaySec(Math.floor(Date.now() / 1000)), firstDelaySec: 2, log }),
    new Loop({ name: "keeper", run: () => keeper.tick(), delaySec: every(KEEPER_TICK_SEC), firstDelaySec: 8, log }),
    new Loop({ name: "guardian", run: () => guardian.tick(), delaySec: () => fork ?? guardian.nextDelaySec(), firstDelaySec: 14, log }),
  ];
  if (buyer) loops.push(new Loop({ name: "earnings", run: () => buyer.tick(), delaySec: every(EARNINGS_CHECK_SEC), firstDelaySec: 20, log }));
  if (notes) loops.push(new Loop({ name: "notes", run: () => notes.tick(), delaySec: () => NOTES_TICK_SEC, firstDelaySec: 30, log }));

  const startedAt = Date.now();
  const views = readViews(client, deployment, account.address, feed);
  const server = createDeskApi({
    feed,
    notes: notesStore,
    ledger,
    dataDir: config.dataDir,
    webOrigin: config.webOrigin,
    secrets,
    ratePerMin: config.apiRatePerMin,
    log,
    health: () => {
      const sender = senderView(chainSender.state());
      return {
        // Not ok while the sender is halted: the desk signs nothing until the cause clears.
        ok: !sender?.halted,
        chainId: config.chainId,
        agent: account.address,
        dryRun: config.dryRun,
        // Desk policy: the health the keeper keeps after the coming gap.
        targetHfAfterGap: config.targetHfAfterGap,
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        feedSeq: feed.list({ limit: 1 })[0]?.seq ?? 0,
        notes: notes ? "on" : "off",
        x402Earnings: buyer ? "on" : "off",
        sender,
        loops: loops.map((l) => l.state),
      };
    },
    accounts: cached(() => views.accounts(), 30_000),
    oracle: cached(() => views.oracle(), 30_000),
    apiHealth: () => probe.summary(),
  });
  const addr = await listen(server, config.httpHost, config.httpPort);
  log(`read API on http://${config.httpHost}:${addr.port} (agent ${account.address}, ${config.dryRun ? "DRY RUN" : "live"})`);
  // Once at startup: settle what a previous run left in flight. It runs in the sender's queue, so the loops
  // start right away and their first sends simply wait behind it. Through the ledger wrapper: what it settles
  // is booked, and a nonce that is still pending is followed until it is mined.
  void (ledgerSender(chainSender, gasBook, "other").recover?.() ?? Promise.resolve(null))
    .then((res) => {
      const r = res as SendResult | null;
      if (!r) return;
      if (r.ok) log(`sender recovery: nonce ${r.nonce} ${r.status}${r.minedAs ? ` (${r.minedAs})` : ""} ${r.txHash}${r.halted ? `; halted: ${r.halted.reason}` : ""}`);
      else if (r.stage === "halted") log(`sender recovery: halted (${r.halt.reason}): ${r.halt.message}`);
    })
    .catch((err) => log(`sender recovery failed: ${safeMessage(err)}`));
  for (const l of loops) l.start();

  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        log("stopping: waiting for in-flight work");
        const done = await Promise.all(loops.map((l) => l.stop()));
        if (done.includes(false)) log("stopping: a loop did not finish in time");
        await closeServer(server);
        await Promise.all([ledger.flush(), guardianState.save()]);
        log("stopped");
      })();
    }
    return stopping;
  };
  return { config, stop, loops, port: addr.port };
}

async function main() {
  let desk: Desk;
  try {
    desk = await startDesk();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(`desk failed to start: ${safeMessage(err)}`);
    process.exit(1);
  }
  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      console.error(`${sig} again: exiting now`);
      process.exit(1);
    }
    void desk.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("unhandledRejection", (r) => console.error(`unhandled rejection: ${safeMessage(r)}`));
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) void main();
