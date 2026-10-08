/* GET /api/desk/<view>: the desk agent's read API through our server, so the browser never needs the desk's
   address and an unreachable desk becomes an explicit { status: "offline" } answer. Only five views exist here
   (health, feed, oracle, ledger, evidence); each takes only the parameters listed for it, checked against fixed
   lists, and anything else is refused. */
import { DESK_FEED_KINDS, DESK_FEED_SOURCES, DESK_LEDGER_KINDS, type DeskView } from "@/lib/desk";
import { deskFeed, deskGet, deskHealth, type DeskFetchOptions, type DeskQuery } from "../agent";
import { LIMITS } from "../limits";
import { intParam, optionalAddress, query as queryOf } from "../params";

/** the query parameters each view accepts */
const PARAMS: Record<DeskView, readonly string[]> = {
  health: [],
  feed: ["account", "kind", "source", "limit"],
  oracle: [],
  ledger: ["kind", "limit"],
  evidence: ["jobId"],
};

const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

function oneOf(q: URLSearchParams, name: string, allowed: readonly string[]): string | undefined | Response {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  return allowed.includes(v) ? v : bad(`${name} is not one of: ${allowed.join(", ")}`);
}

/** The validated query for a view, or the answer that refuses it. */
export function deskQuery(view: DeskView, q: URLSearchParams): DeskQuery | Response {
  for (const name of q.keys()) if (!PARAMS[view].includes(name)) return bad(`${view} does not take the parameter "${name.slice(0, 32)}"`);
  const out: DeskQuery = {};
  if (view === "feed") {
    const account = optionalAddress(q, "account");
    if (account instanceof Response) return account;
    if (account) out.account = account;
    const source = oneOf(q, "source", DESK_FEED_SOURCES);
    if (source instanceof Response) return source;
    if (source) out.source = source;
  }
  if (view === "feed" || view === "ledger") {
    const kind = oneOf(q, "kind", view === "feed" ? DESK_FEED_KINDS : DESK_LEDGER_KINDS);
    if (kind instanceof Response) return kind;
    if (kind) out.kind = kind;
    const limit = intParam(q, "limit", { min: 1, max: LIMITS.feedEvents, fallback: 100 });
    if (limit instanceof Response) return limit;
    out.limit = limit;
  }
  if (view === "evidence") {
    const jobId = q.get("jobId");
    if (!jobId || !/^\d{1,30}$/.test(jobId)) return bad("jobId must be a decimal number");
    out.jobId = BigInt(jobId).toString();
  }
  return out;
}

export async function handleDesk(req: Request, view: string, o: DeskFetchOptions): Promise<Response> {
  if (!Object.hasOwn(PARAMS, view)) return bad("unknown desk view", 404);
  const v = view as DeskView;
  const q = queryOf(req);
  if (q instanceof Response) return q;
  const query = deskQuery(v, q);
  if (query instanceof Response) return query;
  const r = v === "feed" ? await deskFeed(query, o) : v === "health" ? await deskHealth(o) : await deskGet(v, query, o);
  const cache = r.status === "online" ? "public, s-maxage=10, stale-while-revalidate=20" : "no-store";
  return Response.json(r, { headers: { "cache-control": cache } });
}
