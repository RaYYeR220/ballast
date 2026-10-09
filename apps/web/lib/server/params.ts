/* Query parameters of the app's routes: each one is checked for shape and length before anything is read. */
import { getAddress, isAddress, type Address } from "viem";
import { LIMITS } from "./limits";

const NO_STORE = { "cache-control": "no-store" };

export const badRequest = (error: string, status = 400) => Response.json({ error }, { status, headers: NO_STORE });

/** Ticker or token symbol as the contracts store it (a bytes32 string): at most 31 characters. */
export const SYMBOL = /^[A-Za-z0-9._-]{1,31}$/;

/** The request's query, or a 414 answer when it is longer than any valid query of this app. */
export function query(req: Request): URLSearchParams | Response {
  const url = new URL(req.url);
  if (url.search.length > LIMITS.queryChars) return badRequest("query too long", 414);
  return url.searchParams;
}

/** A required 0x address, checksummed. */
export function addressParam(q: URLSearchParams, name: string): Address | Response {
  const v = q.get(name);
  if (!v || v.length !== 42 || !isAddress(v, { strict: false })) return badRequest(`${name} must be a 0x address`);
  return getAddress(v);
}

/** An optional 0x address: null when absent. */
export function optionalAddress(q: URLSearchParams, name: string): Address | null | Response {
  return q.get(name) === null || q.get(name) === "" ? null : addressParam(q, name);
}

/** An optional symbol: null when absent. */
export function symbolParam(q: URLSearchParams, name: string): string | null | Response {
  const v = q.get(name);
  if (v === null || v === "") return null;
  return SYMBOL.test(v) ? v : badRequest(`${name} must be 1 to 31 letters, digits, dots, dashes or underscores`);
}

/** An optional whole number in [min, max]: `fallback` when absent, a 400 answer outside the range (never clamped silently into a loop bound). */
export function intParam(q: URLSearchParams, name: string, o: { min: number; max: number; fallback: number }): number | Response {
  const v = q.get(name);
  if (v === null || v === "") return o.fallback;
  if (!/^\d{1,9}$/.test(v)) return badRequest(`${name} must be a whole number`);
  const n = Number(v);
  if (n < o.min || n > o.max) return badRequest(`${name} must be between ${o.min} and ${o.max}`);
  return n;
}
