import { decodeErrorResult, isHex, slice, type Hex } from "viem";
import { ballastErrorsAbi } from "./abi";
import { REASON_TEXT, reasonName, type ReasonName } from "./enums";
import { bytes32ToSymbol, findInChain } from "./util";

export interface BallastError {
  name: string;
  selector: Hex;
  args: readonly unknown[];
  /** One readable sentence for logs, feeds and UIs. */
  message: string;
  /** Decoded oracle reason for RestoreRefused ("UNKNOWN(n)" for a value this SDK does not know). */
  reason?: ReasonName | `UNKNOWN(${number})`;
}

/** Reason name that never throws, for decoding reverts from contracts newer than this SDK. */
function safeReason(v: unknown): ReasonName | `UNKNOWN(${number})` {
  try {
    return reasonName(Number(v));
  } catch {
    return `UNKNOWN(${Number(v)})`;
  }
}

const pct = (bps: unknown) => `${(Number(bps) / 100).toFixed(2)}%`;

const MESSAGES: Record<string, (a: readonly unknown[]) => string> = {
  // accounts
  RestoreRefused: (a) => {
    const r = safeReason(a[0]);
    return `restore refused by the Session Oracle: ${r}${r in REASON_TEXT ? ` (${REASON_TEXT[r as ReasonName]})` : ""}`;
  },
  ExceedsMandate: (a) => `LTV would be ${pct(a[0])}, above the owner's cap of ${pct(a[1])}`,
  NotInShieldWindow: () => "deleverage is only allowed close to a market closure, or while LTV is above the owner's cap",
  KeeperRestoreDisabled: () => "the owner has disabled keeper restores",
  InsufficientCushion: (a) => `the cushion holds ${a[0]} but the action needs ${a[1]}`,
  BelowMinLoan: (a) => `the remaining debt ${a[0]} would be below the venue minimum loan ${a[1]}`,
  BelowShieldLtv: (a) => `LTV ${pct(a[0])} is at or below the shield LTV ${pct(a[1])}, nothing to deleverage`,
  OverDeleverage: (a) => `deleverage would land at ${pct(a[0])}, more than 1% below ${pct(a[1])}`,
  DeleverageDisabled: () => "the owner has not set a deleverage swap path",
  BadPath: () => "the swap path does not match the one the owner fixed",
  RiskNotReduced: () => "the action did not reduce the position's risk",
  NotOwner: () => "only the account owner may do this",
  NotKeeper: () => "only the keeper or the owner may do this",
  NotLiquidated: () => "no liquidation to record",
  NoDebt: () => "the user has no debt to repay",
  BadMandate: () => "the mandate is out of bounds",
  BadMarket: () => "the market does not match the symbol or venue",
  Locked: () => "the account is busy (reentrancy lock)",
  Unauthorized: () => "unauthorized callback",
  Unsupported: () => "not supported for this account",
  VenusError: (a) => `Venus returned error code ${a[0]}`,
  // vault
  NoCover: () => "no cover is open for this user and key",
  NotCoverKeeper: () => "only the cover's keeper may shield it",
  OutsideShieldWindow: () => "the vault only shields during a closure or shortly before one",
  OverDailyCap: (a) => `the daily cap is used up (${a[0]} of ${a[1]})`,
  InsufficientCover: (a) => `the cover holds ${a[0]} but ${a[1]} was requested`,
  HorizonTooLong: () => "the shield horizon is longer than one day",
  // oracle
  NotPublisher: () => "only the overlay publisher may post",
  UnknownTicker: (a) => `ticker ${bytes32ToSymbol(a[0] as Hex)} is not listed`,
  BadValidity: () => "overlay validity is in the past or beyond the maximum TTL",
  LengthMismatch: () => "symbols and overlays differ in length",
  OndoMultiplierOutOfBounds: (a) => `Ondo multiplier ${a[0]} is outside the allowed drift from the on-chain ${a[1]}`,
  ReferenceNotAllowed: () => "a reference price is only accepted in the regular session for tickers without Chainlink",
  ReferenceOutOfBounds: (a) => `reference ${a[0]} deviates too far from the per-share price ${a[1]}`,
  BadTicker: () => "invalid ticker configuration",
  BadParams: () => "oracle parameters out of bounds",
  // guardian
  OnlyKernel: () => "only the ERC-8183 kernel may call the hook",
  BadTerms: () => "guard terms are invalid for this job",
  NotAccountOwner: () => "the job client does not own the account",
  ProviderNotAgent: () => "the provider is not the ERC-8004 agent named in the terms",
  BudgetTooLow: () => "the job budget is below the guardian minimum",
  WindowNotOver: () => "the guarded window has not ended yet",
  CannotEvaluateNow: () => "account health cannot be read right now, retry later",
  NotSettleable: () => "the job is not bound, already settled, or not submitted",
  InsufficientGasForFeedback: () => "not enough gas left to write reputation feedback",
};

/** Hex revert data from a hex string or anywhere in a viem error chain. */
function revertData(input: unknown): Hex | undefined {
  if (typeof input === "string") return isHex(input) ? input : undefined;
  const hit = findInChain(input, (e) => {
    if (isHex(e.raw)) return true;
    if (isHex(e.data)) return true;
    const inner = e.data as { data?: unknown } | undefined;
    return !!inner && typeof inner === "object" && isHex(inner.data);
  });
  if (!hit) return undefined;
  if (isHex(hit.raw)) return hit.raw;
  if (isHex(hit.data)) return hit.data;
  return (hit.data as { data: Hex }).data;
}

/**
 * Decodes a Ballast revert into a readable error. Accepts raw revert data or a viem error.
 * Returns null when there is no revert data at all. Never throws.
 */
export function decodeBallastError(input: unknown): BallastError | null {
  try {
    return decode(input);
  } catch {
    return null; // malformed input: nothing decodable
  }
}

function decode(input: unknown): BallastError | null {
  const data = revertData(input);
  if (!data || data.length < 10) return null;
  const selector = slice(data, 0, 4);
  let name: string;
  let args: readonly unknown[];
  try {
    const r = decodeErrorResult({ abi: ballastErrorsAbi, data });
    name = r.errorName;
    args = (r.args ?? []) as readonly unknown[];
  } catch {
    return { name: "UnknownError", selector, args: [], message: `reverted with unknown error ${selector}` };
  }
  const generic = `${name}(${args.map(String).join(", ")})`;
  let message: string;
  try {
    if (name === "Error") message = String(args[0]);
    else if (name === "Panic") message = `panic 0x${BigInt(args[0] as bigint).toString(16)}`;
    else message = MESSAGES[name]?.(args) ?? generic;
  } catch {
    message = generic;
  }
  const out: BallastError = { name, selector, args, message };
  if (name === "RestoreRefused") out.reason = safeReason(args[0]);
  return out;
}
