import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress, toHex, type Address } from "viem";
import type { TxRequest } from "@ballast/sdk";
import { GasBook, Ledger, ledgerSender, stableUsd } from "../src/desk/ledger";
import type { Confirmation, SendResult, TxSender } from "../src/desk/tx";

const addr = (n: number): Address => getAddress(toHex(n, { size: 20 }));
const DAY = 86_400;
const T0 = 20_000 * DAY + 3600;

const tmp = () => mkdtemp(path.join(tmpdir(), "desk-ledger-"));

const x402 = (usd: number) => ({
  kind: "x402" as const,
  source: "x402" as const,
  resource: "https://data.example/earnings",
  network: "eip155:56",
  asset: addr(1),
  symbol: "USD1",
  amount: String(BigInt(Math.round(usd * 1e6)) * 10n ** 12n),
  usd,
  payTo: addr(2),
  status: "signed" as const,
});

describe("Ledger", () => {
  it("enforces the daily x402 cap per UTC day, counting failed payments", async () => {
    let now = T0;
    const l = new Ledger({ dir: await tmp(), x402DailyCapUsd: 0.05, clock: () => now });
    expect(l.x402Allows(0.03)).toBe(true);
    const e = await l.record(x402(0.03));
    await l.updateX402(e.id, { status: "failed", note: "merchant returned 500" });
    expect(l.x402SpentToday()).toBe(0.03);
    expect(l.x402Allows(0.02)).toBe(true);
    expect(l.x402Allows(0.021)).toBe(false);
    await l.record(x402(0.02));
    expect(l.x402Allows(0.000001)).toBe(false);
    now = T0 + DAY;
    expect(l.x402SpentToday()).toBe(0);
    expect(l.x402Allows(0.05)).toBe(true);
    expect(l.x402Allows(Number.NaN)).toBe(false);
  });

  it("persists and reloads entries, continuing ids", async () => {
    const dir = await tmp();
    const a = new Ledger({ dir, x402DailyCapUsd: 0.5, clock: () => T0 });
    await a.record({ kind: "income", source: "guardian", jobId: "7", token: addr(3), symbol: "USD1", amount: "1000000000000000000", decimals: 18, usd: 1, outcome: "complete" });
    await a.record({ kind: "gas", source: "keeper", txHash: `0x${"11".repeat(32)}`, status: "success", gasUsed: "21000", effectiveGasPrice: "100000000", feeWei: "2100000000000" });
    const b = new Ledger({ dir, x402DailyCapUsd: 0.5, clock: () => T0 });
    await b.load();
    expect(b.list().map((e) => e.kind)).toEqual(["gas", "income"]);
    const c = await b.record(x402(0.01));
    expect(c.id).toBe(3);
    expect(b.summary()).toEqual({ incomeUsd: 1, x402Usd: 0.01, gasWei: "2100000000000", gasBnb: "0.0000021", transactions: 1, jobsPaid: 1 });
    expect(JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8")).entries).toHaveLength(3);
  });

  it("books a guardian job's income once, also after a reload", async () => {
    const dir = await tmp();
    const income = { kind: "income" as const, source: "guardian" as const, jobId: "7", token: addr(3), symbol: "USD1", amount: "1000000000000000000", decimals: 18, usd: 1, outcome: "complete" as const };
    const a = new Ledger({ dir, x402DailyCapUsd: 0.5, clock: () => T0 });
    const first = await a.record(income);
    expect(await a.record({ ...income, estimated: true })).toBe(first);
    const b = new Ledger({ dir, x402DailyCapUsd: 0.5, clock: () => T0 });
    await b.load();
    await b.record({ ...income, amount: "5" });
    await b.record({ ...income, jobId: "8" });
    expect(b.list({ kind: "income" }).map((e) => (e.kind === "income" ? `${e.jobId}:${e.amount}` : ""))).toEqual(["8:1000000000000000000", "7:1000000000000000000"]);
    expect(b.summary().incomeUsd).toBe(2);
  });

  it("keeps an unreadable file aside instead of overwriting it", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "ledger.json"), "{not json");
    const errors: string[] = [];
    const l = new Ledger({ dir, x402DailyCapUsd: 0.5, onError: (m) => errors.push(m) });
    await l.load();
    expect(errors[0]).toMatch(/unreadable/);
    expect(await readFile(path.join(dir, "ledger.json.bad"), "utf8")).toBe("{not json");
  });

  it("values only stablecoins in USD", () => {
    expect(stableUsd("USD1", 25n * 10n ** 16n, 18)).toBe(0.25);
    expect(stableUsd("WBNB", 10n ** 18n, 18)).toBeNull();
  });
});

describe("ledgerSender", () => {
  const tx: TxRequest = { to: addr(9), data: "0x", value: 0n };
  const H = (b: string) => `0x${b.repeat(32)}` as const;
  const sender = (r: SendResult): TxSender => ({
    address: addr(0xee),
    dryRun: false,
    simulate: async () => ({ via: "rpc", ok: true }),
    send: async () => r,
  });
  const mined = (o: Partial<Extract<SendResult, { ok: true }>> = {}): SendResult => ({
    ok: true,
    txHash: H("aa"),
    via: "rpc",
    status: "success",
    nonce: 7,
    gasPrice: 10n ** 9n,
    minedAs: "intent",
    gasUsed: 50_000n,
    effectiveGasPrice: 2n * 10n ** 9n,
    ...o,
  });
  const book = async () => {
    const l = new Ledger({ dir: await tmp(), x402DailyCapUsd: 0.5, clock: () => T0 });
    return { l, b: new GasBook(l) };
  };

  it("books the mined hash once per nonce at the effective gas price, reverted ones included", async () => {
    const { l, b } = await book();
    const r = mined({ status: "reverted" });
    expect(await ledgerSender(sender(r), b, "publisher").send(tx)).toBe(r);
    expect(l.list()).toHaveLength(1);
    expect(l.list()[0]).toMatchObject({ kind: "gas", source: "publisher", status: "reverted", nonce: 7, minedAs: "intent", txHash: H("aa"), feeWei: (50_000n * 2n * 10n ** 9n).toString() });
    // the same nonce reported again by another loop (a recover at startup, a later confirm): still one entry
    await ledgerSender(sender(mined({ status: "reverted" })), b, "keeper").send(tx);
    await b.book("other", { txHash: H("bb"), nonce: 7, status: "success", gasUsed: 1n, effectiveGasPrice: 1n });
    expect(l.list()).toHaveLength(1);
  });

  it("books a mined cancel and a fallback under their own labels", async () => {
    const { l, b } = await book();
    await ledgerSender(sender(mined({ status: "dropped", minedAs: "cancel", nonce: 8, txHash: H("c1"), gasUsed: 21_000n })), b, "keeper").send(tx);
    await ledgerSender(sender(mined({ minedAs: "fallback", nonce: 9, txHash: H("f1") })), b, "keeper").send(tx);
    const [fallback, cancel] = l.list();
    expect(cancel).toMatchObject({ status: "cancelled", minedAs: "cancel", nonce: 8, feeWei: (21_000n * 2n * 10n ** 9n).toString() });
    expect(fallback).toMatchObject({ status: "success", minedAs: "fallback", nonce: 9 });
    expect(l.summary().transactions).toBe(2);
  });

  it("books nothing for a pending, replaced-by-others, halted or refused send", async () => {
    const { l, b } = await book();
    const halt = { reason: "STUCK" as const, message: "nonce 3 is not mined after 4 replacement rounds", nonce: 3, since: T0 };
    for (const r of [
      { ok: true, txHash: H("aa"), via: "rpc", status: "pending", nonce: 3, gasPrice: 1n, halted: halt },
      { ok: true, txHash: H("aa"), via: "rpc", status: "dropped", nonce: 3, gasPrice: 1n },
      { ok: false, stage: "estimate", error: { name: "X", message: "x" } },
      { ok: false, stage: "aborted" },
      { ok: false, stage: "halted", halt },
    ] satisfies SendResult[]) {
      await ledgerSender(sender(r), b, "keeper").send(tx);
    }
    expect(l.list()).toEqual([]);
  });

  it("books a pending send from confirm(): the hash that was mined at its nonce, once", async () => {
    const { l, b } = await book();
    const inner = sender({ ok: true, txHash: H("aa"), via: "rpc", status: "pending", nonce: 3, gasPrice: 10n ** 9n });
    // the transaction asked about was replaced: a bumped one was mined at the same nonce
    inner.confirm = async () => ({ status: "success", txHash: H("ab"), minedAs: "intent", gasUsed: 21_000n, effectiveGasPrice: 10n ** 9n });
    const w = ledgerSender(inner, b, "keeper");
    await w.send(tx);
    expect(await w.confirm!(H("aa"), 3)).toMatchObject({ status: "success", txHash: H("ab") });
    await w.confirm!(H("aa"), 3);
    await ledgerSender(inner, b, "guardian").confirm!(H("aa"), 3);
    expect(l.list()).toHaveLength(1);
    expect(l.list()[0]).toMatchObject({ kind: "gas", txHash: H("ab"), nonce: 3, feeWei: (21_000n * 10n ** 9n).toString() });
  });

  it("never books a mined hash twice across restarts", async () => {
    const dir = await tmp();
    const l1 = new Ledger({ dir, x402DailyCapUsd: 0.5 });
    await new GasBook(l1).book("keeper", { txHash: H("aa"), nonce: 7, status: "success", minedAs: "intent", gasUsed: 5n, effectiveGasPrice: 5n });
    const l2 = new Ledger({ dir, x402DailyCapUsd: 0.5 });
    await l2.load();
    await new GasBook(l2).book("other", { txHash: H("AA"), nonce: 7, status: "success", minedAs: "intent", gasUsed: 5n, effectiveGasPrice: 5n });
    expect(l2.list()).toHaveLength(1);
  });

  it("passes the whole sender through: options, confirm, balance, state", async () => {
    const { b } = await book();
    const seen: unknown[] = [];
    const state = { sales: "protected" as const, halted: null, outstanding: { nonce: 4, hashes: [H("aa")], gasPrice: 1n, rounds: 1, kind: "intent" as const }, spentLastHourWei: 9n };
    const inner: TxSender = {
      address: addr(0xee),
      dryRun: true,
      simulate: async (_t, o) => {
        seen.push(o);
        return { via: "rpc", ok: true };
      },
      send: async (_t, o) => {
        seen.push(o);
        return { ok: false, stage: "aborted" };
      },
      confirm: async () => ({ status: "pending" }),
      balance: async () => 5n,
      state: () => state,
    };
    const w = ledgerSender(inner, b, "keeper");
    const fallback = async () => null;
    await w.simulate(tx, { strict: true });
    await w.send(async () => tx, { mevProtect: true, fallback });
    expect(seen).toEqual([{ strict: true }, { mevProtect: true, fallback }]);
    expect([w.address, w.dryRun, await w.balance!(), w.state!()]).toEqual([addr(0xee), true, 5n, state]);
    expect(await w.confirm!(H("aa"), 4)).toEqual({ status: "pending" });
    // a sender without the optional calls stays without them
    const bare = ledgerSender(sender({ ok: false, stage: "aborted" }), b, "keeper");
    expect([bare.confirm, bare.balance, bare.state, bare.recover]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("books what recover() settled, under the loop that sent it", async () => {
    const { l, b } = await book();
    // the publisher's send halted the sender; the keeper's recover() later finds it mined (a replacement)
    const inner = sender({ ok: true, txHash: H("aa"), via: "rpc", status: "pending", nonce: 3, gasPrice: 10n ** 9n });
    await ledgerSender(inner, b, "publisher").send(tx);
    inner.recover = async () => mined({ nonce: 3, txHash: H("ab") });
    await ledgerSender(inner, b, "keeper").recover!();
    await ledgerSender(inner, b, "keeper").recover!();
    expect(l.list()).toHaveLength(1);
    expect(l.list()[0]).toMatchObject({ source: "publisher", nonce: 3, txHash: H("ab") });
    // nothing in flight: recover() answers null and nothing is booked
    inner.recover = async () => null;
    await ledgerSender(inner, b, "keeper").recover!();
    expect(l.list()).toHaveLength(1);
  });

  it("follows a send that ended pending until its nonce is mined, even when no loop asks about it again", async () => {
    const { l, b } = await book();
    // the publisher never confirms its pending posts; the sender settles the nonce inside a later send
    let confirmation: Confirmation = { status: "pending" };
    const asked: [string, number | undefined][] = [];
    const inner = sender({ ok: true, txHash: H("aa"), via: "rpc", status: "pending", nonce: 3, gasPrice: 10n ** 9n });
    inner.confirm = async (h, n) => {
      asked.push([h, n]);
      return confirmation;
    };
    const publisher = ledgerSender(inner, b, "publisher");
    await publisher.send(tx);
    const keeper = ledgerSender(sender(mined({ nonce: 4, txHash: H("b4") })), b, "keeper");
    // still pending: asked, nothing booked for nonce 3
    await ledgerSender({ ...inner, send: async () => mined({ nonce: 4, txHash: H("b4") }) }, b, "keeper").send(tx);
    expect(asked).toEqual([[H("aa"), 3]]);
    expect(l.list().map((e) => (e.kind === "gas" ? e.nonce : -1))).toEqual([4]);
    // mined meanwhile as a bumped replacement
    confirmation = { status: "success", txHash: H("ab"), minedAs: "intent", gasUsed: 21_000n, effectiveGasPrice: 3n * 10n ** 9n };
    await ledgerSender({ ...inner, send: async () => mined({ nonce: 5, txHash: H("b5") }) }, b, "guardian").send(tx);
    await ledgerSender({ ...inner, send: async () => mined({ nonce: 6, txHash: H("b6") }) }, b, "guardian").send(tx);
    const three = l.list().find((e) => e.kind === "gas" && e.nonce === 3);
    expect(three).toMatchObject({ source: "publisher", txHash: H("ab"), feeWei: (21_000n * 3n * 10n ** 9n).toString() });
    expect(l.list().filter((e) => e.kind === "gas" && e.nonce === 3)).toHaveLength(1);
    expect(asked).toHaveLength(2); // settled: not asked about again
    void keeper;
  });

  it("stops following a pending send whose nonce went to a transaction that is not ours", async () => {
    const { l, b } = await book();
    const inner = sender({ ok: true, txHash: H("aa"), via: "rpc", status: "pending", nonce: 3, gasPrice: 10n ** 9n });
    let calls = 0;
    inner.confirm = async () => {
      calls++;
      return { status: "dropped" };
    };
    const w = ledgerSender(inner, b, "publisher");
    await w.send(tx);
    inner.send = async () => ({ ok: false, stage: "aborted" });
    await w.send(tx);
    await w.send(tx);
    expect(calls).toBe(1);
    expect(l.list()).toEqual([]);
  });
});
