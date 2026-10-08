/* The owner's mandate: defaults sized to the market's liquidation LTV, the contract's bounds, and one line on
   what each setting does. The contract checks the same bounds (BadMandate); checking here saves a refusal. */
import type { Mandate } from "@ballast/sdk";

export const MANDATE_HELP = {
  maxLtvBps: "The ceiling for a restore: the agent can never borrow the loan back above it. Above it, a collateral sale needs no closure ahead.",
  shieldLtvBps: "The floor for a collateral sale: the agent may sell only above this level and never lands more than 1% below it.",
  maxSlippageBps: "The worst price the agent may accept on a collateral sale, measured against the venue's oracle price.",
  autoRestore: "After the market reopens and prices settle, the agent may borrow back toward the day size. A collateral sale switches this off until you set it again.",
} as const;

const floorTo = (x: number, step: number) => Math.floor(x / step) * step;

/** 80% and 60% of the liquidation LTV, in whole percent: 75% -> max 60%, shield 45%. 1% slippage, auto-restore on. */
export function defaultMandate(lltvBps: number): Mandate {
  const maxLtvBps = Math.min(9000, floorTo(lltvBps * 0.8, 100));
  const shieldLtvBps = Math.max(100, floorTo(lltvBps * 0.6, 100));
  return { maxLtvBps, shieldLtvBps: Math.min(shieldLtvBps, maxLtvBps - 100), maxSlippageBps: 100, autoRestore: true };
}

/** Problems the contract would refuse with BadMandate, in plain words. Empty when the mandate is valid. */
export function mandateProblems(m: Mandate, lltvBps: number | null, venue: "lista" | "venus"): string[] {
  const out: string[] = [];
  const int = (x: number) => Number.isInteger(x);
  if (!int(m.maxLtvBps) || m.maxLtvBps <= 0 || m.maxLtvBps > 9000) out.push("Max LTV must be above 0% and at most 90%.");
  if (venue === "lista" && lltvBps !== null && m.maxLtvBps >= lltvBps) out.push(`Max LTV must stay below the market's liquidation LTV of ${(lltvBps / 100).toFixed(0)}%.`);
  if (!int(m.shieldLtvBps) || m.shieldLtvBps <= 0 || m.shieldLtvBps >= m.maxLtvBps) out.push("Shield LTV must be above 0% and below max LTV.");
  if (!int(m.maxSlippageBps) || m.maxSlippageBps < 0 || m.maxSlippageBps > 500) out.push("Slippage must be between 0% and 5%.");
  return out;
}

/** "45" (percent text) -> 4500 bps; NaN for anything that is not a number. */
export const pctToBps = (s: string) => {
  const v = s.trim();
  return /^\d{1,3}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : Number.NaN;
};
