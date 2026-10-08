import { formatUnits, parseUnits } from "viem";

const PLAIN = /^\d+(\.\d*)?$|^\.\d+$/;
/** 1,500 or 12,345,678.25: commas only between groups of exactly three digits */
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d*)?$/;
/** 1,5 or 0,25: one comma as the decimal separator (no dot anywhere) */
const COMMA_DECIMAL = /^\d+,\d{1,18}$/;

/**
 * The decimal text an amount input stands for, or null when it is not an amount.
 * - "1500.25": as written.
 * - "1,500" / "1,500.25": commas are thousands separators only in strict groups of three.
 * - "1,5": otherwise a single comma (and no dot) is the decimal separator, as typed on many keyboards.
 * - anything else ("1.500,25", "1,5,0", "1e3") is refused, never guessed.
 */
export function normalizeAmount(input: string): string | null {
  const v = input.trim().replace(/\s+/g, "");
  if (v === "") return null;
  if (PLAIN.test(v)) return v;
  if (GROUPED.test(v)) return v.replace(/,/g, "");
  if (COMMA_DECIMAL.test(v)) return v.replace(",", ".");
  return null;
}

/** "120.5" -> token units; null for anything that is not a positive amount with at most `decimals` fraction digits. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const v = normalizeAmount(input);
  if (v === null) return null;
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    const x = parseUnits(v, decimals);
    return x > 0n ? x : null;
  } catch {
    return null;
  }
}

/** Token units written back without ambiguity: "1,500.25" (comma groups, dot decimal, no rounding). */
export function exactAmount(x: bigint, decimals: number): string {
  const [whole, frac] = formatUnits(x, decimals).split(".") as [string, string | undefined];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}
