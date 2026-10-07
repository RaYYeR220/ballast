import { getAddress, hexToString, isHex, stringToHex, type Address, type Hex } from "viem";

/** Ticker symbol as the contracts store it: `bytes32(bytes("NVDA"))`. A bytes32 hex passes through. */
export function symbolToBytes32(symbol: string): Hex {
  if (isHex(symbol) && symbol.length === 66) return symbol;
  if (symbol.length === 0) throw new Error("empty symbol");
  return stringToHex(symbol, { size: 32 });
}

export function bytes32ToSymbol(b: Hex): string {
  return hexToString(b, { size: 32 });
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

/** Implementation behind an EIP-1167 minimal proxy, or null if `code` is not one. */
export function cloneImplementation(code: Hex | undefined): Address | null {
  const m = code ? CLONE.exec(code) : null;
  return m?.[1] ? getAddress(`0x${m[1]}`) : null;
}

type ErrorLike = { name?: unknown; cause?: unknown };

/** Visits `err` and its `cause` chain. Matching is by class name so errors from another viem copy count. */
export function findInChain(err: unknown, pred: (e: ErrorLike & Record<string, unknown>) => boolean) {
  let e: unknown = err;
  for (let i = 0; i < 20 && e && typeof e === "object"; i++) {
    if (pred(e as ErrorLike & Record<string, unknown>)) return e as ErrorLike & Record<string, unknown>;
    e = (e as ErrorLike).cause;
  }
  return undefined;
}

const REVERT_ERRORS = new Set(["ContractFunctionRevertedError", "ExecutionRevertedError"]);

/** True if a contract call failed because the contract reverted (not because the RPC failed). */
export function isRevert(err: unknown): boolean {
  return findInChain(err, (e) => typeof e.name === "string" && REVERT_ERRORS.has(e.name)) !== undefined;
}

/** Runs a read and maps a revert to null. Transport and decoding failures still throw. */
export async function orNullOnRevert<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isRevert(err)) return null;
    throw err;
  }
}
