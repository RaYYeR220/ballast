import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress, toHex, type Address } from "viem";
import type { TxRequest } from "@ballast/sdk";
import { Ledger, ledgerSender, stableUsd } from "../src/desk/ledger";
import type { SendResult, TxSender } from "../src/desk/tx";

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
  const sender = (r: SendResult): TxSender => ({
    address: addr(0xee),
    dryRun: false,
    simulate: async () => ({ via: "rpc", ok: true }),
    send: async () => r,
  });

  it("books gas for mined transactions, reverted ones included", async () => {
    const l = new Ledger({ dir: await tmp(), x402DailyCapUsd: 0.5, clock: () => T0 });
    const ok: SendResult = { ok: true, txHash: `0x${"aa".repeat(32)}`, via: "rpc", status: "reverted", gasUsed: 50_000n, effectiveGasPrice: 10n ** 9n };
    expect(await ledgerSender(sender(ok), l, "publisher").send(tx)).toBe(ok);
    expect(l.list()[0]).toMatchObject({ kind: "gas", source: "publisher", status: "reverted", feeWei: (50_000n * 10n ** 9n).toString() });
  });

  it("books nothing without a receipt or on an estimate refusal", async () => {
    const l = new Ledger({ dir: await tmp(), x402DailyCapUsd: 0.5 });
    await ledgerSender(sender({ ok: true, txHash: `0x${"aa".repeat(32)}`, via: "rpc", status: "unknown" }), l, "keeper").send(tx);
    await ledgerSender(sender({ ok: false, stage: "estimate", error: { name: "X", message: "x" } }), l, "keeper").send(tx);
    expect(l.list()).toEqual([]);
  });
});
