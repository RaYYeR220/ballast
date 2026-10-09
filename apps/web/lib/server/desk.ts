/* The desk agent for server components and route handlers: typed, validated reads of the five views the site
   uses. Every call goes through the same bounds as the /api/desk proxy (fixed paths, checked parameters, a
   timeout, a size cap per view) and returns an explicit offline state instead of throwing.

     const health = await desk.health();            // DeskResult<DeskHealth>
     const feed = await desk.feed({ account, kind: "refused", limit: 50 });
     const oracle = await desk.oracle();            // the desk's own oracle reading
     const ledger = await desk.ledger({ kind: "income" });
     const evidence = await desk.evidence(4152n);   // one guardian job's evidence file
*/
import {
  DESK_FEED_KINDS,
  DESK_FEED_SOURCES,
  DESK_LEDGER_KINDS,
  type DeskEvent,
  type DeskHealth,
  type DeskLedger,
  type DeskOffline,
  type DeskOracle,
  type DeskResult,
} from "@/lib/desk";
import { checksum } from "@/lib/app-config";
import { deskFeed, deskGet, deskHealth, type DeskFetchOptions } from "./agent";
import { env } from "./context";
import { LIMITS } from "./limits";

export type { DeskEvent, DeskHealth, DeskLedger, DeskOracle, DeskResult };

const refused = (detail: string): DeskOffline => ({ status: "offline", reason: "error", detail });
const limitOf = (n: number | undefined) => Math.max(1, Math.min(LIMITS.feedEvents, Math.floor(n ?? 100)));

export interface DeskFeedQuery {
  account?: string;
  kind?: (typeof DESK_FEED_KINDS)[number];
  source?: (typeof DESK_FEED_SOURCES)[number];
  /** 1 to 500, default 100 */
  limit?: number;
}

export function deskClient(o: DeskFetchOptions) {
  return {
    health: (): Promise<DeskResult<DeskHealth>> => deskHealth(o),

    async feed(q: DeskFeedQuery = {}): Promise<DeskResult<{ events: DeskEvent[] }>> {
      const account = q.account === undefined ? undefined : checksum(q.account);
      if (account === null) return refused("account must be a 0x address");
      if (q.kind !== undefined && !DESK_FEED_KINDS.includes(q.kind)) return refused("unknown feed kind");
      if (q.source !== undefined && !DESK_FEED_SOURCES.includes(q.source)) return refused("unknown feed source");
      return deskFeed({ ...(account ? { account } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.source ? { source: q.source } : {}), limit: limitOf(q.limit) }, o);
    },

    oracle: (): Promise<DeskResult<DeskOracle>> => deskGet<DeskOracle>("oracle", {}, o),

    async ledger(q: { kind?: (typeof DESK_LEDGER_KINDS)[number]; limit?: number } = {}): Promise<DeskResult<DeskLedger>> {
      if (q.kind !== undefined && !DESK_LEDGER_KINDS.includes(q.kind)) return refused("unknown ledger kind");
      return deskGet<DeskLedger>("ledger", { ...(q.kind ? { kind: q.kind } : {}), limit: limitOf(q.limit) }, o);
    },

    /** The evidence file the desk wrote for one guardian job (its deliverable hash commits to it). */
    async evidence(jobId: bigint | number | string): Promise<DeskResult<Record<string, unknown>>> {
      const id = String(jobId);
      if (!/^\d{1,30}$/.test(id)) return refused("jobId must be a decimal number");
      return deskGet<Record<string, unknown>>("evidence", { jobId: BigInt(id).toString() }, o);
    },
  };
}

/** The desk configured for this site (AGENT_API_URL), read per call so a changed environment needs no rebuild. */
export const desk = {
  health: () => deskClient({ baseUrl: env().agentApiUrl }).health(),
  feed: (q?: DeskFeedQuery) => deskClient({ baseUrl: env().agentApiUrl }).feed(q),
  oracle: () => deskClient({ baseUrl: env().agentApiUrl }).oracle(),
  ledger: (q?: { kind?: (typeof DESK_LEDGER_KINDS)[number]; limit?: number }) => deskClient({ baseUrl: env().agentApiUrl }).ledger(q),
  evidence: (jobId: bigint | number | string) => deskClient({ baseUrl: env().agentApiUrl }).evidence(jobId),
};
