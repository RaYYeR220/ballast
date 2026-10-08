/* The desk agent's read API (AGENT_API_URL). Answers are cached for 15 s by Next's fetch cache. When the URL
   is unset, the desk does not answer, or answers with an error, the result is an explicit offline state. */
import { normalizeEvents, type DeskEvent, type DeskResult, type DeskView } from "@/lib/desk";
import { readCapped, TooLargeError } from "./guard";
import { LIMITS } from "./limits";

export const DESK_REVALIDATE_SEC = 15;

const PATHS: Record<Exclude<DeskView, "evidence">, string> = {
  health: "/health",
  feed: "/feed",
  accounts: "/accounts",
  oracle: "/oracle",
  ledger: "/ledger",
  "api-health": "/api-health",
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

export async function deskGet<T = unknown>(view: DeskView, q: DeskQuery, o: DeskFetchOptions): Promise<DeskResult<T>> {
  if (!o.baseUrl) return { status: "offline", reason: "not-configured", detail: "the desk agent is not configured (AGENT_API_URL is unset)" };
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
    body = JSON.parse(await readCapped(res, LIMITS.deskAnswerBytes));
  } catch (err) {
    if (err instanceof TooLargeError) return { status: "offline", reason: "error", detail: "the desk's answer was too large to read" };
    return { status: "offline", reason: "error", detail: `the desk answered ${res.status} without JSON` };
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
    return { status: "offline", reason: "error", detail: `the desk answered ${res.status}${msg ? `: ${msg}` : ""}` };
  }
  return { status: "online", data: body as T, fetchedAt: Math.floor(Date.now() / 1000) };
}

/** /feed with its events checked and sorted newest first. */
export async function deskFeed(q: DeskQuery, o: DeskFetchOptions): Promise<DeskResult<{ events: DeskEvent[] }>> {
  const r = await deskGet<unknown>("feed", q, o);
  // whatever the desk sends, at most LIMITS.feedEvents events are kept
  return r.status === "online" ? { ...r, data: { events: normalizeEvents(r.data).slice(0, LIMITS.feedEvents) } } : r;
}
