import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Ledger } from "../src/desk/ledger";
import { PINNED_ASSETS, X402Client, X402Error, chooseRoute, parseChallenge, resourceLabel } from "../src/desk/x402";

const account = privateKeyToAccount(`0x${"59".repeat(32)}`);
const PAY_TO = getAddress("0x50ab2018c06c6e4eaa9ba52057eb55ed284912fc");
const USD1 = PINNED_ASSETS.find((a) => a.symbol === "USD1")!;
const USDC = PINNED_ASSETS.find((a) => a.symbol === "USDC")!;
const NOW = 1_791_000_000;
const URL_ = "https://data.example/api/calendar/earnings?ticker=NVDA&from=2026-10-07&to=2027-02-04";

const bsc = (amount = "2500000000000000", extra: Record<string, unknown> = { name: USD1.name, version: "1", assetTransferMethod: "eip3009" }) => ({
  scheme: "exact",
  network: "eip155:56",
  asset: USD1.address,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra,
});
const base = (amount = "2500") => ({ scheme: "exact", network: "eip155:8453", asset: USDC.address, amount, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const challenge = (accepts: Record<string, unknown>[]) => ({ x402Version: 2, accepts, resource: { url: URL_ } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("parseChallenge", () => {
  it("reads the v2 PAYMENT-REQUIRED header and the v1 body", () => {
    const h = new Headers({ "PAYMENT-REQUIRED": b64(challenge([base()])) });
    expect(parseChallenge(h, "")?.accepts[0]).toMatchObject({ network: "eip155:8453" });
    expect(parseChallenge(new Headers(), JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "bsc" }] }))?.x402Version).toBe(1);
    expect(parseChallenge(new Headers(), "not json")).toBeNull();
  });

  it("prefers the v2 header over a narrower v1 body", () => {
    const h = new Headers({ "PAYMENT-REQUIRED": b64(challenge([base(), bsc()])) });
    const body = JSON.stringify({ x402Version: 1, accepts: [{ ...base(), network: "base" }] });
    const c = parseChallenge(h, body)!;
    expect(c.x402Version).toBe(2);
    expect(c.accepts).toHaveLength(2);
  });
});

describe("chooseRoute", () => {
  const nets = ["eip155:56", "eip155:8453"];
  it("prefers the networks in order and prices with the pinned decimals", () => {
    const r = chooseRoute(challenge([base(), bsc()]), { networks: nets, maxUsd: 0.05 });
    expect(r.route).toMatchObject({ network: "eip155:56", usd: 0.0025, payTo: PAY_TO });
    expect(chooseRoute(challenge([base(), bsc()]), { networks: ["eip155:8453"], maxUsd: 0.05 }).route).toMatchObject({ network: "eip155:8453", usd: 0.0025 });
  });

  it("refuses unknown assets, other schemes and methods, a mismatched EIP-712 domain and prices over the cap", () => {
    const r = chooseRoute(
      challenge([
        { ...bsc(), asset: "0x55d398326f99059ff775485246999027b3197955" },
        { ...bsc(), scheme: "upto" },
        bsc("2500000000000000", { name: USD1.name, version: "1", assetTransferMethod: "permit2" }),
        bsc("2500000000000000", { name: "Fake Dollar", version: "1" }),
        bsc("60000000000000000"),
        { ...base(), network: "eip155:1" },
      ]),
      { networks: nets, maxUsd: 0.05 },
    );
    expect(r.route).toBeNull();
    expect(r.overPrice).toBe(true);
    expect(r.reasons).toHaveLength(6);
    expect(r.reasons.join("\n")).toMatch(/not one the desk pays with[\s\S]*scheme upto[\s\S]*permit2[\s\S]*does not match[\s\S]*above the \$0.05[\s\S]*not allowed/);
  });
});

function merchant(o: { price?: string; settle?: { success: boolean; transaction?: string; errorReason?: string }; paidStatus?: number; free?: boolean } = {}) {
  const calls: { headers: Record<string, string> }[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ headers });
    if (o.free) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (!headers["PAYMENT-SIGNATURE"] && !headers["X-PAYMENT"]) {
      return new Response(JSON.stringify({ error: "PAYMENT-SIGNATURE required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": b64(challenge([bsc(o.price)])) },
      });
    }
    const settle = o.settle ?? { success: true, transaction: `0x${"cd".repeat(32)}` };
    return new Response(JSON.stringify({ items: [{ date: "2026-11-18", symbol: "NVDA", hour: "amc" }] }), {
      status: o.paidStatus ?? 200,
      headers: { "PAYMENT-RESPONSE": b64({ ...settle, network: "eip155:56" }) },
    });
  }) as typeof fetch;
  return { f, calls };
}

async function client(o: { cap?: number; dryRun?: boolean; fetch: typeof fetch }) {
  const ledger = new Ledger({ dir: await mkdtemp(path.join(tmpdir(), "desk-x402-")), x402DailyCapUsd: o.cap ?? 0.5, clock: () => NOW });
  const c = new X402Client({ account, ledger, maxUsdPerCall: 0.05, networks: ["eip155:56", "eip155:8453"], dryRun: o.dryRun ?? false, fetch: o.fetch, clock: () => NOW });
  return { c, ledger };
}

describe("X402Client", () => {
  it("pays a 402 with a valid EIP-3009 authorization and books it with the settlement transaction", async () => {
    const m = merchant();
    const { c, ledger } = await client({ fetch: m.f });
    const r = await c.get(URL_);
    expect(r.body).toEqual({ items: [{ date: "2026-11-18", symbol: "NVDA", hour: "amc" }] });
    expect(r.payment).toMatchObject({ usd: 0.0025, network: "eip155:56", symbol: "USD1", txHash: `0x${"cd".repeat(32)}` });
    expect(m.calls).toHaveLength(2);
    const sent = m.calls[1]!.headers;
    expect(sent["X-PAYMENT"]).toBe(sent["PAYMENT-SIGNATURE"]);
    const env = JSON.parse(Buffer.from(sent["PAYMENT-SIGNATURE"]!, "base64").toString()) as {
      x402Version: number;
      accepted: { network: string };
      payload: { signature: Hex; authorization: Record<string, string> };
    };
    expect(env.x402Version).toBe(2);
    expect(env.accepted.network).toBe("eip155:56");
    const a = env.payload.authorization;
    expect(a).toMatchObject({ from: account.address, to: PAY_TO, value: "2500000000000000", validAfter: String(NOW - 120), validBefore: String(NOW + 300) });
    const signer = await recoverTypedDataAddress({
      domain: { name: USD1.name, version: "1", chainId: 56, verifyingContract: USD1.address },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value!), validAfter: BigInt(a.validAfter!), validBefore: BigInt(a.validBefore!), nonce: a.nonce as Hex },
      signature: env.payload.signature,
    });
    expect(signer).toBe(account.address);
    expect(ledger.list({ kind: "x402" })[0]).toMatchObject({ status: "settled", usd: 0.0025, resource: resourceLabel(URL_), txHash: `0x${"cd".repeat(32)}` });
    expect(ledger.x402SpentToday(NOW)).toBe(0.0025);
  });

  it("never signs when the daily cap has no room", async () => {
    const m = merchant();
    const { c, ledger } = await client({ fetch: m.f, cap: 0.002 });
    await expect(c.get(URL_)).rejects.toMatchObject({ code: "cap" });
    expect(m.calls).toHaveLength(1);
    expect(ledger.list()).toEqual([]);
  });

  it("never pays above the per-call cap", async () => {
    const m = merchant({ price: "60000000000000000" });
    const { c, ledger } = await client({ fetch: m.f });
    await expect(c.get(URL_)).rejects.toMatchObject({ code: "price" });
    expect(m.calls).toHaveLength(1);
    expect(ledger.list()).toEqual([]);
  });

  it("in DRY_RUN reports the price and pays nothing", async () => {
    const m = merchant();
    const { c, ledger } = await client({ fetch: m.f, dryRun: true });
    const err = await c.get(URL_).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402Error);
    expect(err).toMatchObject({ code: "dry-run", route: { usd: 0.0025, network: "eip155:56", symbol: "USD1" } });
    expect(m.calls).toHaveLength(1);
    expect(ledger.list()).toEqual([]);
  });

  it("counts a signed payment against the cap even when the paid request fails", async () => {
    const m = merchant({ paidStatus: 502, settle: { success: false, errorReason: "facilitator_down" } });
    const { c, ledger } = await client({ fetch: m.f });
    await expect(c.get(URL_)).rejects.toMatchObject({ code: "paid-failed" });
    expect(ledger.list({ kind: "x402" })[0]).toMatchObject({ status: "failed", note: expect.stringMatching(/502 facilitator_down/) });
    expect(ledger.x402SpentToday(NOW)).toBe(0.0025);
  });

  it("returns free resources without paying", async () => {
    const m = merchant({ free: true });
    const { c } = await client({ fetch: m.f });
    expect((await c.get(URL_)).payment).toBeNull();
  });
});
