import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, getAddress, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";
import { ballastErrorsAbi, ballastGuardianAbi, kernelAbi, parseDeployment, type GuardianJob, type TxRequest } from "@ballast/sdk";
import { Feed } from "../src/desk/feed";
import { GUARDIAN_TICK_SEC, Guardian, GuardianState, QUICK_RETRY_SEC, REFUSAL_BACKOFF_SEC, buildEvidence, evidenceFile, type GuardianReads } from "../src/desk/guardian";
import { Ledger } from "../src/desk/ledger";
import { revertError, type Confirmation, type HaltInfo, type SendResult, type SenderState, type TxSender } from "../src/desk/tx";

const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));
const E18 = 10n ** 18n;
const d = parseDeployment(31337, {
  calendar: addr(0xa1),
  sessionOracle: addr(0xa2),
  sessionAwareFeed: addr(0xa3),
  factory: addr(0xa4),
  listaImpl: addr(0xa5),
  venusImpl: addr(0xa6),
  cushionVault: addr(0xa7),
  guardian: addr(0xa8),
  guardianStartJobId: "100",
});
const AGENT = addr(0xee);
const CLIENT = addr(0xb1);
const ACCOUNT = addr(0xd1);
const OTHER = addr(0xd2);
const USD1 = getAddress(d.external.tokens.USD1!);
const START = 1_800_000_000;
const END = START + 7200;

function job(id: bigint, o: Partial<GuardianJob> = {}): GuardianJob {
  return {
    jobId: id,
    client: CLIENT,
    provider: AGENT,
    evaluator: d.guardian,
    description: "guard",
    budget: E18,
    expiredAt: END + 86_400,
    status: "Funded",
    hook: d.guardian,
    submittedAt: 0,
    deliverable: `0x${"00".repeat(32)}`,
    terms: { account: ACCOUNT, start: START, end: END, agentId: 7n, settled: false },
    ...o,
  };
}

type Call = { fn: string; args: readonly unknown[] };
const decode = (tx: TxRequest): Call => {
  for (const abi of [kernelAbi, ballastGuardianAbi]) {
    try {
      const r = decodeFunctionData({ abi, data: tx.data });
      return { fn: r.functionName, args: (r.args ?? []) as readonly unknown[] };
    } catch {
      // next
    }
  }
  throw new Error("unknown calldata");
};

const revert = (name: string) => encodeErrorResult({ abi: ballastErrorsAbi, errorName: name as never });
const HALT: HaltInfo = { reason: "STUCK", message: "nonce 5 is not mined after 4 replacement rounds", nonce: 5, since: 1_800_000_000 };

class StubSender implements TxSender {
  readonly address = AGENT;
  dryRun = false;
  failing = new Map<string, Hex>();
  sims: Call[] = [];
  sent: Call[] = [];
  onSend?: (c: Call) => void;
  /** Outcome of the next sends, in order (default success). */
  statuses: ("success" | "reverted" | "pending" | "dropped" | "cancelled" | "halted" | "throw")[] = [];
  /** What state() answers: a halt, and/or a transaction of the key in flight. */
  senderState: SenderState = { sales: "protected", halted: null, outstanding: null, spentLastHourWei: 0n };
  /** What confirm() answers for a hash. */
  confirmations = new Map<string, Confirmation>();
  state() {
    return this.senderState;
  }
  async confirm(txHash: Hex): Promise<Confirmation> {
    return this.confirmations.get(txHash) ?? { status: "pending" };
  }
  async simulate(tx: TxRequest) {
    const c = decode(tx);
    this.sims.push(c);
    const data = this.failing.get(c.fn);
    if (data) return { via: "rpc" as const, ok: false, error: revertError(data)! };
    return { via: "rpc" as const, ok: true };
  }
  async send(tx: TxRequest): Promise<SendResult> {
    const c = decode(tx);
    this.sent.push(c);
    if ((this.statuses[0] ?? "success") === "success") this.onSend?.(c);
    const status = this.statuses.shift() ?? "success";
    if (status === "throw") throw new Error("broadcast failed: connection reset");
    if (status === "halted") return { ok: false, stage: "halted", halt: HALT };
    const base = { ok: true as const, txHash: `0x${String(this.sent.length).padStart(64, "0")}` as Hex, via: "rpc" as const, nonce: this.sent.length, gasPrice: 10n ** 8n };
    if (status === "pending") return { ...base, status, halted: HALT };
    if (status === "dropped") return { ...base, status };
    if (status === "cancelled") return { ...base, status: "dropped", minedAs: "cancel", gasUsed: 21_000n, effectiveGasPrice: 10n ** 8n };
    return { ...base, status, minedAs: "intent", gasUsed: 100_000n, effectiveGasPrice: 10n ** 8n };
  }
}

interface World {
  /** What the keeper's shieldBusy() answers. */
  keeperBusy: boolean;
  at: number;
  jobs: Map<bigint, GuardianJob>;
  head: bigint;
  scans: bigint[];
  survived: boolean | null;
  paid: bigint;
}

async function setup(w: Partial<World> = {}, dir?: string) {
  const world: World = { keeperBusy: false, at: END + 60, jobs: new Map(), head: 105n, scans: [], survived: true, paid: E18, ...w };
  const dataDir = dir ?? (await mkdtemp(path.join(tmpdir(), "desk-guardian-")));
  const sender = new StubSender();
  // Submit and settle move the job like the kernel would.
  sender.onSend = (c) => {
    const id = c.args[0] as bigint;
    const j = world.jobs.get(id);
    if (!j) return;
    if (c.fn === "submit") world.jobs.set(id, { ...j, status: "Submitted", deliverable: c.args[1] as Hex });
    if (c.fn === "settle") world.jobs.set(id, { ...j, status: world.survived ? "Completed" : "Rejected" });
  };
  const feed = new Feed({ dir: dataDir, secrets: [], clock: () => world.at });
  const ledger = new Ledger({ dir: dataDir, x402DailyCapUsd: 0.5, clock: () => world.at });
  const state = new GuardianState({ dir: dataDir, chainId: d.chainId, guardian: d.guardian });
  await state.load();
  const reads: GuardianReads = {
    now: async () => world.at,
    scan: async (from, provider, limit) => {
      world.scans.push(from);
      let to = world.head;
      if (to > from + BigInt(limit)) to = from + BigInt(limit);
      const jobs = [...world.jobs.values()].filter((j) => j.jobId > from && j.jobId <= to && j.provider === provider);
      return { jobs, nextCursor: to > from ? to : from, head: world.head };
    },
    refresh: async (ids) => ids.map((id) => world.jobs.get(id)).filter((j): j is GuardianJob => j !== undefined),
    paymentToken: async () => ({ token: USD1, symbol: "USD1", decimals: 18 }),
    settleOutcome: async () => ({ survived: world.survived, paid: world.survived ? world.paid : 0n }),
  };
  const guardian = new Guardian({ deployment: d, reads, sender, feed, ledger, state, dataDir, busy: () => world.keeperBusy });
  return { world, sender, feed, ledger, state, guardian, dataDir, reads };
}

describe("buildEvidence", () => {
  it("keeps the account's events inside the window, oldest first, and hashes the exact bytes", () => {
    const ev = (seq: number, ts: number, account: Address) => ({ seq, ts, kind: "shield" as const, source: "keeper" as const, account });
    const out = buildEvidence({
      chainId: 31337,
      kernel: d.external.kernel,
      guardian: d.guardian,
      agent: AGENT,
      jobId: 101n,
      account: ACCOUNT,
      start: START,
      end: END,
      events: [ev(4, END + 1, ACCOUNT), ev(3, END, ACCOUNT), ev(2, START + 5, OTHER), ev(1, START, ACCOUNT), ev(0, START - 1, ACCOUNT)],
    });
    const doc = JSON.parse(out.json);
    expect(doc.events.map((e: { seq: number }) => e.seq)).toEqual([1, 3]);
    expect(doc).toMatchObject({ jobId: "101", account: ACCOUNT, window: { start: START, end: END } });
    expect(out.hash).toBe(keccak256(stringToBytes(out.json)));
  });
});

describe("Guardian", () => {
  it("starts the scan at the deployment's guardianStartJobId and persists the cursor", async () => {
    const { world, guardian, state, dataDir } = await setup({ at: START });
    await guardian.tick();
    expect(world.scans[0]).toBe(100n);
    expect(state.cursor).toBe(105n);
    const reloaded = new GuardianState({ dir: dataDir, chainId: d.chainId, guardian: d.guardian });
    await reloaded.load();
    expect(reloaded.cursor).toBe(105n);
    // a restart continues from the stored cursor
    const again = await setup({ at: START, head: 107n }, dataDir);
    await again.guardian.tick();
    expect(again.world.scans[0]).toBe(105n);
  });

  it("waits while the window is running", async () => {
    const { world, sender, guardian, state } = await setup({ at: END - 1 });
    world.jobs.set(101n, job(101n));
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    expect(state.jobs.has("101")).toBe(true);
  });

  it("submits the evidence hash after the window, then settles and books the payout", async () => {
    const { world, sender, guardian, feed, ledger, dataDir, state } = await setup();
    world.jobs.set(101n, job(101n));
    await feed.record({ ts: START + 60, kind: "shield", source: "keeper", account: ACCOUNT, txHash: `0x${"ab".repeat(32)}` });
    await feed.record({ ts: START + 90, kind: "shield", source: "keeper", account: OTHER });
    const r = await guardian.tick();
    expect(r.submitted).toEqual(["101"]);
    expect(r.settled).toEqual(["101"]);
    expect(sender.sent.map((c) => c.fn)).toEqual(["submit", "settle"]);
    const stored = await readFile(evidenceFile(dataDir, 101n), "utf8");
    expect(sender.sent[0]!.args[1]).toBe(keccak256(stringToBytes(stored)));
    expect(JSON.parse(stored).events).toHaveLength(1);
    const kinds = feed.list({ source: "guardian" }).map((e) => e.kind);
    expect(kinds).toEqual(["settle", "submit"]);
    expect(feed.list({ kind: "settle" })[0]).toMatchObject({ jobId: "101", account: ACCOUNT, data: { outcome: "complete", payout: E18.toString(), token: "USD1" } });
    const income = ledger.list({ kind: "income" });
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ jobId: "101", amount: E18.toString(), usd: 1, outcome: "complete" });
    expect(state.jobs.has("101")).toBe(false);
  });

  it("books a rejected job with no payout", async () => {
    const { world, guardian, ledger, feed } = await setup({ survived: false });
    world.jobs.set(101n, job(101n));
    await guardian.tick();
    expect(feed.list({ kind: "settle" })[0]?.data).toMatchObject({ outcome: "reject", payout: "0" });
    expect(ledger.list({ kind: "income" })[0]).toMatchObject({ outcome: "reject", amount: "0" });
  });

  it("settles a submitted job and only once its window is over", async () => {
    const { world, sender, guardian } = await setup({ at: END - 10 });
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    world.at = END;
    await guardian.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["settle"]);
  });

  it("retries CannotEvaluateNow on the next loop without backing off, recording the wait once", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.failing.set("settle", revert("CannotEvaluateNow"));
    await guardian.tick();
    world.at += 600;
    await guardian.tick();
    expect(sender.sims.filter((c) => c.fn === "settle")).toHaveLength(2);
    expect(sender.sent).toEqual([]);
    const waits = feed.list({ source: "guardian", kind: "noop" });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ error: { name: "CannotEvaluateNow" } });
    sender.failing.delete("settle");
    world.at += 600;
    await guardian.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["settle"]);
  });

  it("backs a refused settle off and records the refusal", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.failing.set("settle", revert("NotSettleable"));
    await guardian.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ source: "guardian", error: { name: "NotSettleable" }, data: { step: "settle" } });
    world.at += 600;
    await guardian.tick();
    expect(sender.sims.filter((c) => c.fn === "settle")).toHaveLength(1);
    world.at += REFUSAL_BACKOFF_SEC;
    await guardian.tick();
    expect(sender.sims.filter((c) => c.fn === "settle")).toHaveLength(2);
  });

  it("reuses the stored evidence when a refused submit is retried", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n));
    await feed.record({ ts: START + 60, kind: "shield", source: "keeper", account: ACCOUNT });
    sender.failing.set("submit", revert("WindowNotOver"));
    await guardian.tick();
    const first = sender.sims[0]!.args[1];
    await feed.record({ ts: START + 120, kind: "restore", source: "keeper", account: ACCOUNT });
    sender.failing.delete("submit");
    world.at += REFUSAL_BACKOFF_SEC;
    await guardian.tick();
    expect(sender.sent[0]!.args[1]).toBe(first);
  });

  it("does not submit after the job expired", async () => {
    const { world, sender, guardian, feed, state } = await setup({ at: END + 86_400 });
    world.jobs.set(101n, job(101n));
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "alert" })[0]?.reason).toMatch(/expired/);
    expect(state.jobs.has("101")).toBe(false);
  });

  it("books a tracked job someone else settled from its budget, marked as estimated", async () => {
    const { world, guardian, ledger, sender } = await setup({ at: END - 60 });
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    await guardian.tick(); // seen while its window runs: tracked
    world.at = END + 60;
    world.jobs.set(101n, job(101n, { status: "Completed" })); // settle is permissionless
    await guardian.tick();
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    const income = ledger.list({ kind: "income" });
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ amount: E18.toString(), estimated: true, outcome: "complete" });
  });

  it("ignores jobs of other providers and drops unfunded jobs after expiry", async () => {
    const { world, guardian, state } = await setup({ at: START });
    world.jobs.set(101n, job(101n, { provider: addr(0x99) }));
    world.jobs.set(102n, job(102n, { status: "Open", terms: null, expiredAt: START + 10 }));
    await guardian.tick();
    expect(state.jobs.has("101")).toBe(false);
    expect(state.jobs.has("102")).toBe(true);
    world.at = START + 10;
    await guardian.tick();
    expect(state.jobs.has("102")).toBe(false);
  });

  it("in DRY_RUN simulates the submit and sends nothing", async () => {
    const { world, sender, guardian, feed } = await setup();
    sender.dryRun = true;
    world.jobs.set(101n, job(101n));
    await guardian.tick();
    await guardian.tick();
    expect(sender.sent).toEqual([]);
    expect(feed.list({ kind: "submit" })).toHaveLength(1);
    expect(feed.list({ kind: "submit" })[0]).toMatchObject({ dryRun: true });
  });

  it("follows a pending settle on the next loop and books it from its own receipt", async () => {
    const { world, sender, guardian, feed, ledger } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.statuses = ["pending"];
    const r1 = await guardian.tick();
    expect(r1.settled).toEqual([]);
    expect(feed.list({ kind: "pending" })[0]).toMatchObject({ source: "guardian", jobId: "101", data: { step: "settle", nonce: 1 } });
    // the transaction lands between loops
    world.jobs.set(101n, job(101n, { status: "Completed" }));
    const r2 = await guardian.tick();
    expect(r2.settled).toEqual(["101"]);
    expect(sender.sent).toHaveLength(1);
    expect(ledger.list({ kind: "income" })[0]).toMatchObject({ amount: E18.toString(), txHash: `0x${"1".padStart(64, "0")}` });
    expect(ledger.list({ kind: "income" })[0]).not.toHaveProperty("estimated");
  });

  it("re-sends a pending submit that did not land, with the same evidence", async () => {
    const { world, sender, guardian } = await setup();
    world.jobs.set(101n, job(101n));
    sender.statuses = ["pending"];
    await guardian.tick();
    await guardian.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["submit", "submit", "settle"]);
    expect(sender.sent[1]!.args[1]).toBe(sender.sent[0]!.args[1]);
  });

  it("retries dropped and failed broadcasts shortly with no back-off; only the on-chain revert backs off", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.statuses = ["dropped", "throw", "reverted"];
    await guardian.tick();
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    world.at += QUICK_RETRY_SEC;
    await guardian.tick();
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    world.at += QUICK_RETRY_SEC;
    await guardian.tick();
    expect(guardian.nextDelaySec()).toBe(GUARDIAN_TICK_SEC);
    const refused = feed.list({ kind: "refused" }).reverse();
    expect(refused.map((e) => e.error?.name)).toEqual(["Dropped", "BroadcastFailed", "Reverted"]);
    expect(refused.map((e) => (e.data as { backoffUntil?: number }).backoffUntil !== undefined)).toEqual([false, false, true]);
    // backing off now
    world.at += QUICK_RETRY_SEC;
    await guardian.tick();
    expect(sender.sent).toHaveLength(3);
  });

  it("treats NotSettleable right after our own submit as a lagging read: retry in ~90 s, no back-off", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n));
    sender.failing.set("settle", revert("NotSettleable"));
    const r = await guardian.tick();
    expect(r.submitted).toEqual(["101"]);
    expect(feed.list({ kind: "refused" })).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ jobId: "101", error: { name: "NotSettleable" }, reason: expect.stringMatching(/right after the submit/) });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    sender.failing.delete("settle");
    world.at += QUICK_RETRY_SEC;
    const r2 = await guardian.tick();
    expect(r2.settled).toEqual(["101"]);
    expect(guardian.nextDelaySec()).toBe(GUARDIAN_TICK_SEC);
  });

  it("does not excuse NotSettleable long after the submit: a refusal with back-off", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n));
    sender.failing.set("settle", revert("WindowNotOver"));
    await guardian.tick();
    expect(feed.list({ kind: "refused" })).toEqual([]);
    world.at += 3600; // an hour later the same answer is no lag any more
    await guardian.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "WindowNotOver" }, data: { step: "settle", backoffUntil: world.at + REFUSAL_BACKOFF_SEC } });
    expect(guardian.nextDelaySec()).toBe(GUARDIAN_TICK_SEC);
  });

  it("caps the back-off at a third of the time left before the job expires", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted", expiredAt: world.at + 900 }));
    sender.failing.set("settle", revert("NotSettleable"));
    await guardian.tick();
    expect(feed.list({ kind: "refused" })[0]?.data).toMatchObject({ backoffUntil: world.at + 300 });
    world.at += 299;
    await guardian.tick();
    expect(sender.sims).toHaveLength(1);
    world.at += 1;
    await guardian.tick();
    expect(sender.sims).toHaveLength(2);
    // close to expiry the back-off never drops under a minute
    expect(feed.list({ kind: "refused" })[0]?.data).toMatchObject({ backoffUntil: world.at + 200 });
    world.at += 590;
    sender.failing.delete("settle");
    await guardian.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["settle"]);
  });

  it("waits while the sender is halted or has a transaction in flight: nothing simulated, no back-off", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n));
    sender.senderState = { sales: "protected", halted: HALT, outstanding: null, spentLastHourWei: 0n };
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "refused" })).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ jobId: "101", reason: expect.stringMatching(/sender is halted \(STUCK\)/), data: { sender: "halted", halt: { reason: "STUCK", nonce: 5 } } });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    sender.senderState = { sales: "protected", halted: null, outstanding: { nonce: 6, hashes: [`0x${"ab".repeat(32)}`], gasPrice: 1n, rounds: 0, kind: "intent" }, spentLastHourWei: 0n };
    world.at += QUICK_RETRY_SEC;
    await guardian.tick();
    expect(sender.sims).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ reason: expect.stringMatching(/in flight \(nonce 6\)/) });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    sender.senderState = { sales: "protected", halted: null, outstanding: null, spentLastHourWei: 0n };
    world.at += QUICK_RETRY_SEC;
    expect((await guardian.tick()).settled).toEqual(["101"]);
  });

  it("treats a send the sender refused because it halted as a wait", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.statuses = ["halted"];
    await guardian.tick();
    expect(feed.list({ kind: "refused" })).toEqual([]);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ reason: expect.stringMatching(/sender is halted/), data: { sender: "halted" } });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    world.at += QUICK_RETRY_SEC;
    expect((await guardian.tick()).settled).toEqual(["101"]);
  });

  it("retries a settle the sender cancelled (it would have reverted by then) shortly, no back-off", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.statuses = ["cancelled"];
    await guardian.tick();
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ error: { name: "Cancelled" }, data: { step: "settle", retryInSec: QUICK_RETRY_SEC } });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
  });

  it("books a settle that halted the sender from the hash that was finally mined at its nonce", async () => {
    const { world, sender, guardian, feed, ledger, reads } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    sender.statuses = ["pending"];
    await guardian.tick();
    expect(feed.list({ kind: "pending" })[0]).toMatchObject({ jobId: "101", data: { step: "settle", nonce: 1, sender: "halted", halt: { reason: "STUCK" } } });
    // a bumped replacement of our settle is mined between loops
    const minedHash = `0x${"5e".repeat(32)}` as const;
    sender.confirmations.set(`0x${"1".padStart(64, "0")}`, { status: "success", txHash: minedHash, minedAs: "intent", gasUsed: 1n, effectiveGasPrice: 1n });
    world.jobs.set(101n, job(101n, { status: "Completed" }));
    const asked: Hex[] = [];
    const orig = reads.settleOutcome;
    reads.settleOutcome = async (h, ...rest) => {
      asked.push(h);
      return orig(h, ...rest);
    };
    const r = await guardian.tick();
    expect(r.settled).toEqual(["101"]);
    expect(asked).toEqual([minedHash]);
    expect(ledger.list({ kind: "income" })[0]).toMatchObject({ jobId: "101", txHash: minedHash, amount: E18.toString() });
    expect(ledger.list({ kind: "income" })[0]).not.toHaveProperty("estimated");
  });

  it("defers its sends while the keeper has a shield to send, and tries again shortly", async () => {
    const { world, sender, guardian, feed } = await setup();
    world.jobs.set(101n, job(101n));
    world.keeperBusy = true;
    const r = await guardian.tick();
    expect(r.submitted).toEqual([]);
    expect(sender.sims).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(feed.list({ source: "guardian" })).toHaveLength(1);
    expect(feed.list({ kind: "noop" })[0]).toMatchObject({ jobId: "101", reason: expect.stringMatching(/keeper/) });
    expect(guardian.nextDelaySec()).toBe(QUICK_RETRY_SEC);
    await guardian.tick();
    expect(feed.list({ source: "guardian" })).toHaveLength(1); // the same wait is not recorded twice
    world.keeperBusy = false;
    const r2 = await guardian.tick();
    expect(r2.settled).toEqual(["101"]);
  });

  it("stops between submit and settle when the keeper becomes busy", async () => {
    const { world, sender, guardian } = await setup();
    world.jobs.set(101n, job(101n));
    const onSend = sender.onSend;
    sender.onSend = (c) => {
      onSend?.(c);
      if (c.fn === "submit") world.keeperBusy = true;
    };
    const r = await guardian.tick();
    expect(r.submitted).toEqual(["101"]);
    expect(sender.sent.map((c) => c.fn)).toEqual(["submit"]);
    world.keeperBusy = false;
    await guardian.tick();
    expect(sender.sent.map((c) => c.fn)).toEqual(["submit", "settle"]);
  });

  it("does not track or book jobs that are already final when first seen", async () => {
    const { world, guardian, ledger, feed, state } = await setup();
    world.jobs.set(101n, job(101n, { status: "Completed" }));
    world.jobs.set(102n, job(102n, { status: "Rejected" }));
    world.jobs.set(103n, job(103n, { status: "Expired" }));
    world.jobs.set(104n, job(104n, { status: "Submitted" }));
    const r = await guardian.tick();
    expect(r.settled).toEqual(["104"]);
    expect(ledger.list({ kind: "income" }).map((e) => (e.kind === "income" ? e.jobId : ""))).toEqual(["104"]);
    expect(feed.list({ source: "guardian" }).every((e) => e.jobId === "104")).toBe(true);
    expect(state.jobs.size).toBe(0);
  });

  it("refuses state written for another chain or guardian, and state that does not say", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "desk-guardian-"));
    const mine = new GuardianState({ dir, chainId: 31337, guardian: d.guardian });
    mine.cursor = 150n;
    await mine.save();
    const stored = JSON.parse(await readFile(path.join(dir, "guardian.json"), "utf8"));
    expect(stored).toMatchObject({ chainId: 31337, guardian: d.guardian, cursor: "150" });
    const same = new GuardianState({ dir, chainId: 31337, guardian: d.guardian.toLowerCase() as Address });
    await same.load();
    expect(same.cursor).toBe(150n);
    await expect(new GuardianState({ dir, chainId: 56, guardian: d.guardian }).load()).rejects.toThrow(/chain 31337/);
    await expect(new GuardianState({ dir, chainId: 31337, guardian: addr(0x77) }).load()).rejects.toThrow(/another guardian/);
    await writeFile(path.join(dir, "guardian.json"), JSON.stringify({ cursor: "150", jobs: {} }));
    await expect(new GuardianState({ dir, chainId: 31337, guardian: d.guardian }).load()).rejects.toThrow(/does not say/);
  });

  it("writes evidence through a temp file and refuses evidence stored for another deployment or job", async () => {
    const { world, sender, guardian, feed, dataDir } = await setup();
    world.jobs.set(101n, job(101n));
    world.jobs.set(102n, job(102n));
    await mkdir(path.join(dataDir, "evidence"), { recursive: true });
    const foreign = buildEvidence({ chainId: 56, kernel: d.external.kernel, guardian: d.guardian, agent: AGENT, jobId: 102n, account: ACCOUNT, start: START, end: END, events: [] });
    await writeFile(evidenceFile(dataDir, 102n), foreign.json);
    const r = await guardian.tick();
    expect(r.settled).toEqual(["101"]);
    expect((await readdir(path.join(dataDir, "evidence"))).sort()).toEqual(["101.json", "102.json"]);
    expect(sender.sims.filter((c) => c.fn === "submit").map((c) => c.args[0])).toEqual([101n]);
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ jobId: "102", error: { name: "EvidenceMismatch" }, data: { step: "submit" } });
  });

  it("isolates a failing job from the others", async () => {
    const { world, guardian, sender, reads } = await setup();
    world.jobs.set(101n, job(101n, { status: "Submitted" }));
    world.jobs.set(102n, job(102n, { status: "Submitted" }));
    const orig = sender.simulate.bind(sender);
    let first = true;
    sender.simulate = async (tx) => {
      if (first) {
        first = false;
        throw new Error("rpc down");
      }
      return orig(tx);
    };
    const r = await guardian.tick();
    expect(r.errors[0]).toMatch(/job 101: rpc down/);
    expect(r.settled).toEqual(["102"]);
    void reads;
  });
});
