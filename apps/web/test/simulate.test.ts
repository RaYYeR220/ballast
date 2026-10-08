import { writes } from "@ballast/sdk";
import { describe, expect, it, vi } from "vitest";
import { handleSimulate, simulateDeps } from "../lib/server/handlers/simulate";
import { simulateTx, type SimulateDeps } from "../lib/server/simulate";
import { serverEnv } from "../lib/server/env";
import { addr, DEPLOYMENT, errorData, jsonRequest, stubClient } from "./helpers";

const FROM = addr(0xb1);
const ACCOUNT = addr(0xbb);
const tx = writes.restore(ACCOUNT, 10n ** 18n);
const simTx = { from: FROM, ...tx };

const deps = (o: Partial<SimulateDeps>): SimulateDeps => ({ chainId: 56, call: async () => "0x", binance: null, ...o });

describe("simulateTx", () => {
  it("runs eth_call without Binance keys and says so", async () => {
    const { client, calls } = stubClient(() => ({ ok: "0x" }));
    const r = await simulateTx(simTx, simulateDeps(serverEnv({}), client));
    expect(r).toEqual({ via: "rpc", ok: true });
    expect(calls[0]!.from!.toLowerCase()).toBe(FROM.toLowerCase());
    expect(calls[0]).toMatchObject({ to: ACCOUNT.toLowerCase(), data: tx.data });
  });

  it("decodes a Ballast revert from eth_call", async () => {
    const { client } = stubClient(() => ({ revert: errorData("RestoreRefused", [3]) }));
    const r = await simulateTx(simTx, simulateDeps(serverEnv({}), client));
    expect(r.ok).toBe(false);
    expect(r.via).toBe("rpc");
    expect(r.error).toMatchObject({ name: "RestoreRefused", reason: "NOT_REGULAR", args: ["3"] });
    expect(r.error!.message).toContain("the US market is not in its regular session");
  });

  it("throws on a transport failure (not a refusal)", async () => {
    const { client } = stubClient(() => ({ fail: "connection reset" }));
    await expect(simulateTx(simTx, simulateDeps(serverEnv({}), client))).rejects.toThrow();
  });

  it("uses the Binance Transaction API on mainnet when keyed", async () => {
    const binance = vi.fn(async () => ({ status: "SUCCESS" as const, failReason: null, balanceChanges: [], allowanceChanges: [] }));
    const call = vi.fn(async () => "0x");
    const r = await simulateTx(simTx, deps({ binance, call }));
    expect(r).toEqual({ via: "binance", ok: true, balanceChanges: [] });
    expect(binance).toHaveBeenCalledWith({ binanceChainId: "56", evmTx: { from: FROM, to: ACCOUNT, value: "0", data: tx.data } });
    expect(call).not.toHaveBeenCalled();
  });

  it("replays a Binance failure on eth_call for the decoded error", async () => {
    const binance = vi.fn(async () => ({ status: "FAILED" as const, failReason: "execution reverted", balanceChanges: [], allowanceChanges: [] }));
    const { client } = stubClient(() => ({ revert: errorData("ExceedsMandate", [6300, 6000]) }));
    const r = await simulateTx(simTx, { ...simulateDeps(serverEnv({}), client), chainId: 56, binance });
    expect(r.via).toBe("binance");
    expect(r.error).toMatchObject({ name: "ExceedsMandate", message: "LTV would be 63.00%, above the owner's cap of 60.00%" });
  });

  it("lets eth_call decide when Binance fails and eth_call passes", async () => {
    const binance = vi.fn(async () => ({ status: "FAILED" as const, failReason: "stale state", balanceChanges: [], allowanceChanges: [] }));
    const r = await simulateTx(simTx, deps({ binance }));
    expect(r).toMatchObject({ via: "rpc", ok: true });
    expect(r.note).toContain("stale state");
  });

  it("falls back to eth_call when Binance is unavailable (e.g. region block)", async () => {
    const binance = vi.fn(async () => {
      throw new Error("HTTP 403 code 40304: restricted region");
    });
    const r = await simulateTx(simTx, deps({ binance }));
    expect(r).toMatchObject({ via: "rpc", ok: true });
    expect(r.note).toContain("40304");
  });

  it("never asks Binance about a fork", async () => {
    const binance = vi.fn();
    const r = await simulateTx(simTx, deps({ chainId: 31337, binance }));
    expect(r.via).toBe("rpc");
    expect(binance).not.toHaveBeenCalled();
  });
});

describe("POST /api/simulate", () => {
  const ok = stubClient(() => ({ ok: "0x" })).client;
  const d = simulateDeps(serverEnv({}), ok);

  it("validates the body", async () => {
    for (const body of ["nope", [], { from: "0x1", to: ACCOUNT, data: "0x" }, { from: FROM, to: ACCOUNT, data: "xyz" }, { from: FROM, to: ACCOUNT, data: "0x", value: "-1" }]) {
      const res = await handleSimulate(jsonRequest("http://x/api/simulate", body), d);
      expect(res.status).toBe(400);
    }
  });

  it("answers a refusal with 200 and the decoded error", async () => {
    const { client } = stubClient(() => ({ revert: errorData("BadMarket") }));
    const create = writes.createListaAccount(DEPLOYMENT, {
      marketParams: { loanToken: addr(1), collateralToken: addr(2), oracle: addr(3), irm: addr(4), lltv: 75n * 10n ** 16n },
      symbol: "NVDA",
      keeper: addr(5),
      mandate: { maxLtvBps: 6000, shieldLtvBps: 4500, maxSlippageBps: 100, autoRestore: true },
    });
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: create.to, data: create.data }), simulateDeps(serverEnv({}), client));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ via: "rpc", ok: false, error: { name: "BadMarket", message: "the market does not match the symbol or venue", args: [] } });
  });

  it("answers 502 when no simulator can run", async () => {
    const { client } = stubClient(() => ({ fail: "socket hang up" }));
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: ACCOUNT, data: "0x" }), simulateDeps(serverEnv({}), client));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/^simulation unavailable/);
  });

  it("keeps the Binance secret out of the answer", async () => {
    const env = serverEnv({ BINANCE_WEB3_API_KEY: "key-123456", BINANCE_WEB3_API_SECRET: "secret-abcdef" });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ code: "000000", data: { status: "SUCCESS", failReason: null, balanceChanges: [], allowanceChanges: [] } })));
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: ACCOUNT, data: "0x" }), simulateDeps(env, ok, fetchSpy as never));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ via: "binance", ok: true });
    expect(text).not.toContain("secret-abcdef");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://web3.binance.com/build/api/v1/dex/pre-transaction/simulate");
    expect((init.headers as Record<string, string>)["X-API-KEY"] ?? JSON.stringify(init.headers)).toContain("key-123456");
  });
});
