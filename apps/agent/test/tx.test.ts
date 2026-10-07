import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listaAccountAbi } from "@ballast/sdk";
import { ChainSender, NonceManager, nonceManagerFor, safeMessage, type BinanceTxApi, type SenderClient } from "../src/desk/tx";

const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000a1" as const;
const tx = { to: TO, data: "0x1234" as Hex, value: 0n };
const notInWindow = encodeErrorResult({ abi: listaAccountAbi, errorName: "NotInShieldWindow" });

function revertError(data: Hex) {
  // The shape viem produces for an eth_call revert: the revert data sits on a cause.
  const cause = Object.assign(new Error("execution reverted"), { name: "ExecutionRevertedError", data });
  return Object.assign(new Error("call reverted"), { name: "CallExecutionError", cause });
}

function stubClient(o: Partial<Record<keyof SenderClient, unknown>> = {}) {
  const sent: Hex[] = [];
  const client = {
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 100_000_000n),
    getTransactionCount: vi.fn(async () => 7),
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
  it("signs locally and broadcasts through Binance with MEV protection", async () => {
    const { client, sent } = stubClient();
    const { api, calls } = stubBinance();
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api, nonces: new NonceManager(async () => 7) });
    const r = await s.send(tx);
    const body = calls.find((c) => c.method === "broadcast")!.body;
    expect(body).toMatchObject({ binanceChainId: "56", address: account.address, enableMevProtection: true });
    const signed = body.signedTransaction as Hex;
    expect(parseTransaction(signed)).toMatchObject({ to: TO, nonce: 7, chainId: 56, gas: 120_000n, gasPrice: 100_000_000n });
    expect(r).toEqual({ ok: true, txHash: keccak256(signed), via: "binance", status: "success", gasUsed: 90_000n, effectiveGasPrice: 100_000_000n, blockNumber: 5n });
    expect(sent).toEqual([]);
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(signed.slice(2, 60));
  });

  it("sends the same signed transaction through the RPC when the Binance broadcast fails", async () => {
    const { client, sent } = stubClient();
    const { api } = stubBinance({ broadcast: async () => Promise.reject(new Error("HTTP 403 code 40304")) });
    const s = new ChainSender({ client, account, chainId: 56, dryRun: false, binance: api, nonces: new NonceManager(async () => 7) });
    const r = await s.send(tx);
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
