/* The desk agent's read API. Answers are cached for 15 s by Next's fetch cache. When no desk is set for this
   site, the desk does not answer, or it answers with an error, the result is an explicit offline state.
   Only the views in PATHS are ever requested, each read up to its own size cap. */
import { normalizeEvents, type DeskEvent, type DeskHealth, type DeskResult, type DeskView } from "@/lib/desk";
import { readCapped, TooLargeError } from "./guard";
import { LIMITS } from "./limits";

export const DESK_REVALIDATE_SEC = 15;

const PATHS: Record<Exclude<DeskView, "evidence">, string> = {
  health: "/health",
  feed: "/feed",
  oracle: "/oracle",
  ledger: "/ledger",
};

export interface DeskQuery {
  account?: string;
  limit?: number;
  kind?: string;
  source?: string;
  jobId?: string;
}

export interface DeskFetchOptions {
  baseUrl: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  revalidateSec?: number;
}

export function deskPath(view: DeskView, q: DeskQuery = {}): string {
  if (view === "evidence") return `/evidence/${encodeURIComponent(q.jobId ?? "")}`;
  const params = new URLSearchParams();
  if (q.account) params.set("account", q.account);
  if (q.kind) params.set("kind", q.kind);
  if (q.source) params.set("source", q.source);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const s = params.toString();
  return `${PATHS[view]}${s ? `?${s}` : ""}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function deskGet<T = unknown>(view: DeskView, q: DeskQuery, o: DeskFetchOptions): Promise<DeskResult<T>> {
  if (!o.baseUrl) return { status: "offline", reason: "not-configured", detail: "no desk agent is set up for this site" };
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.baseUrl}${deskPath(view, q)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? LIMITS.deskTimeoutMs),
      next: { revalidate: o.revalidateSec ?? DESK_REVALIDATE_SEC },
    } as RequestInit);
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { status: "offline", reason: "unreachable", detail: timedOut ? "the desk did not answer in time" : "the desk could not be reached" };
  }
  let body: unknown;
  try {
    body = JSON.parse(await readCapped(res, LIMITS.deskAnswerBytes[view]));
  } catch (err) {
    if (err instanceof TooLargeError) return { status: "offline", reason: "error", detail: "the desk's answer was too large to read" };
    return { status: "offline", reason: "error", detail: `the desk answered ${res.status} without JSON` };
  }
  // a halted desk answers /health with 503 and its state: it is reachable, and the page should say it is halted
  const halted = view === "health" && res.status === 503 && isObj(body) && body.ok === false;
  if (!res.ok && !halted) {
    const msg = isObj(body) && typeof body.error === "string" ? body.error.slice(0, 200) : "";
    return { status: "offline", reason: "error", detail: `the desk answered ${res.status}${msg ? `: ${msg}` : ""}` };
  }
  if (!isObj(body)) return { status: "offline", reason: "error", detail: "the desk's answer was not a JSON object" };
  return { status: "online", data: body as T, fetchedAt: Math.floor(Date.now() / 1000) };
}

/** /feed with its events checked and sorted newest first. */
export async function deskFeed(q: DeskQuery, o: DeskFetchOptions): Promise<DeskResult<{ events: DeskEvent[] }>> {
  const r = await deskGet<unknown>("feed", q, o);
  // whatever the desk sends, at most LIMITS.feedEvents events are kept
  return r.status === "online" ? { ...r, data: { events: normalizeEvents(r.data).slice(0, LIMITS.feedEvents) } } : r;
}

/** /health reduced to the fields the app shows (no loop internals or transaction hashes in flight). */
export async function deskHealth(o: DeskFetchOptions): Promise<DeskResult<DeskHealth>> {
  const r = await deskGet<Record<string, unknown>>("health", {}, o);
  if (r.status !== "online") return r;
  const d = r.data;
  const sender = isObj(d.sender) ? d.sender : null;
  const halted = sender && isObj(sender.halted) ? sender.halted : null;
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
  const numb = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    ...r,
    data: {
      ok: d.ok !== false,
      chainId: numb(d.chainId),
      agent: text(d.agent),
      dryRun: d.dryRun === true,
      startedAt: text(d.startedAt),
      uptimeSec: numb(d.uptimeSec),
      feedSeq: numb(d.feedSeq),
      notes: text(d.notes),
      sender: sender
        ? {
            sales: text(sender.sales),
            halted: halted ? { reason: text(halted.reason), message: text(halted.message), nonce: numb(halted.nonce), since: numb(halted.since) } : null,
            feeSpentLastHourBnb: text(sender.feeSpentLastHourBnb),
          }
        : null,
    },
  };
}
