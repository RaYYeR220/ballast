// x402 buyer for the desk's paid data. A GET that answers 402 Payment Required is paid with an EIP-3009
// transferWithAuthorization signed by the desk key, on the "exact" scheme only and only in a stablecoin this
// module pins (token address, EIP-712 name and version): BSC USD1 and U (the B402 rails) and Base USDC.
// Every payment passes two checks before anything is signed: the price is at most the per-call cap and the
// ledger's daily cap still has room. The spend is booked as soon as it is signed (a signed authorization can
// settle even if the paid request then fails). Speaks x402 v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
// PAYMENT-RESPONSE) and v1 (body challenge / X-PAYMENT / X-PAYMENT-RESPONSE).
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex, type LocalAccount } from "viem";
import type { Ledger } from "./ledger";

export interface PinnedAsset {
  network: string;
  chainId: number;
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 domain of the token (checked against the chain: DOMAIN_SEPARATOR / eip712Domain). */
  name: string;
  version: string;
}

/** The only assets the desk pays with. */
export const PINNED_ASSETS: readonly PinnedAsset[] = [
  { network: "eip155:56", chainId: 56, address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", symbol: "USD1", decimals: 18, name: "World Liberty Financial USD", version: "1" },
  { network: "eip155:56", chainId: 56, address: "0xcE24439F2D9C6a2289F741120FE202248B666666", symbol: "U", decimals: 18, name: "United Stables", version: "1" },
  { network: "eip155:8453", chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, name: "USD Coin", version: "2" },
];

/** x402 v1 network names. */
const V1_NETWORKS: Record<string, string> = { bsc: "eip155:56", "bsc-testnet": "eip155:97", base: "eip155:8453", "base-sepolia": "eip155:84532" };
/** validAfter is back-dated this much against clock skew between us and the facilitator. */
const VALID_AFTER_BACKDATE_SEC = 120;
const MAX_VALIDITY_SEC = 600;
const TIMEOUT_MS = 20_000;

export type X402ErrorCode = "http" | "challenge" | "no-route" | "price" | "cap" | "dry-run" | "paid-failed";

export class X402Error extends Error {
  constructor(
    readonly code: X402ErrorCode,
    message: string,
    readonly route?: Pick<PaymentRoute, "network" | "usd" | "payTo"> & { symbol: string },
  ) {
    super(message);
    this.name = "X402Error";
  }
}

export interface Challenge {
  x402Version: number;
  accepts: Record<string, unknown>[];
  resource: unknown;
}

export interface PaymentRoute {
  x402Version: 1 | 2;
  /** The accepts entry exactly as the merchant sent it (echoed back in a v2 payment). */
  accepted: Record<string, unknown>;
  resource: unknown;
  network: string;
  asset: PinnedAsset;
  amount: bigint;
  usd: number;
  payTo: Address;
  maxTimeoutSeconds: number;
}

const decodeB64Json = (v: string): unknown => JSON.parse(Buffer.from(v, "base64").toString("utf8"));
const encodeB64Json = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/**
 * The 402 challenge: the v2 PAYMENT-REQUIRED header when present (it is canonical; some merchants put a
 * narrower v1 challenge in the body next to it), else the JSON body (v1).
 */
export function parseChallenge(headers: Headers, bodyText: string): Challenge | null {
  for (const name of ["payment-required", "x-payment-requirements"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const c = decodeB64Json(h) as Challenge;
      if (Array.isArray(c.accepts)) return { x402Version: Number(c.x402Version ?? 2), accepts: c.accepts, resource: c.resource ?? null };
    } catch {
      // unreadable header: try the body
    }
  }
  let body: unknown = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return null;
  }
  const c = body && typeof body === "object" && Array.isArray((body as Challenge).accepts) ? (body as Challenge) : null;
  return c ? { x402Version: Number(c.x402Version ?? 1), accepts: c.accepts, resource: c.resource ?? null } : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/**
 * The cheapest route the desk may pay: exact scheme, EIP-3009, a pinned asset on an allowed network whose
 * EIP-712 domain (when the merchant states one) matches ours, price within `maxUsd`. Networks are preferred
 * in the order given. Reasons explain every rejected entry.
 */
export function chooseRoute(c: Challenge, o: { networks: readonly string[]; maxUsd: number }): { route: PaymentRoute | null; reasons: string[]; overPrice: boolean } {
  const reasons: string[] = [];
  const ok: PaymentRoute[] = [];
  let overPrice = false;
  for (const a of c.accepts) {
    const rawNet = str(a.network) ?? "";
    const network = rawNet.startsWith("eip155:") ? rawNet : (V1_NETWORKS[rawNet] ?? rawNet);
    const label = `${network}/${str(a.asset) ?? "?"}`;
    if (a.scheme !== "exact") {
      reasons.push(`${label}: scheme ${String(a.scheme)} is not supported`);
      continue;
    }
    if (!o.networks.includes(network)) {
      reasons.push(`${label}: network not allowed`);
      continue;
    }
    const assetAddr = str(a.asset);
    const asset = PINNED_ASSETS.find((p) => p.network === network && assetAddr !== undefined && p.address.toLowerCase() === assetAddr.toLowerCase());
    if (!asset) {
      reasons.push(`${label}: asset is not one the desk pays with`);
      continue;
    }
    const extra = (a.extra ?? {}) as Record<string, unknown>;
    const method = str(extra.assetTransferMethod);
    if (method !== undefined && method !== "eip3009") {
      reasons.push(`${label}: transfer method ${method} is not supported`);
      continue;
    }
    if ((extra.name !== undefined && extra.name !== asset.name) || (extra.version !== undefined && String(extra.version) !== asset.version)) {
      reasons.push(`${label}: EIP-712 domain ${String(extra.name)}/${String(extra.version)} does not match the token`);
      continue;
    }
    const payTo = str(a.payTo);
    if (!payTo || !isAddress(payTo, { strict: false })) {
      reasons.push(`${label}: payTo is not an EVM address`);
      continue;
    }
    const rawAmount = str(a.amount) ?? str(a.maxAmountRequired);
    if (!rawAmount || !/^\d+$/.test(rawAmount) || BigInt(rawAmount) === 0n) {
      reasons.push(`${label}: no valid amount`);
      continue;
    }
    const amount = BigInt(rawAmount);
    const usd = Number(amount) / 10 ** asset.decimals;
    if (usd > o.maxUsd) {
      overPrice = true;
      reasons.push(`${label}: price $${usd} is above the $${o.maxUsd} per-call cap`);
      continue;
    }
    ok.push({
      x402Version: c.x402Version === 1 ? 1 : 2,
      accepted: a,
      resource: c.resource,
      network,
      asset,
      amount,
      usd,
      payTo: getAddress(payTo),
      maxTimeoutSeconds: Math.max(60, Math.min(MAX_VALIDITY_SEC, Number(a.maxTimeoutSeconds ?? 300) || 300)),
    });
  }
  ok.sort((x, y) => o.networks.indexOf(x.network) - o.networks.indexOf(y.network) || x.usd - y.usd);
  return { route: ok[0] ?? null, reasons, overPrice };
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** Signs the EIP-3009 authorization for `route` and returns the payment header value. */
export async function signPayment(
  route: PaymentRoute,
  account: Pick<LocalAccount, "address" | "signTypedData">,
  now: number,
  nonce: Hex = `0x${randomBytes(32).toString("hex")}`,
): Promise<{ header: string; authorization: Record<string, string> }> {
  const validAfter = now - VALID_AFTER_BACKDATE_SEC;
  const validBefore = now + route.maxTimeoutSeconds;
  const signature = await account.signTypedData({
    domain: { name: route.asset.name, version: route.asset.version, chainId: route.asset.chainId, verifyingContract: route.asset.address },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: route.payTo, value: route.amount, validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
  });
  const authorization = {
    from: account.address,
    to: route.payTo,
    value: route.amount.toString(),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };
  const envelope =
    route.x402Version === 1
      ? { x402Version: 1, scheme: "exact", network: str(route.accepted.network), payload: { signature, authorization } }
      : { x402Version: 2, resource: route.resource, accepted: route.accepted, payload: { signature, authorization } };
  return { header: encodeB64Json(envelope), authorization };
}

/** Scheme, host and path of a URL: what the ledger and the feed keep (queries may carry anything). */
export function resourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

export interface X402Payment {
  ledgerId: number;
  usd: number;
  network: string;
  symbol: string;
  payTo: Address;
  txHash: string | null;
}

export interface X402Response {
  status: number;
  body: unknown;
  payment: X402Payment | null;
}

export interface X402ClientOptions {
  account: Pick<LocalAccount, "address" | "signTypedData">;
  ledger: Pick<Ledger, "x402Allows" | "record" | "updateX402">;
  maxUsdPerCall: number;
  networks: readonly string[];
  dryRun: boolean;
  fetch?: typeof fetch;
  /** Unix seconds. */
  clock?: () => number;
  timeoutMs?: number;
}

export class X402Client {
  readonly #o: X402ClientOptions;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;

  constructor(o: X402ClientOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  async get(url: string): Promise<X402Response> {
    const first = await this.#request(url, {});
    if (first.res.status !== 402) {
      if (!first.res.ok) throw new X402Error("http", `${resourceLabel(url)} answered ${first.res.status}`);
      return { status: first.res.status, body: parseBody(first.text), payment: null };
    }
    const challenge = parseChallenge(first.res.headers, first.text);
    if (!challenge) throw new X402Error("challenge", `${resourceLabel(url)} answered 402 without a readable payment challenge`);
    const { route, reasons, overPrice } = chooseRoute(challenge, { networks: this.#o.networks, maxUsd: this.#o.maxUsdPerCall });
    if (!route) throw new X402Error(overPrice ? "price" : "no-route", `no payable route: ${reasons.join("; ") || "empty accepts"}`);
    const info = { network: route.network, usd: route.usd, payTo: route.payTo, symbol: route.asset.symbol };
    const now = this.#clock();
    // Both caps are checked before anything is signed.
    if (!this.#o.ledger.x402Allows(route.usd, now)) throw new X402Error("cap", `the daily x402 cap would be exceeded by $${route.usd}`, info);
    if (this.#o.dryRun) throw new X402Error("dry-run", `dry run: would pay $${route.usd} in ${route.asset.symbol} on ${route.network}`, info);

    const { header } = await signPayment(route, this.#o.account, now);
    const entry = await this.#o.ledger.record({
      kind: "x402",
      source: "x402",
      resource: resourceLabel(url),
      network: route.network,
      asset: route.asset.address,
      symbol: route.asset.symbol,
      amount: route.amount.toString(),
      usd: route.usd,
      payTo: route.payTo,
      status: "signed",
    });
    const headers: Record<string, string> = route.x402Version === 1 ? { "X-PAYMENT": header } : { "PAYMENT-SIGNATURE": header, "X-PAYMENT": header };
    let paid: { res: Response; text: string };
    try {
      paid = await this.#request(url, headers);
    } catch (err) {
      await this.#o.ledger.updateX402(entry.id, { status: "failed", note: `paid request failed: ${(err as Error).message}` });
      throw new X402Error("paid-failed", `paid request failed: ${(err as Error).message}`, info);
    }
    const settlement = settlementOf(paid.res.headers);
    const txHash = settlement?.transaction ?? null;
    if (!paid.res.ok || settlement?.success === false) {
      const why = `${paid.res.status}${settlement?.errorReason ? ` ${settlement.errorReason}` : ""}`;
      await this.#o.ledger.updateX402(entry.id, { status: "failed", note: `merchant answered ${why}`, ...(txHash ? { txHash } : {}) });
      throw new X402Error("paid-failed", `the paid request answered ${why}`, info);
    }
    await this.#o.ledger.updateX402(entry.id, { status: "settled", ...(txHash ? { txHash } : {}) });
    return { status: paid.res.status, body: parseBody(paid.text), payment: { ledgerId: entry.id, ...info, txHash } };
  }

  async #request(url: string, headers: Record<string, string>): Promise<{ res: Response; text: string }> {
    const res = await this.#fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "ballast-desk/0.1", ...headers },
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? TIMEOUT_MS),
      redirect: "error",
    });
    const text = await res.text();
    return { res, text };
  }
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function settlementOf(h: Headers): { success?: boolean; transaction?: string; errorReason?: string } | null {
  for (const name of ["payment-response", "x-payment-response"]) {
    const v = h.get(name);
    if (!v) continue;
    try {
      const s = decodeB64Json(v) as { success?: unknown; transaction?: unknown; errorReason?: unknown };
      return {
        ...(typeof s.success === "boolean" ? { success: s.success } : {}),
        ...(typeof s.transaction === "string" ? { transaction: s.transaction } : {}),
        ...(typeof s.errorReason === "string" ? { errorReason: s.errorReason } : {}),
      };
    } catch {
      return null;
    }
  }
  return null;
}
