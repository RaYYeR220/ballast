import { bscConfig } from "@ballast/risk";
import { writes } from "@ballast/sdk";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { handleSimulate, sameOrigin, simulateDeps, simulateGuard } from "../lib/server/handlers/simulate";
import { simulateTx, type SimulateDeps } from "../lib/server/simulate";
import { serverEnv } from "../lib/server/env";
import { checkTicket, issueTicket, TICKET_TTL_SEC } from "../lib/server/ticket";
import { addr, ALLOW, DEPLOYMENT, errorData, jsonRequest, stubClient } from "./helpers";

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
    expect(r).toEqual({ via: "binance", ok: true, balanceChanges: [], allowanceChanges: [] });
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
      const res = await handleSimulate(jsonRequest("http://x/api/simulate", body), d, ALLOW);
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
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: create.to, data: create.data }), simulateDeps(serverEnv({}), client), ALLOW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ via: "rpc", ok: false, error: { name: "BadMarket", message: "the market does not match the symbol or venue", args: [] } });
  });

  it("answers 502 when no simulator can run", async () => {
    const { client } = stubClient(() => ({ fail: "socket hang up" }));
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: ACCOUNT, data: "0x" }), simulateDeps(serverEnv({}), client), ALLOW);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/^simulation unavailable/);
  });

  it("keeps the Binance secret out of the answer", async () => {
    const env = serverEnv({ BINANCE_WEB3_API_KEY: "key-123456", BINANCE_WEB3_API_SECRET: "secret-abcdef" });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ code: "000000", data: { status: "SUCCESS", failReason: null, balanceChanges: [], allowanceChanges: [] } })));
    const res = await handleSimulate(jsonRequest("http://x/api/simulate", { from: FROM, to: ACCOUNT, data: "0x" }), simulateDeps(env, ok, fetchSpy as never), ALLOW);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ via: "binance", ok: true });
    expect(text).not.toContain("secret-abcdef");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://web3.binance.com/build/api/v1/dex/pre-transaction/simulate");
    expect((init.headers as Record<string, string>)["X-API-KEY"] ?? JSON.stringify(init.headers)).toContain("key-123456");
  });
});

describe("/api/simulate is not a relay", () => {
  const USD1 = getAddress(bscConfig.tokens.USD1);
  const URL_ = "http://app.test/api/simulate";
  const ok = () => stubClient(() => ({ ok: "0x" }));
  const approve = writes.approve(USD1, ACCOUNT, 5n);
  const transfer = { to: USD1, data: "0xa9059cbb" + "00".repeat(64) };
  /** a guard over DEPLOYMENT whose factory knows exactly `accounts` */
  function guardFor(accounts: string[], opts: { deployed?: boolean; secret?: string | null; now?: () => number } = {}) {
    const readContract = vi.fn(async ({ args }: { args: readonly unknown[] }) => accounts.some((a) => a.toLowerCase() === String(args[0]).toLowerCase()));
    const guard = simulateGuard({
      chainId: 56,
      deployment: opts.deployed === false ? null : { ...DEPLOYMENT, factory: addr(0xf000 + Math.floor(Math.random() * 0xfff)) },
      client: { readContract } as never,
      ticketSecret: opts.secret === undefined ? null : opts.secret,
      now: opts.now,
    });
    return { guard, readContract };
  }
  const post = (body: unknown, guard: { refuse: (...a: never[]) => Promise<string | null> }, client = ok().client, headers?: Record<string, string>) =>
    handleSimulate(jsonRequest(URL_, body, headers), simulateDeps(serverEnv({}), client), guard as never);

  it("simulates calls to the factory, the vault and a known account, and nothing else", async () => {
    const readContract = vi.fn(async ({ args }: { args: readonly unknown[] }) => args[0] === ACCOUNT);
    const guard = simulateGuard({ chainId: 56, deployment: DEPLOYMENT, client: { readContract } as never, ticketSecret: null });
    const c = ok();
    expect((await post({ from: FROM, to: DEPLOYMENT.factory, data: "0x12345678" }, guard, c.client)).status).toBe(200);
    expect((await post({ from: FROM, to: DEPLOYMENT.cushionVault, data: "0x12345678" }, guard, c.client)).status).toBe(200);
    expect(readContract).not.toHaveBeenCalled();
    expect((await post({ from: FROM, to: ACCOUNT, data: tx.data }, guard, c.client)).status).toBe(200);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract.mock.calls[0]![0]).toMatchObject({ address: DEPLOYMENT.factory, functionName: "isAccount", args: [ACCOUNT] });
    expect(c.calls).toHaveLength(3);

    const stranger = addr(0xdead);
    const res = await post({ from: FROM, to: stranger, data: "0x12345678" }, guard, c.client);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a Ballast contract");
    // refused before any simulation ran
    expect(c.calls).toHaveLength(3);
  });

  it("simulates the guardian hire calls on the kernel and refuses every other kernel call", async () => {
    const kernel = DEPLOYMENT.external.kernel;
    const guard = simulateGuard({ chainId: 56, deployment: DEPLOYMENT, client: { readContract: vi.fn(async () => false) } as never, ticketSecret: null });
    const t = (data: string) => ({ from: FROM, to: kernel, data: data as never, value: 0n });
    const hire = [
      writes.createJobWithToken(DEPLOYMENT, { provider: addr(0xaa), expiredAt: 1n, description: "d", token: addr(0xcc) }).data,
      writes.setBudget(DEPLOYMENT, 1n, 5n).data,
      writes.fund(DEPLOYMENT, { jobId: 1n, expectedBudget: 5n, terms: { account: ACCOUNT, start: 1, end: 2, agentId: 1n } }).data,
    ];
    for (const data of hire) expect(await guard.refuse(t(data), undefined)).toBeNull();
    expect(await guard.refuse(t("0x095ea7b3" + "00".repeat(64)), undefined)).toContain("only createJobWithToken");
    expect(await guard.refuse(t("0x12345678"), undefined)).toContain("only createJobWithToken");
    expect(await guard.refuse(t("0x"), undefined)).toContain("only createJobWithToken");
  });

  it("asks the factory once per address: a yes is kept, a no is not asked again right away", async () => {
    const { guard, readContract } = guardFor([ACCOUNT]);
    const t = { from: FROM, to: ACCOUNT, data: tx.data, value: 0n };
    for (let i = 0; i < 5; i++) expect(await guard.refuse(t, undefined)).toBeNull();
    expect(readContract).toHaveBeenCalledTimes(1);
    const no = { ...t, to: addr(0xbad) };
    for (let i = 0; i < 5; i++) expect(await guard.refuse(no, undefined)).toContain("not a Ballast contract");
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it("simulates only approve() on a configured token", async () => {
    const { guard, readContract } = guardFor([]);
    expect(await guard.refuse({ from: FROM, to: approve.to, data: approve.data, value: 0n }, undefined)).toBeNull();
    expect(await guard.refuse({ from: FROM, to: USD1, data: transfer.data as never, value: 0n }, undefined)).toBe("only approve() is simulated on a token");
    expect(readContract).not.toHaveBeenCalled();
  });

  it("without a deployment still simulates token approvals, and nothing else", async () => {
    const { guard, readContract } = guardFor([ACCOUNT], { deployed: false });
    expect(await guard.refuse({ from: FROM, to: approve.to, data: approve.data, value: 0n }, undefined)).toBeNull();
    expect(await guard.refuse({ from: FROM, to: ACCOUNT, data: tx.data, value: 0n }, undefined)).toContain("not a Ballast contract");
    expect(readContract).not.toHaveBeenCalled();
  });

  it("accepts a transaction the server built only with its own unexpired ticket", async () => {
    const router = addr(0x70a7);
    const swap = { chainId: 56, from: FROM, to: router, data: "0xabcdef01" as const, value: 0n };
    let now = 1_000_000_000;
    const { guard, readContract } = guardFor([], { secret: "s3cret", now: () => now });
    const ticket = issueTicket("s3cret", swap, 1_000_000);
    expect(await guard.refuse(swap, ticket)).toBeNull();
    expect(readContract).not.toHaveBeenCalled();
    // any change to the transaction voids it
    expect(await guard.refuse({ ...swap, data: "0xabcdef02" }, ticket)).toContain("ticket");
    expect(await guard.refuse({ ...swap, from: addr(0xb9) }, ticket)).toContain("ticket");
    expect(await guard.refuse({ ...swap, value: 1n }, ticket)).toContain("ticket");
    expect(await guard.refuse({ ...swap, to: addr(0x70a8) }, ticket)).toContain("ticket");
    // another server secret, a forged or malformed ticket
    expect(await guard.refuse(swap, issueTicket("other", swap, 1_000_000))).toContain("ticket");
    expect(await guard.refuse(swap, `${1_000_000 + TICKET_TTL_SEC}.${"0".repeat(64)}`)).toContain("ticket");
    expect(await guard.refuse(swap, "nonsense")).toContain("ticket");
    // expiry
    now = (1_000_000 + TICKET_TTL_SEC + 1) * 1000;
    expect(await guard.refuse(swap, ticket)).toContain("expired");
    // a keyless server accepts no ticket at all
    expect(await guardFor([], { secret: null, now: () => 1_000_000_000 }).guard.refuse(swap, ticket)).toContain("ticket");
    expect(checkTicket("s3cret", ticket, swap, 1_000_000)).toBe(true);
    expect(checkTicket("s3cret", ticket, { ...swap, chainId: 31337 }, 1_000_000)).toBe(false);
  });

  it("answers only this site's own pages", async () => {
    const req = (headers: Record<string, string>) => new Request(URL_, { method: "POST", headers });
    expect(sameOrigin(req({ origin: "http://app.test" }))).toBe(true);
    expect(sameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(req({ "sec-fetch-site": "cross-site", origin: "http://app.test" }))).toBe(false);
    expect(sameOrigin(req({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(sameOrigin(req({}))).toBe(false);
    expect(sameOrigin(req({ origin: "null" }))).toBe(false);
    // behind a proxy the public host is what counts
    expect(sameOrigin(new Request("http://10.0.0.5:3000/api/simulate", { method: "POST", headers: { origin: "https://ballast.example", "x-forwarded-host": "ballast.example" } }))).toBe(true);

    const c = ok();
    const body = { from: FROM, to: DEPLOYMENT.factory, data: "0x12345678" };
    const cross = await post(body, ALLOW, c.client, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const curl = await handleSimulate(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), simulateDeps(serverEnv({}), c.client), ALLOW);
    expect(curl.status).toBe(403);
    expect(c.calls).toHaveLength(0);
  });

  it("takes JSON only", async () => {
    const c = ok();
    const res = await post({ from: FROM, to: DEPLOYMENT.factory, data: "0x" }, ALLOW, c.client, { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    const form = await post({ from: FROM, to: DEPLOYMENT.factory, data: "0x" }, ALLOW, c.client, { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    expect(c.calls).toHaveLength(0);
    expect((await post({ from: FROM, to: DEPLOYMENT.factory, data: "0x" }, ALLOW, c.client, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
  });
});
