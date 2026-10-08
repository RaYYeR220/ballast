import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeErrorResult, keccak256, parseEther, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listaAccountAbi, type TxRequest } from "@ballast/sdk";
import { loadConfig } from "../src/desk/config";
import { Feed } from "../src/desk/feed";
import {
  ChainSender,
  DEFAULT_LIMITS,
  GasWatch,
  classifyBroadcastError,
  safeMessage,
  senderLimits,
  senderOptions,
  type BinanceTxApi,
  type ChainSenderOptions,
  type SendResult,
  type SenderClient,
  type TxBuilder,
} from "../src/desk/tx";

const account = privateKeyToAccount(`0x${"4f".repeat(32)}`);
const TO = "0x00000000000000000000000000000000000000a1" as const;
const tx: TxRequest = { to: TO, data: "0x1234", value: 0n };
const repay: TxRequest = { to: TO, data: "0xbeef", value: 0n };
const notInWindow = encodeErrorResult({ abi: listaAccountAbi, errorName: "NotInShieldWindow" });
const GWEI = 10n ** 9n;

function revert(data: Hex) {
  // The shape viem produces for a revert: the revert data sits on a cause.
  const cause = Object.assign(new Error("execution reverted"), { name: "ExecutionRevertedError", data });
  return Object.assign(new Error("call reverted"), { name: "CallExecutionError", cause });
}
const named = (name: string, message: string, extra: object = {}) => Object.assign(new Error(message), { name, ...extra });
const rpcError = (message: string) => named("RpcRequestError", "RPC Request failed.", { shortMessage: "RPC Request failed.", details: message, code: -32000 });
const notFound = () => named("TransactionNotFoundError", "not found");

type Parsed = ReturnType<typeof parseTransaction> & { hash: Hex; raw: Hex };

/**
 * A node with a mempool of one key. `accept` decides what happens to each broadcast: "mine" it at once, "hold"
 * it in the mempool, or throw. Time only moves when the sender sleeps.
 */
class Node {
  latest = 7;
  network = GWEI / 10n;
  balance = parseEther("1");
  time = 1_000_000;
  /** Unmined transactions by nonce (the node keeps the best-paying one). */
  mempool = new Map<number, Parsed>();
  mined = new Map<string, "success" | "reverted">();
  /** Every raw transaction the public RPC was asked to broadcast, accepted or not. */
  rpc: Parsed[] = [];
  /** A broadcast at a nonce ahead of the latest one: the sender signed behind an unmined transaction. */
  ahead: number[] = [];
  accept: (t: Parsed) => "mine" | "hold" = () => "mine";
  /** How an accepted transaction ends when it is mined on arrival. */
  outcome: "success" | "reverted" = "success";
  estimate: (t: TxRequest) => bigint = () => 100_000n;
  /** Called on every sleep, after the clock moved. */
  onSleep: () => void = () => {};
  failLatest = false;

  parse(raw: Hex): Parsed {
    return { ...parseTransaction(raw), hash: keccak256(raw), raw };
  }

  mine(t: Parsed, status: "success" | "reverted" = "success") {
    this.mined.set(t.hash, status);
    this.mempool.delete(t.nonce as number);
    this.latest = (t.nonce as number) + 1;
  }

  /** Puts a transaction in the mempool (or mines it) as if a node had received it. */
  receive(raw: Hex) {
    const t = this.parse(raw);
    const nonce = t.nonce as number;
    if (nonce < this.latest) throw rpcError("nonce too low");
    if (nonce > this.latest) this.ahead.push(nonce);
    const held = this.mempool.get(nonce);
    if (held && (t.gasPrice as bigint) * 10n < (held.gasPrice as bigint) * 11n) throw rpcError("replacement transaction underpriced");
    if ((t.gas as bigint) * (t.gasPrice as bigint) > this.balance) throw rpcError("insufficient funds for gas * price + value");
    if (this.accept(t) === "mine") this.mine(t, this.outcome);
    else this.mempool.set(nonce, t);
    return t;
  }

  client(): SenderClient {
    const c = {
      call: async () => ({ data: "0x" }),
      estimateGas: async (a: { to: Hex; data: Hex; value: bigint }) => this.estimate({ to: a.to, data: a.data, value: a.value }),
      getGasPrice: async () => this.network,
      getTransactionCount: async ({ blockTag }: { blockTag: "pending" | "latest" }) => {
        if (blockTag === "latest" && this.failLatest) throw named("HttpRequestError", "fetch failed");
        if (blockTag === "latest") return this.latest;
        let n = this.latest;
        while (this.mempool.has(n)) n++;
        return n;
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const t = [...this.mempool.values()].find((x) => x.hash === hash);
        if (!t && !this.mined.has(hash)) throw notFound();
        return { hash, nonce: t?.nonce, gasPrice: t?.gasPrice };
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const status = this.mined.get(hash);
        if (!status) throw named("TransactionReceiptNotFoundError", "receipt not found");
        return { status, transactionHash: hash, gasUsed: 90_000n, effectiveGasPrice: 1n * GWEI, blockNumber: 5n, logs: [{ address: TO, topics: ["0x01"], data: "0x" }] };
      },
      getBalance: async () => this.balance,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        this.rpc.push(this.parse(serializedTransaction));
        return this.receive(serializedTransaction).hash;
      },
    };
    return c as unknown as SenderClient;
  }
}

function sender(node: Node, o: Partial<ChainSenderOptions> = {}) {
  return new ChainSender({
    client: node.client(),
    account,
    chainId: 31337,
    dryRun: false,
    now: () => node.time,
    sleep: async (ms) => {
      node.time += ms;
      node.onSleep();
    },
    ...o,
  });
}

function binance(node: Node, o: { failAfter?: number; relay?: boolean; swallow?: boolean } = {}) {
  const broadcasts: Parsed[] = [];
  const api: BinanceTxApi = {
    simulate: async () => ({ status: "SUCCESS", failReason: null, balanceChanges: [], allowanceChanges: [] }),
    broadcast: async (body) => {
      const raw = body.signedTransaction as Hex;
      broadcasts.push(node.parse(raw));
      if (o.swallow) return { orderId: "1", txHash: keccak256(raw) }; // accepted, never relayed
      if (o.failAfter !== undefined && broadcasts.length > o.failAfter) {
        if (o.relay) node.receive(raw); // relayed although the API answered with an error
        throw new Error("HTTP 503");
      }
      node.receive(raw);
      return { orderId: "1", txHash: keccak256(raw) };
    },
  };
  return { api, broadcasts };
}

const okOf = (r: SendResult) => {
  if (!r.ok) throw new Error(`expected a sent transaction, got ${r.stage}`);
  return r;
};

describe("ChainSender.simulate", () => {
  const sim = (o: { call?: () => Promise<unknown>; binanceStatus?: "SUCCESS" | "FAILED"; binanceThrows?: boolean; chainId?: number } = {}) => {
    const node = new Node();
    const client = { ...node.client(), ...(o.call ? { call: o.call } : {}) } as unknown as SenderClient;
    const calls: unknown[] = [];
    const api: BinanceTxApi = {
      simulate: async (body) => {
        calls.push(body);
        if (o.binanceThrows) throw Object.assign(new Error("HTTP 403 code 40304"), { code: "40304" });
        return { status: o.binanceStatus ?? "SUCCESS", failReason: o.binanceStatus === "FAILED" ? "unsupported opcode" : null, balanceChanges: [], allowanceChanges: [] };
      },
      broadcast: async () => ({ orderId: "1", txHash: "0x" }),
    };
    return { s: new ChainSender({ client, account, chainId: o.chainId ?? 56, dryRun: false, binance: o.binanceStatus || o.binanceThrows ? api : null }), calls };
  };
  const reverting = async () => Promise.reject(revert(notInWindow));

  it("uses eth_call without a Binance key and decodes a revert", async () => {
    expect(await sim({ call: reverting }).s.simulate(tx)).toEqual({
      via: "rpc",
      ok: false,
      error: { name: "NotInShieldWindow", message: expect.stringContaining("close to a market closure"), args: [] },
    });
  });

  it("uses the Binance Transaction API on mainnet when keyed", async () => {
    const { s, calls } = sim({ binanceStatus: "SUCCESS" });
    expect(await s.simulate(tx)).toEqual({ via: "binance", ok: true });
    expect(calls[0]).toEqual({ binanceChainId: "56", evmTx: { from: account.address, to: TO, value: "0", data: "0x1234" } });
  });

  it("decodes a Binance simulation failure with an eth_call replay", async () => {
    expect(await sim({ binanceStatus: "FAILED", call: reverting }).s.simulate(tx)).toMatchObject({ via: "binance", ok: false, error: { name: "NotInShieldWindow" } });
  });

  it("lets eth_call decide when Binance reports a failure the replay does not reproduce, flagging it", async () => {
    expect(await sim({ binanceStatus: "FAILED" }).s.simulate(tx)).toEqual({ via: "rpc", ok: true, disagree: true, note: expect.stringContaining("unsupported opcode") });
  });

  it("in strict mode (restores) fails on any disagreement, in both directions", async () => {
    expect(await sim({ binanceStatus: "FAILED" }).s.simulate(tx, { strict: true })).toMatchObject({ ok: false, disagree: true, error: { name: "SimulatorsDisagree" } });
    const s2 = sim({ binanceStatus: "SUCCESS", call: reverting }).s;
    expect(await s2.simulate(tx)).toEqual({ via: "binance", ok: true }); // not strict: Binance alone
    expect(await s2.simulate(tx, { strict: true })).toMatchObject({ ok: false, disagree: true, error: { name: "SimulatorsDisagree", message: expect.stringContaining("close to a market closure") } });
    expect(await sim({ binanceStatus: "SUCCESS" }).s.simulate(tx, { strict: true })).toEqual({ via: "binance", ok: true });
  });

  it("keeps Binance's reason when the RPC replay is down", async () => {
    const down = async () => Promise.reject(new Error("fetch failed"));
    expect(await sim({ binanceStatus: "FAILED", call: down }).s.simulate(tx)).toEqual({ via: "binance", ok: false, error: { name: "SimulationFailed", message: "unsupported opcode" } });
  });

  it("falls back to eth_call when the Binance API is unavailable (geo block) and says so", async () => {
    expect(await sim({ binanceThrows: true }).s.simulate(tx)).toEqual({ via: "rpc", ok: true, note: expect.stringContaining("40304") });
  });

  it("never asks Binance to simulate a fork, and rethrows RPC outages", async () => {
    const fork = sim({ binanceStatus: "SUCCESS", chainId: 31337 });
    expect((await fork.s.simulate(tx)).via).toBe("rpc");
    expect(fork.calls).toEqual([]);
    await expect(sim({ call: async () => Promise.reject(new Error("fetch failed")) }).s.simulate(tx)).rejects.toThrow("fetch failed");
  });
});

describe("classifyBroadcastError", () => {
  it.each([
    [rpcError("already known"), "known"],
    [rpcError("nonce too low: next nonce 9, tx nonce 7"), "nonce-too-low"],
    [rpcError("replacement transaction underpriced"), "underpriced"],
    [rpcError("transaction underpriced"), "underpriced"],
    [rpcError("insufficient funds for gas * price + value"), "insufficient-funds"],
    [named("HttpRequestError", "HTTP request failed.", { status: 502 }), "possibly-sent"],
    [named("TimeoutError", "The request took too long to respond."), "possibly-sent"],
    [new Error("fetch failed"), "possibly-sent"],
    [Object.assign(new Error("request failed"), { cause: new Error("read ECONNRESET") }), "possibly-sent"],
    [rpcError("exceeds block gas limit"), "rejected"],
    [rpcError("invalid sender"), "rejected"],
  ])("%s -> %s", (err, kind) => {
    expect(classifyBroadcastError(err)).toBe(kind);
  });

  it("reads the class from a wrapped cause", () => {
    const wrapped = Object.assign(new Error("Transaction failed"), { cause: rpcError("nonce too low") });
    expect(classifyBroadcastError(wrapped)).toBe("nonce-too-low");
  });
});

describe("ChainSender.send", () => {
  it("signs locally at 1.1x the network price and reports the receipt", async () => {
    const node = new Node();
    const s = sender(node);
    const r = okOf(await s.send(tx));
    const sent = node.rpc[0]!;
    expect(sent).toMatchObject({ to: TO, nonce: 7, chainId: 31337, gas: 120_000n, gasPrice: 110_000_000n, data: "0x1234" });
    expect(r).toEqual({
      ok: true,
      status: "success",
      txHash: sent.hash,
      via: "rpc",
      nonce: 7,
      gasPrice: 110_000_000n,
      minedAs: "intent",
      gasUsed: 90_000n,
      effectiveGasPrice: 1n * GWEI,
      blockNumber: 5n,
      logs: [{ address: TO, topics: ["0x01"], data: "0x" }],
    });
    expect(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(sent.raw.slice(2, 60));
    expect(s.state()).toMatchObject({ halted: null, outstanding: null, spentLastHourWei: 120_000n * 110_000_000n });
  });

  it("never signs above the gas price cap", async () => {
    const node = new Node();
    node.network = 20n * GWEI;
    await sender(node).send(tx);
    expect(node.rpc[0]!.gasPrice).toBe(DEFAULT_LIMITS.maxGasPriceWei);
    expect(DEFAULT_LIMITS).toEqual({ maxGasPriceWei: 1n * GWEI, receiptTimeoutMs: 20_000, maxBumps: 4, maxFeeWeiPerHour: parseEther("0.003"), receiptLagMs: 45_000 });
  });

  it("aborts without signing when the builder returns null, and reports a revert at estimation", async () => {
    const node = new Node();
    const s = sender(node);
    expect(await s.send(async () => null)).toEqual({ ok: false, stage: "aborted" });
    node.estimate = () => {
      throw revert(notInWindow);
    };
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "estimate", error: { name: "NotInShieldWindow" } });
    expect(node.rpc).toEqual([]);
    node.estimate = () => 100_000n;
    expect(okOf(await s.send(tx)).nonce).toBe(7);
  });

  it("reports an on-chain revert from the receipt", async () => {
    const node = new Node();
    node.outcome = "reverted";
    expect(await sender(node).send(tx)).toMatchObject({ ok: true, status: "reverted", minedAs: "intent" });
  });

  it("refuses to send in DRY_RUN", async () => {
    const node = new Node();
    const s = sender(node, { dryRun: true });
    await expect(s.send(tx)).rejects.toThrow(/DRY_RUN/);
    expect(await s.recover()).toBeNull();
    expect(node.rpc).toEqual([]);
  });

  it("keeps ONE transaction in flight: nonce N+1 is never signed while N is unmined", async () => {
    const node = new Node();
    node.accept = () => "hold";
    node.onSleep = () => {
      // Each held transaction is mined 6 s after it arrived.
      for (const t of [...node.mempool.values()]) if (node.time - held.get(t.hash)! >= 6_000) node.mine(t);
    };
    const held = new Map<string, number>();
    const client = node.client();
    const wrapped = {
      ...client,
      sendRawTransaction: async (a: { serializedTransaction: Hex }) => {
        held.set(keccak256(a.serializedTransaction), node.time);
        return (client.sendRawTransaction as (x: typeof a) => Promise<Hex>)(a);
      },
    } as unknown as SenderClient;
    const s = sender(node, { client: wrapped });
    const results = await Promise.all([s.send(tx), s.send(tx), s.send(tx)]);
    expect(results.map((r) => okOf(r).nonce)).toEqual([7, 8, 9]);
    expect(results.every((r) => okOf(r).status === "success")).toBe(true);
    expect(node.ahead).toEqual([]);
    expect(node.rpc).toHaveLength(3);
  });

  it("builds inside the queue: a later send plans against the state the earlier one left", async () => {
    const node = new Node();
    const s = sender(node);
    const order: string[] = [];
    const first = s.send(async () => {
      order.push(`build 1 at latest ${node.latest}`);
      return tx;
    });
    const second = s.send(async () => {
      order.push(`build 2 at latest ${node.latest}`);
      return null;
    });
    expect(okOf(await first).nonce).toBe(7);
    expect(await second).toEqual({ ok: false, stage: "aborted" });
    expect(order).toEqual(["build 1 at latest 7", "build 2 at latest 8"]);
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

  it("turns the desk config into limits", () => {
    expect(senderLimits({ maxGasPriceGwei: 1, receiptTimeoutSec: 20, maxBumps: 4, maxFeeBnbPerHour: 0.003 })).toEqual(DEFAULT_LIMITS);
    const config = loadConfig({ CHAIN_ID: "31337", BSC_RPC_URL: "http://127.0.0.1:8545", AGENT_PRIVATE_KEY: `0x${"4f".repeat(32)}`, DATA_DIR: "/srv/desk" });
    expect(senderOptions(config)).toEqual({ limits: DEFAULT_LIMITS, stateFile: path.join(path.resolve("/srv/desk"), "sender.json") });
    expect(senderLimits({ maxGasPriceGwei: 0.5, receiptTimeoutSec: 30, maxBumps: 2, maxFeeBnbPerHour: 0.0000001 })).toEqual({
      maxGasPriceWei: 500_000_000n,
      receiptTimeoutMs: 30_000,
      maxBumps: 2,
      maxFeeWeiPerHour: 100_000_000_000n,
      receiptLagMs: 45_000,
    });
    expect(senderLimits({ maxGasPriceGwei: 1, receiptTimeoutSec: 20, maxBumps: 4, maxFeeBnbPerHour: 0.003, receiptLagSec: 90 }).receiptLagMs).toBe(90_000);
  });
});

describe("ChainSender: a transaction that is not mined in time", () => {
  it("rebuilds the same intent and replaces it at the same nonce for 12.5% more", async () => {
    const node = new Node();
    node.accept = (t) => ((t.gasPrice as bigint) > 130_000_000n ? "mine" : "hold"); // only the second replacement is good enough
    const rounds: number[] = [];
    const build: TxBuilder = async ({ round }) => {
      rounds.push(round);
      return tx;
    };
    const s = sender(node);
    const started = node.time;
    const r = okOf(await s.send(build));
    expect(rounds).toEqual([0, 1, 2]);
    expect(node.rpc.map((t) => [t.nonce, t.gasPrice])).toEqual([
      [7, 110_000_000n],
      [7, 123_750_000n],
      [7, 139_218_750n],
    ]);
    expect(r).toMatchObject({ status: "success", nonce: 7, txHash: node.rpc[2]!.hash, minedAs: "intent", gasPrice: 139_218_750n });
    // Two full receipt waits passed before the replacements.
    expect(node.time - started).toBeGreaterThanOrEqual(2 * DEFAULT_LIMITS.receiptTimeoutMs);
    expect(node.ahead).toEqual([]);
  });

  it("follows the network when it moved above the bump", async () => {
    const node = new Node();
    node.accept = (t) => ((t.gasPrice as bigint) >= 300_000_000n ? "mine" : "hold");
    node.onSleep = () => {
      node.network = 300_000_000n;
    };
    await sender(node).send(tx);
    expect(node.rpc.map((t) => t.gasPrice)).toEqual([110_000_000n, 330_000_000n]);
  });

  it("replaces it with a 0-value transfer to itself when the intent is no longer needed", async () => {
    const node = new Node();
    node.accept = (t) => (t.to === account.address.toLowerCase() ? "mine" : "hold");
    const s = sender(node);
    const r = okOf(await s.send(async ({ round }) => (round === 0 ? tx : null)));
    const cancel = node.rpc[1]!;
    expect(cancel).toMatchObject({ nonce: 7, to: account.address.toLowerCase(), gas: 21_000n, gasPrice: 123_750_000n });
    expect(cancel.value ?? 0n).toBe(0n);
    expect(cancel.data ?? "0x").toBe("0x");
    expect(r).toMatchObject({ status: "dropped", minedAs: "cancel", txHash: cancel.hash, note: expect.stringMatching(/no longer needed/) });
  });

  it("cancels when the rebuilt transaction would revert now", async () => {
    const node = new Node();
    node.accept = (t) => (t.to === account.address.toLowerCase() ? "mine" : "hold");
    let calls = 0;
    node.estimate = () => {
      if (++calls > 1) throw revert(notInWindow);
      return 100_000n;
    };
    expect(await sender(node).send(tx)).toMatchObject({ status: "dropped", minedAs: "cancel" });
  });

  it("reports the earlier transaction when that is the one that was mined after all", async () => {
    const node = new Node();
    node.accept = () => "hold";
    let slept = 0;
    node.onSleep = () => {
      // The first transaction is mined just after its replacement went out.
      if (node.rpc.length === 2 && ++slept === 2) node.mine(node.rpc[0]!);
    };
    const r = okOf(await sender(node).send(tx));
    expect(r).toMatchObject({ status: "success", txHash: node.rpc[0]!.hash, gasPrice: 110_000_000n });
  });

  it("leaves the outstanding transaction alone when the rebuild throws, and tries again next time", async () => {
    const node = new Node();
    node.accept = (t) => ((t.gasPrice as bigint) > 110_000_000n ? "mine" : "hold");
    const rounds: number[] = [];
    const r = okOf(
      await sender(node).send(async ({ round }) => {
        rounds.push(round);
        if (round === 1) throw new Error("fetch failed");
        return tx;
      }),
    );
    expect(rounds).toEqual([0, 1, 2]);
    expect(node.rpc).toHaveLength(2); // nothing was signed in the failed round, and no cancel
    expect(node.rpc[1]!.to).toBe(TO);
    expect(r).toMatchObject({ status: "success", note: expect.stringMatching(/could not rebuild \(fetch failed\), left as it is/) });
  });

  it("keeps waiting through failing nonce reads", async () => {
    const node = new Node();
    node.accept = () => "hold";
    let sleeps = 0;
    node.onSleep = () => {
      sleeps++;
      node.failLatest = sleeps < 5;
      if (sleeps === 6) node.mine(node.rpc[0]!);
    };
    expect(await sender(node).send(tx)).toMatchObject({ status: "success" });
    expect(node.rpc).toHaveLength(1);
  });
});

describe("ChainSender: halting", () => {
  it("halts after MAX_BUMPS replacements, refuses new sends, and resumes once the nonce is mined", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const s = sender(node, { limits: { maxBumps: 2 } });
    const r = okOf(await s.send(tx));
    expect(node.rpc.map((t) => t.nonce)).toEqual([7, 7, 7]); // the send and two replacements
    expect(r).toMatchObject({ status: "pending", nonce: 7, txHash: node.rpc[2]!.hash, halted: { reason: "STUCK", nonce: 7 } });
    expect(s.state()).toMatchObject({ halted: { reason: "STUCK", nonce: 7, since: Math.floor(node.time / 1000) }, outstanding: { nonce: 7, rounds: 2 } });
    expect(s.state().outstanding!.hashes).toEqual(node.rpc.map((t) => t.hash));

    // Halted: nothing is built or signed.
    let built = false;
    const refused = await s.send(async () => {
      built = true;
      return tx;
    });
    expect(refused).toEqual({ ok: false, stage: "halted", halt: expect.objectContaining({ reason: "STUCK", nonce: 7 }) });
    expect(built).toBe(false);
    expect(node.rpc).toHaveLength(3);
    expect(await s.confirm(node.rpc[0]!.hash, 7)).toEqual({ status: "pending" });

    // The chain mines the second one: the halt lifts by itself and the next send goes out at the next nonce.
    node.mine(node.rpc[1]!);
    node.accept = () => "mine";
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 8 });
    expect(s.state()).toMatchObject({ halted: null, outstanding: null });
    expect(await s.confirm(node.rpc[0]!.hash, 7)).toMatchObject({ status: "success", txHash: node.rpc[1]!.hash, minedAs: "intent" });
  });

  it("halts instead of signing above the cap", async () => {
    const node = new Node();
    node.accept = () => "hold";
    node.network = 800_000_000n; // 0.88 gwei, then 0.99; the next bump (1.11) is over the 1 gwei cap and 1 is not +10%
    const s = sender(node, { limits: { maxBumps: 10 } });
    const r = okOf(await s.send(tx));
    expect(node.rpc.map((t) => t.gasPrice)).toEqual([880_000_000n, 990_000_000n]);
    expect(r.halted).toMatchObject({ reason: "GAS_CAP", nonce: 7 });
  });

  it("uses the cap itself as the last replacement when that still outbids by 10%", async () => {
    const node = new Node();
    node.accept = () => "hold";
    node.network = 800_000_000n;
    node.onSleep = () => {
      node.network = 2n * GWEI; // the network ran away: 2.2 gwei wanted, 1 allowed, and 1 is +13.6% on 0.88
    };
    const r = okOf(await sender(node, { limits: { maxBumps: 10 } }).send(tx));
    expect(node.rpc.map((t) => t.gasPrice)).toEqual([880_000_000n, 1n * GWEI]);
    expect(r.halted).toMatchObject({ reason: "GAS_CAP" });
    expect(Math.max(...node.rpc.map((t) => Number(t.gasPrice)))).toBeLessThanOrEqual(Number(DEFAULT_LIMITS.maxGasPriceWei));
  });

  it("halts when the intent can never be rebuilt", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const s = sender(node, { limits: { maxBumps: 3 } });
    const r = okOf(
      await s.send(async ({ round }) => {
        if (round > 0) throw new Error("fetch failed");
        return tx;
      }),
    );
    expect(node.rpc).toHaveLength(1);
    expect(r.halted).toMatchObject({ reason: "BUILD_FAILED", nonce: 7 });
  });

  it("halts on insufficient funds and resumes when the key is topped up", async () => {
    const node = new Node();
    node.balance = 1n;
    const s = sender(node);
    expect(await s.send(tx)).toEqual({ ok: false, stage: "halted", halt: expect.objectContaining({ reason: "INSUFFICIENT_FUNDS", nonce: null }) });
    expect(s.state().outstanding).toBeNull();
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "halted" });
    node.balance = parseEther("1");
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 7 });
  });

  it("halts when the hourly fee budget is used up and resumes when the hour has passed", async () => {
    const node = new Node();
    const cost = 120_000n * 110_000_000n;
    const s = sender(node, { limits: { maxFeeWeiPerHour: cost * 2n + 1n } });
    await s.send(tx);
    await s.send(tx);
    expect(s.state().spentLastHourWei).toBe(cost * 2n);
    expect(await s.send(tx)).toEqual({ ok: false, stage: "halted", halt: expect.objectContaining({ reason: "FEE_BUDGET" }) });
    expect(node.rpc).toHaveLength(2);
    node.time += 3_600_001;
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 9 });
  });

  it("counts replacements against the fee budget", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const first = 120_000n * 110_000_000n;
    const s = sender(node, { limits: { maxFeeWeiPerHour: first * 2n } }); // room for the send, not for a 12.5% dearer one on top
    const r = okOf(await s.send(tx));
    expect(node.rpc).toHaveLength(1);
    expect(r).toMatchObject({ status: "pending", halted: { reason: "FEE_BUDGET" } });
  });

  it("never signs behind a pending transaction it did not sign (foreign blocker)", async () => {
    const node = new Node();
    const s = sender(node);
    await s.send(tx); // nonce 7, so the startup adoption is behind us
    const foreign = node.parse(await privateKeyToAccount(`0x${"4f".repeat(32)}`).signTransaction({ type: "legacy", chainId: 31337, nonce: 8, to: TO, gas: 21_000n, gasPrice: GWEI }));
    node.mempool.set(8, foreign);
    expect(await s.send(tx)).toEqual({ ok: false, stage: "halted", halt: expect.objectContaining({ reason: "FOREIGN_BLOCKER", nonce: 8 }) });
    expect(node.rpc).toHaveLength(1);
    node.mine(foreign);
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 9 });
  });

  it("lifts a foreign-blocker halt when the foreign transaction is gone from the mempool", async () => {
    const node = new Node();
    const s = sender(node);
    await s.send(tx);
    node.mempool.set(8, node.parse(await account.signTransaction({ type: "legacy", chainId: 31337, nonce: 8, to: TO, gas: 21_000n, gasPrice: GWEI })));
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "halted" });
    node.mempool.clear();
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 8 });
  });

  it("does not take one lagging read for a foreign blocker, and never counts the latest nonce backwards", async () => {
    const node = new Node();
    const s = sender(node);
    await s.send(tx); // latest is 8 now
    // One backend still answers the old "latest" once: pending (8) > latest (7) for a moment.
    const client = node.client();
    let lag = 1;
    const lagging = {
      ...client,
      getTransactionCount: async (a: { blockTag: "pending" | "latest" }) => {
        if (a.blockTag === "latest" && lag-- > 0) return 7;
        return (client.getTransactionCount as (x: typeof a) => Promise<number>)(a);
      },
    } as unknown as SenderClient;
    const fresh = sender(node, { client: lagging });
    const r = okOf(await fresh.send(tx));
    expect(r).toMatchObject({ status: "success", nonce: 8 });
    expect(fresh.state().halted).toBeNull();

    // And while waiting, a backend that reports an older count does not un-mine anything.
    node.accept = () => "hold";
    let reads = 0;
    const flapping = {
      ...client,
      getTransactionCount: async (a: { blockTag: "pending" | "latest" }) => {
        const n = await (client.getTransactionCount as (x: typeof a) => Promise<number>)(a);
        return a.blockTag === "latest" && ++reads % 2 === 0 ? n - 1 : n;
      },
    } as unknown as SenderClient;
    node.onSleep = () => {
      if (node.mempool.size && node.time % 6_000 < 1_500) node.mine([...node.mempool.values()][0]!);
    };
    const r2 = okOf(await sender(node, { client: flapping }).send(tx));
    expect(r2).toMatchObject({ status: "success", nonce: 9 });
  });

  it("keeps a stuck halt while any sign of the transaction remains: a pending count, or a node that knows a hash", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const client = node.client();
    let pendingLags = false;
    let lookupsFail = false;
    const odd = {
      ...client,
      getTransactionCount: async (a: { blockTag: "pending" | "latest" }) => (a.blockTag === "pending" && pendingLags ? node.latest : (client.getTransactionCount as (x: typeof a) => Promise<number>)(a)),
      getTransaction: async (a: { hash: Hex }) => {
        if (lookupsFail) throw notFound();
        return (client.getTransaction as (x: typeof a) => Promise<unknown>)(a);
      },
    } as unknown as SenderClient;
    const s = sender(node, { client: odd, limits: { maxBumps: 1 } });
    expect(okOf(await s.send(tx)).halted).toMatchObject({ reason: "STUCK" });
    // The pending count misses it, but a node still knows the hash: not gone.
    pendingLags = true;
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "halted" });
    // No node answers for the hash, but the key still has a pending transaction: not gone either.
    pendingLags = false;
    lookupsFail = true;
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "halted" });
    expect(s.state().outstanding).toMatchObject({ nonce: 7 });
  });

  it("reads only a missing transaction or receipt as not found: any other lookup failure is an error", async () => {
    const node = new Node();
    const client = node.client();
    const hash = `0x${"ab".repeat(32)}` as Hex;
    let receiptError = "TransactionReceiptNotFoundError";
    let txError = "TransactionNotFoundError";
    const odd = {
      ...client,
      getTransactionReceipt: async () => {
        throw named(receiptError, `the lookup failed (${receiptError})`);
      },
      getTransaction: async () => {
        throw named(txError, `the lookup failed (${txError})`);
      },
    } as unknown as SenderClient;
    const s = sender(node, { client: odd });
    // Really not there: no receipt, no node knows it, nothing pending at its nonce: dropped.
    expect(await s.confirm(hash, node.latest)).toEqual({ status: "dropped" });
    // A node that does not serve the call (or any other failure with "NotFound" in its name) is not an answer.
    for (const name of ["MethodNotFoundRpcError", "BlockNotFoundError", "ResourceNotFoundRpcError"]) {
      receiptError = name;
      await expect(s.confirm(hash, node.latest), name).rejects.toThrow(/the lookup failed/);
    }
    receiptError = "TransactionReceiptNotFoundError";
    txError = "MethodNotFoundRpcError";
    await expect(s.confirm(hash, node.latest)).rejects.toThrow(/the lookup failed/);
  });

  it("never picks a nonce below the highest one it has seen mined", async () => {
    const node = new Node();
    const client = node.client();
    let lag = false;
    const lagging = {
      ...client,
      getTransactionCount: async (a: { blockTag: "pending" | "latest" }) => (await (client.getTransactionCount as (x: typeof a) => Promise<number>)(a)) - (lag ? 1 : 0),
    } as unknown as SenderClient;
    const s = sender(node, { client: lagging });
    expect(okOf(await s.send(tx)).nonce).toBe(7);
    lag = true; // every backend is now one block behind: both counts say 7 again
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 8 });
  });

  it.each([
    ["STUCK", { maxBumps: 1 }, GWEI / 10n],
    ["GAS_CAP", { maxBumps: 10 }, 860_000_000n],
    ["BUILD_FAILED", { maxBumps: 1 }, GWEI / 10n],
  ] as const)("lifts a %s halt when the mempool has dropped everything signed for that nonce", async (reason, limits, network) => {
    const node = new Node();
    node.network = network;
    node.accept = () => "hold";
    const s = sender(node, { limits });
    const build: TxBuilder = async ({ round }) => {
      if (reason === "BUILD_FAILED" && round > 0) throw new Error("fetch failed");
      return tx;
    };
    const first = okOf(await s.send(build));
    expect(first.halted).toMatchObject({ reason, nonce: 7 });
    // Still in the mempool: the halt stands.
    expect(await s.send(tx)).toMatchObject({ ok: false, stage: "halted" });
    // The node dropped it all: nothing pending, no hash known. The nonce is free again.
    node.mempool.clear();
    node.accept = () => "mine";
    node.network = GWEI / 10n;
    const sentBefore = node.rpc.length;
    expect(okOf(await s.send(repay))).toMatchObject({ status: "success", nonce: 7 });
    expect(node.rpc.slice(sentBefore).map((t) => [t.nonce, t.data])).toEqual([[7, "0xbeef"]]);
    expect(s.state()).toMatchObject({ halted: null, outstanding: null });
    // The old hash: its nonce is used by the new intent and no node knows it. Dropped once RECEIPT_LAG has passed.
    expect(await s.confirm(first.txHash, 7)).toEqual({ status: "pending" });
    node.time += 45_000;
    expect(await s.confirm(first.txHash, 7)).toEqual({ status: "dropped" });
  });
});

describe("ChainSender: broadcast errors", () => {
  const failing = (node: Node, errors: (Error | null)[]) => {
    const client = node.client();
    let n = 0;
    return {
      ...client,
      sendRawTransaction: async (a: { serializedTransaction: Hex }) => {
        const err = errors[n++] ?? null;
        if (err) {
          node.rpc.push(node.parse(a.serializedTransaction));
          throw err;
        }
        return (client.sendRawTransaction as (x: typeof a) => Promise<Hex>)(a);
      },
    } as unknown as SenderClient;
  };

  it("treats a broadcast with no answer as possibly sent: the hash stays in the family and is replaced, not re-sent blind", async () => {
    const node = new Node();
    node.accept = () => "mine";
    const s = sender(node, { client: failing(node, [named("HttpRequestError", "HTTP request failed.", { status: 504 })]) });
    const r = okOf(await s.send(tx));
    // The first broadcast died on the way; after the timeout the same intent was replaced at the same nonce.
    expect(node.rpc.map((t) => [t.nonce, t.gasPrice])).toEqual([
      [7, 110_000_000n],
      [7, 123_750_000n],
    ]);
    expect(r).toMatchObject({ status: "success", txHash: node.rpc[1]!.hash, note: expect.stringMatching(/got no answer .* treated as sent/) });
    expect(await s.confirm(node.rpc[0]!.hash, 7)).toMatchObject({ status: "success", txHash: node.rpc[1]!.hash });
  });

  it("finds the possibly-sent transaction when it was mined after all", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const client = failing(node, [named("TimeoutError", "The request took too long to respond.")]);
    node.onSleep = () => {
      if (node.rpc.length === 1 && !node.mined.size) node.mine(node.rpc[0]!); // it did reach a node
    };
    const r = okOf(await sender(node, { client }).send(tx));
    expect(r).toMatchObject({ status: "success", txHash: node.rpc[0]!.hash });
    expect(node.rpc).toHaveLength(1);
  });

  it("resolves a 'nonce too low' from the receipts: ours if one was mined, else dropped", async () => {
    const node = new Node();
    node.accept = () => "hold";
    node.onSleep = () => {
      // Our transaction is mined, but the node still answers the nonce read with the old count.
      if (!node.mined.size) {
        node.mined.set(node.rpc[0]!.hash, "success");
        node.mempool.delete(7);
      }
    };
    const client = node.client();
    let broadcasts = 0;
    const stale = {
      ...client,
      getTransactionCount: async () => 7,
      sendRawTransaction: async (a: { serializedTransaction: Hex }) => {
        if (++broadcasts > 1) throw rpcError("nonce too low");
        return (client.sendRawTransaction as (x: typeof a) => Promise<Hex>)(a);
      },
    } as unknown as SenderClient;
    const r = okOf(await sender(node, { client: stale }).send(tx));
    expect(broadcasts).toBe(2); // the replacement was refused as too low: resolved from the receipts
    expect(r).toMatchObject({ status: "success", txHash: node.rpc[0]!.hash });

    const other = new Node();
    const lost = { ...other.client(), sendRawTransaction: async () => Promise.reject(rpcError("nonce too low")) } as unknown as SenderClient;
    expect(await sender(other, { client: lost }).send(tx)).toMatchObject({ ok: true, status: "dropped", nonce: 7, note: expect.stringMatching(/not ours/) });
  });

  it("raises the price it just tried when the node says underpriced, under the cap", async () => {
    const node = new Node();
    const s = sender(node, { client: failing(node, [rpcError("replacement transaction underpriced"), rpcError("replacement transaction underpriced")]) });
    const r = okOf(await s.send(tx));
    expect(node.rpc.map((t) => t.gasPrice)).toEqual([110_000_000n, 123_750_000n, 139_218_750n]);
    expect(r).toMatchObject({ status: "success", gasPrice: 139_218_750n });

    const capped = new Node();
    capped.network = 860_000_000n; // 0.946 gwei first; one bump would be 1.06 > the 1 gwei cap
    const always = { ...capped.client(), sendRawTransaction: async () => Promise.reject(rpcError("replacement transaction underpriced")) } as unknown as SenderClient;
    expect(await sender(capped, { client: always }).send(tx)).toEqual({ ok: false, stage: "halted", halt: expect.objectContaining({ reason: "GAS_CAP", nonce: 7 }) });
  });

  it("throws when the node rejects a first transaction outright, leaving nothing outstanding", async () => {
    const node = new Node();
    const s = sender(node, { client: failing(node, [rpcError("exceeds block gas limit")]) });
    await expect(s.send(tx)).rejects.toThrow(/broadcast rejected: .*exceeds block gas limit/);
    expect(s.state().outstanding).toBeNull();
    expect(okOf(await s.send(tx)).nonce).toBe(7);
  });

  it("keeps the earlier transaction when a replacement is rejected", async () => {
    const node = new Node();
    node.accept = (t) => ((t.gasPrice as bigint) > 130_000_000n ? "mine" : "hold");
    const s = sender(node, { client: failing(node, [null, rpcError("invalid sender")]) });
    const r = okOf(await s.send(tx));
    expect(r).toMatchObject({ status: "success", note: expect.stringMatching(/rejected \(.*invalid sender.*\), the earlier one stays/) });
  });
});

describe("ChainSender: collateral sales", () => {
  const sale: TxRequest = { to: TO, data: "0x5a1e", value: 0n };

  it("resolves a sale Binance accepted but that never lands in public: one private re-send, then its cushion repay", async () => {
    const node = new Node();
    const b = binance(node, { swallow: true }); // accepted every time, relayed never
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true, fallback: async () => repay }));
    expect(b.broadcasts.map((t) => [t.nonce, t.data, t.gasPrice])).toEqual([
      [7, "0x5a1e", 110_000_000n],
      [7, "0x5a1e", 123_750_000n],
    ]);
    expect(node.rpc.map((t) => [t.nonce, t.data, t.gasPrice])).toEqual([[7, "0xbeef", 139_218_750n]]);
    expect(r).toMatchObject({ status: "success", minedAs: "fallback", nonce: 7, note: expect.stringMatching(/not mined after a private re-send/) });
    expect(r.halted).toBeUndefined();
    expect(s.state()).toMatchObject({ halted: null, outstanding: null });
  });

  it("cancels in public when such a sale has no cushion repay", async () => {
    const node = new Node();
    const b = binance(node, { swallow: true });
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true }));
    expect(b.broadcasts).toHaveLength(2);
    expect(node.rpc.map((t) => [t.nonce, t.to])).toEqual([[7, account.address.toLowerCase()]]);
    expect(r).toMatchObject({ status: "dropped", minedAs: "cancel" });
    expect(s.state().halted).toBeNull();
  });

  it("broadcasts a sale only through Binance with MEV protection, re-sends included", async () => {
    const node = new Node();
    node.accept = (t) => ((t.gasPrice as bigint) > 110_000_000n ? "mine" : "hold");
    const b = binance(node);
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true, fallback: async () => repay }));
    expect(b.broadcasts.map((t) => [t.nonce, t.data, t.gasPrice])).toEqual([
      [7, "0x5a1e", 110_000_000n],
      [7, "0x5a1e", 123_750_000n],
    ]);
    expect(node.rpc).toEqual([]); // nothing of the sale ever reached the public RPC
    expect(r).toMatchObject({ status: "success", via: "binance", minedAs: "intent", txHash: b.broadcasts[1]!.hash });
  });

  it("on a Binance error never sends the sale publicly: its cushion repay takes the same nonce", async () => {
    const node = new Node();
    const b = binance(node, { failAfter: 0 });
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true, fallback: async () => repay }));
    expect(b.broadcasts.map((t) => t.data)).toEqual(["0x5a1e"]);
    expect(node.rpc.map((t) => [t.nonce, t.data, t.gasPrice])).toEqual([[7, "0xbeef", 123_750_000n]]);
    expect(node.rpc.every((t) => t.data !== "0x5a1e")).toBe(true);
    expect(r).toMatchObject({ status: "success", via: "rpc", minedAs: "fallback", txHash: node.rpc[0]!.hash, note: expect.stringMatching(/not sent publicly/) });
  });

  it("loses to the sale when Binance had relayed it despite the error", async () => {
    const node = new Node();
    const b = binance(node, { failAfter: 0, relay: true });
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true, fallback: async () => repay }));
    // The relayed sale was mined; the repay at the same nonce was refused as too low and nothing else was signed.
    expect(r).toMatchObject({ status: "success", minedAs: "intent", txHash: b.broadcasts[0]!.hash });
    expect(node.ahead).toEqual([]);
  });

  it("cancels at the same nonce when there is no cushion to repay with", async () => {
    const node = new Node();
    const b = binance(node, { failAfter: 0 });
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async () => sale, { mevProtect: true, fallback: async () => null }));
    expect(node.rpc.map((t) => [t.nonce, t.to])).toEqual([[7, account.address.toLowerCase()]]);
    expect(r).toMatchObject({ status: "dropped", minedAs: "cancel" });
  });

  it("switches to the cushion repay when the sale is no longer valid at a re-send", async () => {
    const node = new Node();
    node.accept = (t) => (t.data === "0xbeef" ? "mine" : "hold");
    const b = binance(node);
    const s = sender(node, { chainId: 56, binance: b.api });
    const r = okOf(await s.send(async ({ round }) => (round === 0 ? sale : null), { mevProtect: true, fallback: async () => repay }));
    expect(b.broadcasts).toHaveLength(1);
    expect(node.rpc.map((t) => t.data)).toEqual(["0xbeef"]);
    expect(r).toMatchObject({ status: "success", minedAs: "fallback" });
  });

  it("without a Binance key on mainnet plans the sale, then sends its cushion repay instead, or nothing", async () => {
    const node = new Node();
    const s = sender(node, { chainId: 56 });
    expect(s.state().sales).toBe("disabled");
    const order: string[] = [];
    const r = okOf(
      await s.send(
        async ({ round }) => {
          order.push(`sale builder round ${round}`); // the caller's plan and simulation happen here
          return sale;
        },
        {
          mevProtect: true,
          fallback: async () => {
            order.push("fallback builder");
            return repay;
          },
        },
      ),
    );
    expect(order).toEqual(["sale builder round 0", "fallback builder"]);
    expect(node.rpc.map((t) => t.data)).toEqual(["0xbeef"]);
    expect(r).toMatchObject({ status: "success", minedAs: "fallback", note: expect.stringMatching(/never broadcast publicly/) });
    // No cushion repay to send: nothing is signed.
    expect(await s.send(async () => sale, { mevProtect: true })).toEqual({ ok: false, stage: "aborted" });
    expect(await s.send(async () => sale, { mevProtect: true, fallback: async () => null })).toEqual({ ok: false, stage: "aborted" });
    // The sale itself is no longer the plan: aborted before the fallback is even asked.
    let asked = false;
    const gone = await s.send(async () => null, {
      mevProtect: true,
      fallback: async () => {
        asked = true;
        return repay;
      },
    });
    expect(gone).toEqual({ ok: false, stage: "aborted" });
    expect(asked).toBe(false);
    expect(node.rpc).toHaveLength(1);
  });

  it("says how sales go out: protected, public off mainnet, or disabled", () => {
    const node = new Node();
    expect(sender(node, { chainId: 56, binance: binance(node).api }).state().sales).toBe("protected");
    expect(sender(node, { chainId: 31337, binance: binance(node).api }).state().sales).toBe("public");
    expect(sender(node, { chainId: 56 }).state().sales).toBe("disabled");
  });
});

describe("ChainSender: restart", () => {
  async function stateFile() {
    return path.join(await mkdtemp(path.join(tmpdir(), "desk-sender-")), "sender.json");
  }

  it("keeps every hash signed for the outstanding nonce in the state file, and removes it once mined", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const file = await stateFile();
    const s = sender(node, { stateFile: file, limits: { maxBumps: 1 } });
    await s.send(tx);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toEqual({
      nonce: 7,
      family: [
        { hash: node.rpc[0]!.hash, gasPrice: "110000000", kind: "intent", via: "rpc" },
        { hash: node.rpc[1]!.hash, gasPrice: "123750000", kind: "intent", via: "rpc" },
      ],
    });
    node.mine(node.rpc[1]!);
    await s.recover();
    await expect(stat(file)).rejects.toThrow();
  });

  it("adopts the pending nonce at startup with its recorded hashes and cancels it before anything new", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const file = await stateFile();
    const before = sender(node, { stateFile: file, limits: { maxBumps: 0 } });
    const first = okOf(await before.send(tx)); // stuck at nonce 7, then the process dies
    expect(first.status).toBe("pending");

    node.accept = () => "mine";
    const after = sender(node, { stateFile: file });
    const r = okOf(await after.send(repay)); // a new intent right after the restart
    // First the adopted nonce was settled: a cancel at 12.5% over the recorded price, at the same nonce.
    expect(node.rpc.map((t) => [t.nonce, t.to, t.gasPrice])).toEqual([
      [7, TO, 110_000_000n],
      [7, account.address.toLowerCase(), 123_750_000n],
      [8, TO, 110_000_000n],
    ]);
    expect(node.ahead).toEqual([]);
    expect(r).toMatchObject({ status: "success", nonce: 8 });
    expect(await after.confirm(first.txHash, 7)).toMatchObject({ status: "dropped", minedAs: "cancel", txHash: node.rpc[1]!.hash });
  });

  it("reports the adopted transaction as mined when it lands before the cancel", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const file = await stateFile();
    const first = okOf(await sender(node, { stateFile: file, limits: { maxBumps: 0 } }).send(tx));
    const after = sender(node, { stateFile: file });
    node.onSleep = () => {
      if (node.mempool.has(7)) node.mine(node.rpc[0]!);
    };
    expect(await after.recover()).toMatchObject({ status: "success", txHash: first.txHash, nonce: 7 });
    expect(node.rpc).toHaveLength(1);
  });

  it("outbids a pending transaction it has no record of at twice the network price, capped", async () => {
    const node = new Node();
    const unknown = node.parse(await account.signTransaction({ type: "legacy", chainId: 31337, nonce: 7, to: TO, gas: 21_000n, gasPrice: GWEI / 20n }));
    node.mempool.set(7, unknown);
    node.accept = () => "mine";
    const r = await sender(node).recover();
    expect(node.rpc.map((t) => [t.nonce, t.to, t.gasPrice])).toEqual([[7, account.address.toLowerCase(), 200_000_000n]]);
    expect(r).toMatchObject({ status: "dropped", minedAs: "cancel" });

    const hot = new Node();
    hot.network = 800_000_000n;
    hot.mempool.set(7, unknown);
    await sender(hot).recover();
    expect(hot.rpc[0]!.gasPrice).toBe(1n * GWEI);
  });

  it("reads a transaction the node lost across a restart as dropped: no wedge", async () => {
    const node = new Node();
    node.accept = () => "hold";
    const file = await stateFile();
    const first = okOf(await sender(node, { stateFile: file, limits: { maxBumps: 0 } }).send(tx));
    const after = sender(node, { stateFile: file });
    expect(await after.confirm(first.txHash, 7)).toEqual({ status: "pending" }); // still in the mempool
    node.mempool.clear(); // the node dropped it: latest == nonce == pending and nobody knows the hash
    expect(await after.confirm(first.txHash, 7)).toEqual({ status: "dropped" });
    node.accept = () => "mine";
    expect(okOf(await after.send(repay))).toMatchObject({ status: "success", nonce: 7 });
    // The new intent at nonce 7 is not the old one: the old hash stays gone (dropped once RECEIPT_LAG has passed).
    expect(await after.confirm(first.txHash, 7)).toEqual({ status: "pending" });
    node.time += 45_000;
    expect(await after.confirm(first.txHash, 7)).toEqual({ status: "dropped" });
  });
});

/**
 * A load-balanced RPC: `latest` moves at once, but the receipt of a mined transaction is only served
 * `receiptAfterMs` later, and the node may not even know the transaction for the first `knownAfterMs`.
 */
function lagging(node: Node, o: { receiptAfterMs: number; knownAfterMs?: number }): SenderClient {
  const client = node.client();
  const minedAt = new Map<string, number>();
  const age = (hash: string) => {
    if (node.mined.has(hash) && !minedAt.has(hash)) minedAt.set(hash, node.time);
    const at = minedAt.get(hash);
    return at === undefined ? null : node.time - at;
  };
  return {
    ...client,
    getTransactionReceipt: async (a: { hash: Hex }) => {
      const t = age(a.hash);
      if (t === null || t < o.receiptAfterMs) throw named("TransactionReceiptNotFoundError", "receipt not found");
      return (client.getTransactionReceipt as (x: typeof a) => Promise<unknown>)(a);
    },
    getTransaction: async (a: { hash: Hex }) => {
      const t = age(a.hash);
      if (t !== null && t < (o.knownAfterMs ?? 0)) throw notFound();
      return (client.getTransaction as (x: typeof a) => Promise<unknown>)(a);
    },
  } as unknown as SenderClient;
}

describe("ChainSender: receipts that lag behind the nonce", () => {
  it.each([5_000, 30_000])("waits for a receipt that is served %i ms after the nonce moved: mined, not dropped", async (lag) => {
    const node = new Node();
    const s = sender(node, { client: lagging(node, { receiptAfterMs: lag }) });
    const t0 = node.time;
    const r = okOf(await s.send(tx));
    expect(r).toMatchObject({ status: "success", nonce: 7, minedAs: "intent", gasUsed: 90_000n });
    expect(node.time - t0).toBeGreaterThanOrEqual(lag);
    expect(node.time - t0).toBeLessThan(lag + 7_000); // the pause between looks grows, but stays short
    expect(node.rpc).toHaveLength(1); // nothing was signed again
    expect(s.state()).toMatchObject({ halted: null, outstanding: null });
  });

  it("waits as well when the node only learns of the transaction after a while", async () => {
    const node = new Node();
    const s = sender(node, { client: lagging(node, { receiptAfterMs: 20_000, knownAfterMs: 15_000 }) });
    expect(okOf(await s.send(tx))).toMatchObject({ status: "success", nonce: 7 });
  });

  it("returns pending, never dropped, when the node knows the transaction but serves no receipt in time", async () => {
    const node = new Node();
    const s = sender(node, { client: lagging(node, { receiptAfterMs: 120_000 }) });
    const t0 = node.time;
    const r = okOf(await s.send(tx));
    expect(r).toMatchObject({ status: "pending", nonce: 7 });
    expect(r.halted).toBeUndefined();
    expect(r.note).toMatch(/nonce 7 is used.*no receipt/);
    expect(node.time - t0).toBeGreaterThanOrEqual(45_000);
    // The nonce is used: the sender is free and the next send takes the next nonce.
    expect(s.state()).toMatchObject({ halted: null, outstanding: null });
    expect(await s.confirm(r.txHash, r.nonce)).toEqual({ status: "pending" });
    expect(okOf(await s.send(tx)).nonce).toBe(8);
    // confirm() settles it once the receipt is served
    node.time += 120_000;
    expect(await s.confirm(r.txHash, r.nonce)).toMatchObject({ status: "success", txHash: r.txHash, minedAs: "intent" });
  });

  it("honours RECEIPT_LAG: a shorter limit gives up (as pending) sooner", async () => {
    const node = new Node();
    const s = sender(node, { client: lagging(node, { receiptAfterMs: 30_000 }), limits: { receiptLagMs: 10_000 } });
    const t0 = node.time;
    expect(okOf(await s.send(tx)).status).toBe("pending");
    expect(node.time - t0).toBeGreaterThanOrEqual(10_000);
    expect(node.time - t0).toBeLessThan(17_000);
  });

  it("reads the nonce as gone to a transaction that is not ours only after the full wait with no hash known", async () => {
    const node = new Node();
    node.accept = () => "hold";
    let taken = false;
    node.onSleep = () => {
      if (taken) return;
      taken = true; // someone else used the nonce: our transaction is gone from every node
      node.mempool.clear();
      node.latest = 8;
    };
    const s = sender(node);
    const t0 = node.time;
    const r = okOf(await s.send(tx));
    expect(r).toMatchObject({ status: "dropped", nonce: 7 });
    expect(r.note).toMatch(/not ours/);
    expect(node.time - t0).toBeGreaterThanOrEqual(45_000);
  });
});

describe("ChainSender.confirm", () => {
  it("reads a mined transaction by its hash alone", async () => {
    const node = new Node();
    const s = sender(node);
    const r = okOf(await s.send(tx));
    expect(await s.confirm(r.txHash)).toMatchObject({ status: "success", txHash: r.txHash, minedAs: "intent", logs: [{ address: TO }] });
    expect(await s.confirm(`0x${"ab".repeat(32)}`)).toEqual({ status: "pending" });
  });

  it("reads a used nonce as dropped only once no node has known the hash for RECEIPT_LAG", async () => {
    const node = new Node();
    const s = sender(node);
    const gone = `0x${"ab".repeat(32)}` as Hex;
    expect(await s.confirm(gone, 3)).toEqual({ status: "pending" });
    node.time += 44_000;
    expect(await s.confirm(gone, 3)).toEqual({ status: "pending" });
    node.time += 1_000;
    expect(await s.confirm(gone, 3)).toEqual({ status: "dropped" });
  });

  it("keeps a used nonce pending while the node knows the transaction, however long its receipt takes", async () => {
    const node = new Node();
    const s = sender(node, { client: lagging(node, { receiptAfterMs: 600_000 }) });
    const r = okOf(await s.send(tx));
    for (let i = 0; i < 5; i++) {
      node.time += 60_000;
      expect(await s.confirm(r.txHash, r.nonce)).toEqual({ status: "pending" });
    }
    node.time += 600_000;
    expect(await s.confirm(r.txHash, r.nonce)).toMatchObject({ status: "success" });
  });

  it("rethrows RPC failures", async () => {
    const node = new Node();
    const client = { ...node.client(), getTransactionReceipt: async () => Promise.reject(new Error("fetch failed")) } as unknown as SenderClient;
    await expect(sender(node, { client }).confirm(`0x${"ab".repeat(32)}`)).rejects.toThrow("fetch failed");
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

