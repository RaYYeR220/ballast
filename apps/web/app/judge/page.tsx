import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata, Viewport } from "next";
import { ReplayPage } from "@/components/judge/Replay";
import { parseProofs, parseReplay, type Proofs } from "@/lib/replay";
import cycle from "@/public/replay/cycle.json";

export const metadata: Metadata = {
  title: "Replay | Ballast",
  description:
    "One full Ballast cycle recorded on a fork of BNB Chain and played back on the week wheel: a loan shielded before the close, a restore refused while New York is closed, the restore after the open, and a guardian job settled. No wallet, no keys.",
};

export const viewport: Viewport = { themeColor: "#070f22" };

// built once: the recording is a file in the repository, and so are the BNB Chain transactions that match it
export const dynamic = "force-static";

/** data/proof-txs.json, read when the page is built. A missing or broken file is no proofs, never an error. */
function loadProofs(): Proofs {
  try {
    return parseProofs(JSON.parse(readFileSync(path.resolve(process.cwd(), "..", "..", "data", "proof-txs.json"), "utf8")));
  } catch {
    return {};
  }
}

export default function JudgePage() {
  return <ReplayPage replay={parseReplay(cycle)} proofs={loadProofs()} serverNow={Math.floor(Date.now() / 1000)} />;
}
