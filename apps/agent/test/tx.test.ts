import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, keccak256, parseEther, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listaAccountAbi } from "@ballast/sdk";
import { Feed } from "../src/desk/feed";
import { ChainSender, GasWatch, NonceManager, nonceManagerFor, safeMessage, type BinanceTxApi, type SenderClient } from "../src/desk/tx";

const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000a1" as const;
const tx = { to: TO, data: "0x1234" as Hex, value: 0n };
const notInWindow = encodeErrorResult({ abi: listaAccountAbi, errorName: "NotInShieldWindow" });

function revertError(data: Hex) {
  // The shape viem produces for an eth_call revert: the revert data sits on a cause.
  const cause = Object.assign(new Error("execution reverted"), { name: "ExecutionRevertedError", data });
  return Object.assign(new Error("call reverted"), { name: "CallExecutionError", cause });
}

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { name: "TransactionReceiptNotFoundError" });
const timeout = () => Object.assign(new Error("Timed out while waiting for transaction"), { name: "WaitForTransactionReceiptTimeoutError" });

function stubClient(o: Partial<Record<keyof SenderClient, unknown>> = {}, counts = { pending: 7, latest: 7 }) {
  const sent: Hex[] = [];
  const client = {
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 100_000_000n),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: "pending" | "latest" }) => counts[blockTag]),
    getTransaction: vi.fn(async () => Promise.reject(Object.assign(new Error("tx not found"), { name: "TransactionNotFoundError" }))),
    getTransactionReceipt: vi.fn(async () => Promise.reject(notFound("receipt"))),
    getBalance: vi.fn(async () => parseEther("1")),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash, gasUsed: 90_000n, effectiveGasPrice: 100_000_000n, blockNumber: 5n })),
    ...o,
  };
  return { client: client as unknown as SenderClient, raw: client, sent };
}

function stubBinance(o: Partial<BinanceTxApi> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const api: BinanceTxApi = {
    simulate: async (body) => {
      calls.push({ method: "simulate", body: body as never });
      return { status: "SUCCESS", failReason: null, balanceChanges: [], allowanceChanges: [] };
    },
    broadcast: async (body) => {
      calls.push({ method: "broadcast", body: body as never });
      return { orderId: "1", txHash: keccak256(body.signedTransaction as Hex) };
    },
    ...o,
  };
  return { api, calls };
}

describe("NonceManager", () => {
  it("serializes concurrent sends and hands out consecutive nonces", async () => {
    let active = 0;
    let maxActive = 0;
    const m = new NonceManager(async () => 10);
    const job = (ms: number) =>
      m.run(async (nonce) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        return { consumed: true, value: nonce };
      });
    const nonces = await Promise.all([job(15), job(1), job(5)]);
    expect(nonces).toEqual([10, 11, 12]);
    expect(maxActive).toBe(1);
  });

  it("reuses a nonce that was not consumed and resyncs after a failure", async () => {
    let chain = 3;
    const m = new NonceManager(async () => chain);
    expect(await m.run(async (n) => ({ consumed: false, value: n }))).toBe(3);
    expect(await m.run(async (n) => ({ consumed: true, value: n }))).toBe(3);
    await expect(m.run(async () => Promise.reject(new Error("rpc down")))).rejects.toThrow("rpc down");
    chain = 9; // another sender in the process used the key meanwhile
    expect(await m.run(async (n) => ({ consumed: true, value: n }))).toBe(9);
  });

  it("never goes below the chain's pending nonce", async () => {
    let chain = 1;
    const m = new NonceManager(async () => chain);
    await m.run(async (n) => ({ consumed: true, value: n }));
    chain = 5;
    expect(await m.run(async (n) => ({ consumed: true, value: n }))).toBe(5);
  });

  it("is shared per address within the process", () => {
    const fetch = async () => 0;
    expect(nonceManagerFor(account.address, fetch)).toBe(nonceManagerFor(account.address.toLowerCase() as Hex, fetch));
  });
});

describe("ChainSender.simulate", () => {
  it("uses eth_call without a Binance key and decodes a revert", async () => {
    const { client } = stubClient({ call: vi.fn(async () => Promise.reject(revertError(notInWindow))) });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false });
    expect(await s.simulate(tx)).toEqual({
      via: "rpc",
      ok: false,
      error: { name: "NotInShieldWindow", message: expect.stringContaining("close to a market closure"), args: [] },
    });
  });

  it("uses the Binance Transaction API on mainnet when keyed", async () => {
    const { client, raw } = stubClient();
    const { api, calls } = stubBinance();
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api });
    expect(await s.simulate(tx)).toEqual({ via: "binance", ok: true });
    expect(calls[0]).toEqual({
      method: "simulate",
      body: { binanceChainId: "56", evmTx: { from: account.address, to: TO, value: "0", data: "0x1234" } },
    });
    expect(raw.call).not.toHaveBeenCalled();
  });

  it("decodes a Binance simulation failure with an eth_call replay", async () => {
    const { client } = stubClient({ call: vi.fn(async () => Promise.reject(revertError(notInWindow))) });
    const { api } = stubBinance({
      simulate: async () => ({ status: "FAILED", failReason: "execution reverted", balanceChanges: [], allowanceChanges: [] }),
    });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api });
    const r = await s.simulate(tx);
    expect(r).toMatchObject({ via: "binance", ok: false, error: { name: "NotInShieldWindow" } });
  });

  it("lets eth_call decide when Binance reports a failure the replay does not reproduce, flagging it", async () => {
    const { client } = stubClient();
    const { api } = stubBinance({
      simulate: async () => ({ status: "FAILED", failReason: "unsupported opcode", balanceChanges: [], allowanceChanges: [] }),
    });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api });
    expect(await s.simulate(tx)).toEqual({ via: "rpc", ok: true, disagree: true, note: expect.stringContaining("unsupported opcode") });
  });

  it("in strict mode (restores) fails on any disagreement, in both directions", async () => {
    const failing = stubBinance({ simulate: async () => ({ status: "FAILED", failReason: "x", balanceChanges: [], allowanceChanges: [] }) });
    const s1 = new ChainSender({ client: stubClient().client, account, chainId: 56, dryRun: false, binance: failing.api });
    expect(await s1.simulate(tx, { strict: true })).toMatchObject({ ok: false, disagree: true, error: { name: "SimulatorsDisagree" } });

    const reverting = stubClient({ call: vi.fn(async () => Promise.reject(revertError(notInWindow))) });
    const s2 = new ChainSender({ client: reverting.client, account, chainId: 56, dryRun: false, binance: stubBinance().api });
    expect(await s2.simulate(tx)).toEqual({ via: "binance", ok: true }); // not strict: Binance alone
    expect(await s2.simulate(tx, { strict: true })).toMatchObject({
      ok: false,
      disagree: true,
      error: { name: "SimulatorsDisagree", message: expect.stringContaining("close to a market closure") },
    });

    const agreeing = new ChainSender({ client: stubClient().client, account, chainId: 56, dryRun: false, binance: stubBinance().api });
    expect(await agreeing.simulate(tx, { strict: true })).toEqual({ via: "binance", ok: true });
  });

  it("keeps Binance's reason when the RPC replay is down", async () => {
    const { client } = stubClient({ call: vi.fn(async () => Promise.reject(new Error("fetch failed"))) });
    const { api } = stubBinance({
      simulate: async () => ({ status: "FAILED", failReason: "execution reverted", balanceChanges: [], allowanceChanges: [] }),
    });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api });
    expect(await s.simulate(tx)).toEqual({ via: "binance", ok: false, error: { name: "SimulationFailed", message: "execution reverted" } });
  });

  it("falls back to eth_call when the Binance API is unavailable (geo block) and says so", async () => {
    const { client } = stubClient();
    const { api } = stubBinance({ simulate: async () => Promise.reject(Object.assign(new Error("HTTP 403 code 40304"), { code: "40304" })) });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api });
    expect(await s.simulate(tx)).toEqual({ via: "rpc", ok: true, note: expect.stringContaining("40304") });
  });

  it("never asks Binance to simulate a fork", async () => {
    const { client } = stubClient();
    const { api, calls } = stubBinance();
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, binance: api });
    expect((await s.simulate(tx)).via).toBe("rpc");
    expect(calls).toEqual([]);
  });

  it("rethrows RPC outages instead of recording them as refusals", async () => {
    const { client } = stubClient({ call: vi.fn(async () => Promise.reject(new Error("fetch failed"))) });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false });
    await expect(s.simulate(tx)).rejects.toThrow("fetch failed");
  });
});

describe("ChainSender.send", () => {
  it("signs locally and broadcasts a sale through Binance with MEV protection", async () => {
    const { client, sent } = stubClient();
    const { api, calls } = stubBinance();
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api, nonces: new NonceManager(async () => 7) });
    const r = await s.send(tx, { mevProtect: true });
    const body = calls.find((c) => c.method === "broadcast")!.body;
    expect(body).toMatchObject({ binanceChainId: "56", address: account.address, enableMevProtection: true });
    const signed = body.signedTransaction as Hex;
    expect(parseTransaction(signed)).toMatchObject({ to: TO, nonce: 7, chainId: 56, gas: 120_000n, gasPrice: 100_000_000n });
    expect(r).toEqual({
      ok: true,
      txHash: keccak256(signed),
      via: "binance",
      status: "success",
      nonce: 7,
      gasPrice: 100_000_000n,
      gasUsed: 90_000n,
      effectiveGasPrice: 100_000_000n,
      blockNumber: 5n,
    });
    expect(sent).toEqual([]);
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(signed.slice(2, 60));
  });

  it("sends everything else through the RPC even when keyed", async () => {
    const { client, sent } = stubClient();
    const { api, calls } = stubBinance();
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api, nonces: new NonceManager(async () => 7) });
    expect(await s.send(tx)).toMatchObject({ ok: true, via: "rpc", status: "success" });
    expect(calls.filter((c) => c.method === "broadcast")).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("builds the transaction inside the critical section and aborts without using the nonce", async () => {
    const { client, sent } = stubClient();
    const nonces = new NonceManager(async () => 3);
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, nonces });
    const order: string[] = [];
    const slow = s.send(async () => {
      order.push("build 1");
      await new Promise((r) => setTimeout(r, 10));
      return tx;
    });
    const aborted = s.send(async () => {
      order.push("build 2");
      return null;
    });
    expect(await slow).toMatchObject({ ok: true, nonce: 3 });
    expect(await aborted).toEqual({ ok: false, stage: "aborted" });
    expect(order).toEqual(["build 1", "build 2"]);
    expect(sent).toHaveLength(1);
    expect(await s.send(tx)).toMatchObject({ nonce: 4 });
  });

  it("sends the same signed transaction through the RPC when the Binance broadcast fails", async () => {
    const { client, sent } = stubClient();
    const { api } = stubBinance({ broadcast: async () => Promise.reject(new Error("HTTP 403 code 40304")) });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api, nonces: new NonceManager(async () => 7) });
    const r = await s.send(tx, { mevProtect: true });
    expect(r).toMatchObject({ ok: true, via: "rpc", note: expect.stringContaining("40304") });
    expect(sent).toHaveLength(1);
    expect(r.ok && r.txHash).toBe(keccak256(sent[0]!));
  });

  it("uses the RPC without a key and consumes nonces in order", async () => {
    const { client, sent } = stubClient();
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, nonces: new NonceManager(async () => 0) });
    await Promise.all([s.send(tx), s.send(tx)]);
    expect(sent.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1]);
  });

  it("reports a revert at gas estimation without consuming the nonce", async () => {
    const { client, sent } = stubClient({ estimateGas: vi.fn(async () => Promise.reject(revertError(notInWindow))) });
    const nonces = new NonceManager(async () => 4);
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, nonces });
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "estimate", error: { name: "NotInShieldWindow" } });
    expect(sent).toEqual([]);
    expect(await nonces.run(async (n) => ({ consumed: false, value: n }))).toBe(4);
  });

  it("reports an on-chain revert from the receipt", async () => {
    const { client } = stubClient({
      waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ status: "reverted", transactionHash: hash, gasUsed: 50_000n, effectiveGasPrice: 1n, blockNumber: 6n })),
    });
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, nonces: new NonceManager(async () => 0) });
    expect(await s.send(tx)).toMatchObject({ ok: true, status: "reverted" });
  });

  it("throws a broadcast failure (the caller records it)", async () => {
    const { client } = stubClient({ sendRawTransaction: vi.fn(async () => Promise.reject(new Error("insufficient funds for gas"))) });
    const s = new ChainSender({ client, account, chainId: 31337, dryRun: false, nonces: new NonceManager(async () => 0) });
    await expect(s.send(tx)).rejects.toThrow(/broadcast failed: insufficient funds/);
  });

  it("refuses to send in DRY_RUN", async () => {
    const { client, raw } = stubClient();
    const s = new ChainSender({ client, account, chainId: 56, dryRun: true });
    await expect(s.send(tx)).rejects.toThrow(/DRY_RUN/);
    expect(raw.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps raw transactions and request bodies out of error messages", () => {
    const raw = `0x${"ab".repeat(200)}`;
    const err = Object.assign(new Error(`RPC Request failed.\n\nRequest body: {"params":["${raw}"]}\n\nDetails: nonce too low`), {
      shortMessage: "RPC Request failed.",
      details: "nonce too low",
    });
    const m = safeMessage(err);
    expect(m).not.toContain("abab");
    expect(m).toContain("nonce too low");
    expect(safeMessage(new Error(`bad ${raw}`))).toBe("bad 0x[400 hex chars]");
  });
});

describe("ChainSender after a receipt timeout", () => {
  /** A sender whose first receipt wait times out; `later` answers the waits after that. */
  function stuck(o: Partial<Record<keyof SenderClient, unknown>> = {}, counts = { pending: 7, latest: 7 }, later: () => Promise<unknown> = async () => Promise.reject(timeout())) {
    let waits = 0;
    const stub = stubClient(
      {
        waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
          waits++;
          if (waits === 1) throw timeout();
          const r = await later();
          return { ...(r as object), transactionHash: hash };
        }),
        ...o,
      },
      counts,
    );
    const nonces = new NonceManager(
      async () => counts.pending,
      async () => counts.latest,
    );
    const s = new ChainSender({ client: stub.client, account, chainId: 31337, dryRun: false, nonces, receiptTimeoutMs: 1, retryTimeoutMs: 1 });
    return { ...stub, s, counts };
  }

  it("rebroadcasts the same bytes once when the node lost it, then reports it pending and replaces it next time", async () => {
    const { s, sent, counts } = stuck();
    const r = await s.send(tx);
    expect(r).toMatchObject({ ok: true, status: "pending", nonce: 7, note: expect.stringMatching(/rebroadcast once/) });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    counts.pending = 8; // the node may count it once it is back in the mempool
    await s.send(tx);
    const replacement = parseTransaction(sent[2]!);
    expect(replacement.nonce).toBe(7);
    expect(replacement.gasPrice).toBe(112_500_000n); // +12.5% over the stuck one
  });

  it("does not rebroadcast a transaction the node still holds, but still frees its nonce", async () => {
    let price = 100_000_000n;
    const { s, sent } = stuck({ getTransaction: vi.fn(async () => ({ hash: "0x" })), getGasPrice: vi.fn(async () => price) });
    expect(await s.send(tx)).toMatchObject({ status: "pending" });
    expect(sent).toHaveLength(1);
    price = 200_000_000n; // the network moved above the bump: pay the network price
    await s.send(tx);
    expect(parseTransaction(sent[1]!)).toMatchObject({ nonce: 7, gasPrice: 200_000_000n });
  });

  it("uses a receipt that arrives during the retry window", async () => {
    const { s, sent } = stuck({}, { pending: 7, latest: 7 }, async () => ({ status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 9n }));
    expect(await s.send(tx)).toMatchObject({ status: "success", blockNumber: 9n });
    expect(sent).toHaveLength(2);
    expect(await s.send(tx)).toMatchObject({ nonce: 8 });
  });

  it("reads a late receipt once the nonce has moved on", async () => {
    const { s } = stuck({ getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 8n })) }, { pending: 7, latest: 8 });
    expect(await s.send(tx)).toMatchObject({ status: "success", blockNumber: 8n });
  });

  it("reports a transaction whose nonce another one took as dropped", async () => {
    const { s, sent, counts } = stuck({}, { pending: 7, latest: 8 });
    expect(await s.send(tx)).toMatchObject({ status: "dropped", nonce: 7 });
    expect(sent).toHaveLength(1);
    counts.pending = 8;
    expect(parseTransaction((await s.send(tx), sent[1]!)).nonce).toBe(8);
  });

  it("stops replacing once the stuck transaction was mined", async () => {
    const { s, sent, counts } = stuck();
    await s.send(tx);
    counts.pending = 8;
    counts.latest = 8;
    await s.send(tx);
    expect(parseTransaction(sent[2]!)).toMatchObject({ nonce: 8, gasPrice: 100_000_000n });
  });
});

describe("ChainSender.confirm", () => {
  const receipt = (status: string) => vi.fn(async ({ hash }: { hash: Hex }) => ({ status, transactionHash: hash, gasUsed: 2n, effectiveGasPrice: 3n, blockNumber: 4n }));
  const H = `0x${"ab".repeat(32)}` as Hex;

  it("reads mined transactions", async () => {
    const ok = new ChainSender({ client: stubClient({ getTransactionReceipt: receipt("success") }).client, account, chainId: 31337, dryRun: false });
    expect(await ok.confirm(H, 7)).toEqual({ status: "success", gasUsed: 2n, effectiveGasPrice: 3n, blockNumber: 4n });
    const bad = new ChainSender({ client: stubClient({ getTransactionReceipt: receipt("reverted") }).client, account, chainId: 31337, dryRun: false });
    expect((await bad.confirm(H)).status).toBe("reverted");
  });

  it("is pending until the nonce moves past it without a receipt, then dropped", async () => {
    const counts = { pending: 8, latest: 7 };
    const s = new ChainSender({ client: stubClient({}, counts).client, account, chainId: 31337, dryRun: false });
    expect((await s.confirm(H, 7)).status).toBe("pending");
    counts.latest = 8;
    expect((await s.confirm(H, 7)).status).toBe("dropped");
    expect((await s.confirm(H)).status).toBe("pending");
  });

  it("rethrows RPC failures", async () => {
    const s = new ChainSender({ client: stubClient({ getTransactionReceipt: vi.fn(async () => Promise.reject(new Error("fetch failed"))) }).client, account, chainId: 31337, dryRun: false });
    await expect(s.confirm(H)).rejects.toThrow("fetch failed");
  });
});

describe("GasWatch", () => {
  it("alerts once when the desk key runs low and again after a recovery", async () => {
    let balance = parseEther("0.01");
    const feed = new Feed({ dir: await mkdtemp(path.join(tmpdir(), "desk-gas-")), secrets: [] });
    const w = new GasWatch({ sender: { address: account.address, balance: async () => balance }, feed, minWei: parseEther("0.003") });
    expect(await w.check("keeper")).toBe(parseEther("0.01"));
    balance = parseEther("0.002");
    await w.check("keeper");
    await w.check("publisher");
    expect(feed.list({ kind: "alert" })).toHaveLength(1);
    expect(feed.list({ kind: "alert" })[0]!.reason).toMatch(/0\.002 BNB, below 0\.003 BNB/);
    balance = parseEther("1");
    await w.check("keeper");
    balance = 0n;
    await w.check("keeper");
    expect(feed.list({ kind: "alert" })).toHaveLength(2);
  });

  it("stays quiet when the balance cannot be read", async () => {
    const feed = new Feed({ dir: await mkdtemp(path.join(tmpdir(), "desk-gas-")), secrets: [] });
    const w = new GasWatch({ sender: { address: account.address, balance: async () => Promise.reject(new Error("rpc down")) }, feed, minWei: 1n });
    expect(await w.check("keeper")).toBeNull();
    expect(feed.list()).toEqual([]);
  });
});
