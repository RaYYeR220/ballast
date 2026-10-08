/* GET /api/desk/<view>: the desk agent's read API through our server, so the browser never needs the desk's
   address and an unreachable desk becomes an explicit { status: "offline" } answer. */
import type { DeskView } from "@/lib/desk";
import { deskFeed, deskGet, type DeskFetchOptions, type DeskQuery } from "../agent";

const VIEWS: readonly DeskView[] = ["health", "feed", "accounts", "oracle", "ledger", "api-health", "evidence"];
const KINDS = /^[a-z][a-z-]{1,15}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function handleDesk(req: Request, view: string, o: DeskFetchOptions): Promise<Response> {
  if (!VIEWS.includes(view as DeskView)) return bad("unknown desk view", 404);
  const q = new URL(req.url).searchParams;
  const query: DeskQuery = {};
  const account = q.get("account");
  if (account) {
    if (!ADDRESS.test(account)) return bad("account must be a 0x address");
    query.account = account;
  }
  const limit = q.get("limit");
  if (limit) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1) return bad("limit must be a positive integer");
    query.limit = Math.min(Number(limit), 500);
  }
  for (const k of ["kind", "source"] as const) {
    const v = q.get(k);
    if (v) {
      if (!KINDS.test(v)) return bad(`${k} is not valid`);
      query[k] = v;
    }
  }
  if (view === "evidence") {
    const jobId = q.get("jobId");
    if (!jobId || !/^\d{1,78}$/.test(jobId)) return bad("jobId must be a decimal number");
    query.jobId = jobId;
  }
  const r = view === "feed" ? await deskFeed(query, o) : await deskGet(view as DeskView, query, o);
  const cache = r.status === "online" ? "public, s-maxage=10, stale-while-revalidate=20" : "no-store";
  return Response.json(r, { headers: { "cache-control": cache } });
}
