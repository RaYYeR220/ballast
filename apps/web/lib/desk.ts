/* The desk agent's read API as the web app sees it. The desk is optional: when it is not configured or
   cannot be reached, every view says so instead of showing anything made up. Safe for client bundles. */

export type DeskView = "health" | "feed" | "accounts" | "oracle" | "ledger" | "api-health" | "evidence";

export type DeskOffline = {
  status: "offline";
  /** not-configured: AGENT_API_URL is unset; unreachable: no answer; error: the desk answered with an error */
  reason: "not-configured" | "unreachable" | "error";
  detail: string;
};

export type DeskResult<T> = { status: "online"; data: T; fetchedAt: number } | DeskOffline;

export type DeskEventKind = "shield" | "restore" | "refused" | "alert" | "noop" | "pending" | "finding" | "publish" | (string & {});

export interface DeskError {
  name: string;
  message: string;
  args?: string[];
  reason?: string;
}

export interface DeskEvent {
  seq: number;
  /** unix seconds */
  ts: number;
  kind: DeskEventKind;
  source?: string;
  account?: string;
  cover?: { user: string; key: string };
  symbol?: string;
  /** tickers of a publisher event */
  symbols?: string[];
  window?: { kind: string; startsAt: number; endsAt: number; gapBps: number };
  plan?: Record<string, unknown>;
  sim?: { via: "binance" | "rpc"; ok: boolean; error?: DeskError; note?: string };
  txHash?: string;
  reason?: string;
  error?: DeskError;
  dryRun?: boolean;
  note?: string;
  data?: Record<string, unknown>;
}

export interface DeskHealth {
  ok?: boolean;
  chainId?: number;
  agent?: string;
  dryRun?: boolean;
  startedAt?: string;
  uptimeSec?: number;
  feedSeq?: number;
  notes?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function deskError(v: unknown): DeskError | undefined {
  if (!isObj(v) || typeof v.name !== "string") return undefined;
  return {
    name: v.name,
    message: str(v.message) ?? v.name,
    ...(Array.isArray(v.args) ? { args: v.args.map(String) } : {}),
    ...(str(v.reason) ? { reason: str(v.reason) } : {}),
  };
}

/** Keeps only well-formed events from a /feed answer ({ events } or a bare array), newest first. */
export function normalizeEvents(raw: unknown): DeskEvent[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
  const out: DeskEvent[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const ts = num(e.ts);
    const kind = str(e.kind);
    if (ts === undefined || !kind) continue;
    const sim = isObj(e.sim) && (e.sim.via === "binance" || e.sim.via === "rpc") ? e.sim : undefined;
    const win = isObj(e.window) && typeof e.window.startsAt === "number" ? e.window : undefined;
    out.push({
      seq: num(e.seq) ?? 0,
      ts,
      kind,
      source: str(e.source),
      account: str(e.account),
      cover: isObj(e.cover) && typeof e.cover.user === "string" ? { user: e.cover.user, key: String(e.cover.key ?? "") } : undefined,
      symbol: str(e.symbol),
      symbols: Array.isArray(e.symbols) ? e.symbols.filter((x): x is string => typeof x === "string") : undefined,
      window: win
        ? { kind: String(win.kind ?? ""), startsAt: Number(win.startsAt), endsAt: Number(win.endsAt ?? 0), gapBps: Number(win.gapBps ?? 0) }
        : undefined,
      plan: isObj(e.plan) ? e.plan : undefined,
      sim: sim ? { via: sim.via as "binance" | "rpc", ok: sim.ok === true, error: deskError(sim.error), note: str(sim.note) } : undefined,
      txHash: typeof e.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(e.txHash) ? e.txHash : undefined,
      reason: str(e.reason),
      error: deskError(e.error),
      dryRun: e.dryRun === true,
      note: str(e.note),
      data: isObj(e.data) ? e.data : undefined,
    });
  }
  return out.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
}

export const sameAddr = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
