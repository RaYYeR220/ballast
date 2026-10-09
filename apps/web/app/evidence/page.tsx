import type { Metadata, Viewport } from "next";
import { Evidence } from "@/components/evidence/Evidence";
import { FACTS, pct } from "@/lib/liquidations";

export const metadata: Metadata = {
  title: "Evidence | Ballast",
  description: `Every liquidation of a tokenized stock on Lista Lending placed on the New York week: ${pct(FACTS.firstWindowShare)} of real borrowers' losses fell in the first 90 minutes after an open, ${FACTS.weekend} of ${FACTS.bStockCollateral} on a weekend. Method, caveats, the backtest and how to reproduce it.`,
};

export const viewport: Viewport = { themeColor: "#070f22" };

export default function EvidencePage() {
  return <Evidence />;
}
