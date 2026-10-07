import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DisagreementWatch, Feed } from "../src/desk/feed";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "desk-feed-"));
}

describe("Feed", () => {
  it("appends JSONL with a sequence number and keeps bigints as decimal strings", async () => {
    const dir = await tempDir();
    const feed = new Feed({ dir, secrets: [], clock: () => 1_790_000_000 });
    const e = await feed.record({ kind: "shield", source: "keeper", account: A, symbol: "NVDA", plan: { debt: 10n ** 21n } });
    expect(e).toMatchObject({ seq: 1, ts: 1_790_000_000, kind: "shield", plan: { debt: "1000000000000000000000" } });
    const lines = (await readFile(path.join(dir, "feed.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(e);
  });

  it("lists newest first, filtered by account and kind, from a bounded ring", async () => {
    const feed = new Feed({ dir: await tempDir(), secrets: [], ringSize: 3 });
    await feed.record({ kind: "noop", source: "keeper", account: A, reason: "1" });
    await feed.record({ kind: "shield", source: "keeper", account: B, reason: "2" });
    await feed.record({ kind: "refused", source: "keeper", account: A, reason: "3" });
    await feed.record({ kind: "noop", source: "keeper", account: A, reason: "4" });
    expect(feed.list().map((e) => e.reason)).toEqual(["4", "3", "2"]);
    expect(feed.list({ account: A.toUpperCase().replace("0X", "0x") }).map((e) => e.reason)).toEqual(["4", "3"]);
    expect(feed.list({ kind: "refused" }).map((e) => e.reason)).toEqual(["3"]);
    expect(feed.list({ limit: 1 }).map((e) => e.reason)).toEqual(["4"]);
  });

  it("scrubs configured secrets from every stored line", async () => {
    const dir = await tempDir();
    const secret = "https://bsc.example/v1/key-abc123";
    const feed = new Feed({ dir, secrets: [secret, ""] });
    const e = await feed.record({ kind: "refused", source: "publisher", reason: `fetch ${secret} failed` });
    expect(e.reason).toBe("fetch [redacted] failed");
    expect(await readFile(path.join(dir, "feed.jsonl"), "utf8")).not.toContain("key-abc123");
  });

  it("never stores a client or config object's secrets, even when one is passed by mistake", async () => {
    const dir = await tempDir();
    const rpc = "https://bsc.example/v1/key-abc123";
    const pk = `0x${"4f".repeat(32)}`;
    const feed = new Feed({ dir, secrets: [rpc, "v1/key-abc123", pk, pk.slice(2)] });
    // A viem-like client carries the URL in its transport; a config-like object carries keys.
    const client = { chain: { rpcUrls: { default: { http: [rpc] } } }, transport: { url: rpc, key: "http" } };
    await feed.record({ kind: "alert", source: "keeper", data: { client, signer: { privateKey: pk }, msg: `rpc v1/key-abc123 failed` } });
    const stored = await readFile(path.join(dir, "feed.jsonl"), "utf8");
    const listed = JSON.stringify(feed.list());
    for (const out of [stored, listed]) {
      expect(out).not.toContain("key-abc123");
      expect(out).not.toContain("4f4f4f4f");
    }
  });

  it("reloads the tail from disk and continues the sequence", async () => {
    const dir = await tempDir();
    const first = new Feed({ dir, secrets: [] });
    await first.record({ kind: "noop", source: "keeper", account: A });
    await first.record({ kind: "shield", source: "keeper", account: A, txHash: "0x01" });
    const second = new Feed({ dir, secrets: [] });
    await second.load();
    expect(second.list().map((e) => e.seq)).toEqual([2, 1]);
    expect((await second.record({ kind: "noop", source: "keeper" })).seq).toBe(3);
  });

  it("skips torn or foreign lines on load", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "feed.jsonl"), '{"seq":4,"ts":1,"kind":"noop","source":"keeper"}\n{"seq":5,"ts":\nnot json\n');
    const feed = new Feed({ dir, secrets: [] });
    await feed.load();
    expect(feed.list().map((e) => e.seq)).toEqual([4]);
  });

  it("keeps recording in memory when the disk write fails", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "blocker");
    await writeFile(file, "x");
    const errors: string[] = [];
    const feed = new Feed({ dir: path.join(file, "sub"), secrets: [], onError: (m) => errors.push(m) });
    const e = await feed.record({ kind: "noop", source: "keeper" });
    expect(e.seq).toBe(1);
    expect(feed.list()).toHaveLength(1);
    expect(errors.join(" ")).toMatch(/feed write failed/);
  });

  it("finds the debt before the first broadcast shield since the last broadcast restore", async () => {
    const feed = new Feed({ dir: await tempDir(), secrets: [] });
    const shield = (debt: string, txHash?: `0x${string}`) =>
      feed.record({ kind: "shield", source: "keeper", account: A, plan: { debtBefore: debt }, ...(txHash ? { txHash } : {}) });
    expect(feed.preShieldDebt(A)).toBeNull();
    await shield("900", "0x01");
    await feed.record({ kind: "restore", source: "keeper", account: A, txHash: "0x02" });
    await shield("1000", "0x03");
    await shield("950"); // simulated only (dry run): not a cycle start
    await shield("940", "0x04");
    await feed.record({ kind: "restore", source: "keeper", account: A }); // refused or dry-run restore: cycle still open
    await feed.record({ kind: "shield", source: "keeper", account: B, plan: { debtBefore: "5" }, txHash: "0x05" });
    expect(feed.preShieldDebt(A)).toBe(1000n);
    await feed.record({ kind: "restore", source: "keeper", account: A, txHash: "0x06" });
    expect(feed.preShieldDebt(A)).toBeNull();
    expect(feed.preShieldDebt(B)).toBe(5n);
  });

  it("sums what the keeper repaid in the open cycle, from confirmed shields only", async () => {
    const feed = new Feed({ dir: await tempDir(), secrets: [] });
    const shield = (before: string, after: string | undefined, ltvBps: number, txHash?: `0x${string}`) =>
      feed.record({ kind: "shield", source: "keeper", account: A, txHash, plan: { debtBefore: before, ...(after ? { debtAfter: after } : {}), ltvBps } });
    await shield("1000", "900", 7200, "0x01");
    await feed.record({ kind: "pending", source: "keeper", account: A, txHash: "0x02", plan: { debtBefore: "900" } });
    await shield("900", "850", 6900, "0x03");
    await shield("850", "800", 6800); // dry run: no hash
    expect(feed.shieldCycle(A)).toEqual({ preShieldDebt: 1000n, preShieldLtvBps: 7200, postShieldDebt: 850n, repaid: 150n, shields: 2 });
    await feed.record({ kind: "noop", source: "keeper", account: A, reason: "owner repaid", data: { cycleClosed: true } });
    expect(feed.shieldCycle(A)).toBeNull();
    await shield("700", undefined, 6000, "0x04"); // post-send read failed: counts as nothing repaid
    expect(feed.shieldCycle(A)).toMatchObject({ preShieldDebt: 700n, postShieldDebt: null, repaid: 0n });
  });

  it("lists pending transactions no later event resolved", async () => {
    const feed = new Feed({ dir: await tempDir(), secrets: [] });
    await feed.record({ kind: "pending", source: "keeper", account: A, txHash: "0xaa" });
    await feed.record({ kind: "pending", source: "keeper", account: B, txHash: "0xbb" });
    await feed.record({ kind: "pending", source: "publisher", txHash: "0xcc" });
    await feed.record({ kind: "shield", source: "keeper", account: A, txHash: "0xAA" });
    expect(feed.unresolvedPending("keeper").map((e) => e.txHash)).toEqual(["0xbb"]);
    expect(feed.unresolvedPending("publisher").map((e) => e.txHash)).toEqual(["0xcc"]);
  });
});

describe("DisagreementWatch", () => {
  it("makes one finding after three disagreements within a day", async () => {
    const feed = new Feed({ dir: await tempDir(), secrets: [] });
    const w = new DisagreementWatch(feed, "keeper");
    const sim = { via: "rpc" as const, ok: true, disagree: true, note: "binance said FAILED" };
    await w.note({ via: "binance", ok: true }, 0); // agreement: not counted
    await w.note(sim, 100);
    await w.note(sim, 200);
    expect(feed.list()).toEqual([]);
    await w.note(sim, 300);
    await w.note(sim, 400);
    expect(feed.list({ kind: "finding" })).toMatchObject([{ source: "keeper", reason: expect.stringMatching(/disagreed 3 times/) }]);
    await w.note(sim, 90_000);
    await w.note(sim, 90_100);
    await w.note(sim, 90_200);
    expect(feed.list({ kind: "finding" })).toHaveLength(2);
  });
});
