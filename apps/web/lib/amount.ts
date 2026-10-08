import { parseUnits } from "viem";

/** "120.5" -> token units; null for anything that is not a positive amount with at most `decimals` fraction digits. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const v = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(v) || v === "" || v === ".") return null;
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    const x = parseUnits(v, decimals);
    return x > 0n ? x : null;
  } catch {
    return null;
  }
}
