/* What GET /api/oracle returns, as the explorer reads it (bigints as decimal strings). Client-safe. */
import type { IdentityView } from "./identity";

export interface OracleSessionView {
  at: number;
  blockNumber: string;
  session: string;
  nextClose: number;
  nextOpen: number;
  window: { kind: string; startsAt: number; endsAt: number };
  current: { kind: string; closedAt: number; opensAt: number };
}

/** SessionAwareFeed.band(symbol): bounds in raw token USD (1e8). `ok` false: no anchor, the feed passes the price through. */
export type FeedBandView = { ok: boolean; lo: string; hi: string; bandBps: number } | { error: string };

export interface OracleSymbolView {
  symbol: string;
  at: number;
  session: string;
  /** USD per raw bStock token, 1e8 */
  rawPrice: string | null;
  /** USD per underlying share, 1e8 */
  perShare: string | null;
  reference: string | null;
  referenceUpdatedAt: number | null;
  converged: boolean;
  devBps: number;
  convergedReason: string;
  canAddRisk: boolean;
  reason: string;
  reasonText: string;
  windowAhead: { window: string; startsAt: number; endsAt: number; gapBps: number };
  currentWindow: { window: string; gapBps: number; closedAt: number };
  overlay: { validUntil: number; nextEarnings: number; flags: number; flagNames: string[]; ondoMultiplier: string; referencePrice: string; postedAt: number; fresh: boolean };
  params: { restoreDelay: number; horizon: number; convergenceBps: number; maxRefAge: number; maxOverlayTtl: number; maxOndoDriftBps: number; maxRefDeviationBps: number };
  band?: FeedBandView;
}

export type OracleSymbolRow = OracleSymbolView | { symbol: string; error: string };

export interface PublisherView {
  /** SessionOracle.publisher(); null when unreadable */
  address: string | null;
  /** SessionOracle.publisherAgentId() */
  agentId: string | null;
  /** the ERC-8004 registry's record for that id */
  identity: IdentityView | null;
  error?: string;
}

export type OracleView =
  | {
      status: "ok";
      chainId: number;
      blockNumber: string;
      at: number;
      session: OracleSessionView;
      symbols: OracleSymbolRow[];
      contracts?: { sessionOracle: string; sessionAwareFeed: string; calendar: string };
      publisher?: PublisherView;
    }
  | { status: "not-deployed"; detail: string }
  | { status: "unavailable"; detail: string };

export const isSymbolView = (r: OracleSymbolRow): r is OracleSymbolView => !("error" in r);

/** 1e8 fixed point to a number */
export const usd8 = (x: string | null | undefined): number | null => {
  if (x === null || x === undefined) return null;
  const n = Number(x) / 1e8;
  return Number.isFinite(n) ? n : null;
};

/** "NOT_REGULAR" to "not regular" */
export const reasonLabel = (r: string) => r.toLowerCase().replace(/_/g, " ");
