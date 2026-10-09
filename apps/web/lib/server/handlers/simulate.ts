/* POST /api/simulate: { from, to, data, value?, ticket? } -> SimResult. The Binance key and the RPC URL stay
   server-side, so this route must not become a relay for arbitrary calls on them. It answers only:
   - requests from this site's own pages (same origin, JSON),
   - for a call to the Ballast factory, the cushion vault, an account the factory knows, an `approve` on a
     token this app uses, or one of the three ERC-8183 kernel calls the guardian hire flow makes,
   - or for one exact transaction this server built and signed a ticket for (a swap from the Trading API). */
import { transaction } from "@ballast/binance";
import { ballastFactoryAbi, kernelAbi, type Deployment } from "@ballast/sdk";
import { getAddress, isAddress, isHex, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { tokenSymbol } from "@/lib/markets";
import { web3Client } from "../binance";
import { ttlCache } from "../cache";
import type { ServerEnv } from "../env";
import { readCapped, TooLargeError } from "../guard";
import { LIMITS } from "../limits";
import { shortMessage, simulateTx, type SimulateDeps } from "../simulate";
import { checkTicket } from "../ticket";

const NO_STORE = { "cache-control": "no-store" };
/** approve(address,uint256) */
const APPROVE = "0x095ea7b3";
/** the kernel calls the hire flow simulates: post the job, set its fee, fund it. Nothing else on the kernel. */
const KERNEL_SELECTORS: ReadonlySet<string> = new Set(
  (["createJobWithToken", "setBudget", "fund"] as const).map((name) => {
    const item = kernelAbi.find((x) => x.type === "function" && x.name === name);
    if (!item) throw new Error(`kernel ABI has no ${name}`);
    return toFunctionSelector(item as never).toLowerCase();
  }),
);

export function simulateDeps(e: ServerEnv, client: Pick<PublicClient, "call">, fetchImpl?: typeof fetch): SimulateDeps {
  const web3 = web3Client(e, fetchImpl);
  return {
    chainId: e.chainId,
    call: (tx) => client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }),
    binance: web3 ? (body) => transaction.simulate(web3, body) : null,
  };
}

// --------------------------------------------------------------------- guard

export interface SimulateGuard {
  /** null when the target may be simulated, else why not (for the 400 answer) */
  refuse(tx: { from: Address; to: Address; data: Hex; value: bigint }, ticket: unknown): Promise<string | null>;
}

/** accounts the factory has confirmed, per factory; a positive never changes, so it is kept */
const knownAccounts = new Map<string, Set<string>>();
/** a "no" is remembered briefly, so one bad address is not an RPC read per request */
const notAccounts = ttlCache<boolean>(60_000, { max: 2000 });

export function simulateGuard(o: {
  chainId: number;
  deployment: Deployment | null;
  client: Pick<PublicClient, "readContract">;
  /** key for swap tickets (the Binance API secret); without it no ticket is accepted */
  ticketSecret: string | null;
  now?: () => number;
}): SimulateGuard {
  const d = o.deployment;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  async function isAccount(to: Address): Promise<boolean> {
    if (!d) return false;
    const fk = d.factory.toLowerCase();
    let yes = knownAccounts.get(fk);
    if (!yes) knownAccounts.set(fk, (yes = new Set()));
    const k = to.toLowerCase();
    if (yes.has(k)) return true;
    const is = await notAccounts.get(`${fk}|${k}`, async () => {
      const r = await o.client.readContract({ address: d.factory, abi: ballastFactoryAbi, functionName: "isAccount", args: [to] });
      if (!r) return false;
      if (yes.size >= LIMITS.knownAccounts) yes.delete(yes.values().next().value as string);
      yes.add(k);
      return true;
    });
    return is;
  }
  return {
    async refuse(tx, ticket) {
      if (d && (same(tx.to, d.factory) || same(tx.to, d.cushionVault))) return null;
      if (d && same(tx.to, d.external.kernel)) {
        return KERNEL_SELECTORS.has(tx.data.slice(0, 10).toLowerCase()) ? null : "only createJobWithToken, setBudget and fund are simulated on the kernel";
      }
      if (tokenSymbol(tx.to) !== null) {
        return tx.data.slice(0, 10).toLowerCase() === APPROVE ? null : "only approve() is simulated on a token";
      }
      if (ticket !== undefined && ticket !== null) {
        const nowSec = Math.floor((o.now?.() ?? Date.now()) / 1000);
        if (o.ticketSecret && checkTicket(o.ticketSecret, ticket, { chainId: o.chainId, ...tx }, nowSec)) return null;
        return "the ticket for this transaction is not valid or has expired: build it again";
      }
      if (await isAccount(tx.to)) return null;
      return "this address is not a Ballast contract, a Ballast account or a token this app uses";
    },
  };
}

// ------------------------------------------------------------------- handler

const answer = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

/** True for a request made by a page of this site: the browser says so, or its Origin is our host. */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function handleSimulate(req: Request, deps: SimulateDeps, guard: SimulateGuard): Promise<Response> {
  if (!sameOrigin(req)) return answer("this endpoint only answers the app's own pages", 403);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return answer("content-type must be application/json", 415);
  // the body is read only up to the limit: a declared or streamed body beyond it is refused, not buffered
  let text: string;
  try {
    text = await readCapped(req, LIMITS.bodyBytes);
  } catch (err) {
    if (err instanceof TooLargeError) return answer("request too large", 413);
    return answer("unreadable request body", 400);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return answer("expected a JSON object", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return answer("expected a JSON object", 400);
  }
  const { from, to, data } = body;
  const value = body.value ?? "0";
  if (typeof from !== "string" || !isAddress(from, { strict: false })) return answer("from must be a 0x address", 400);
  if (typeof to !== "string" || !isAddress(to, { strict: false })) return answer("to must be a 0x address", 400);
  if (typeof data !== "string" || !isHex(data) || data.length % 2 !== 0) return answer("data must be 0x hex", 400);
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return answer("value must be a decimal string of wei", 400);
  const tx = { from: getAddress(from), to: getAddress(to), data: data as Hex, value: BigInt(value) };
  try {
    const refused = await guard.refuse(tx, body.ticket);
    if (refused) return answer(refused, 400);
    const r = await simulateTx(tx, deps);
    return Response.json(r, { headers: NO_STORE });
  } catch (err) {
    return answer(`simulation unavailable: ${shortMessage(err)}`, 502);
  }
}
