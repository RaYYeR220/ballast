import { bscExternal } from "@ballast/sdk";
import type { Metadata, Viewport } from "next";
import { GuardianBoard } from "@/components/guardians/GuardianBoard";
import type { AppConfig } from "@/lib/app-config";
import type { GuardiansBody } from "@/lib/guardians";
import { deployment, env, publicClient } from "@/lib/server/context";
import { deploymentInfo } from "@/lib/server/deployment";
import { withDeadline } from "@/lib/server/guard";
import { handleGuardians } from "@/lib/server/handlers/guardians";

export const metadata: Metadata = {
  title: "Guardians | Ballast",
  description: "Guardian jobs on BNB Chain: agents with an ERC-8004 identity keep a loan alive through a closed window and are paid from ERC-8183 escrow only if it survives.",
};

export const viewport: Viewport = { themeColor: "#070f22" };

export const dynamic = "force-dynamic";
export const preferredRegion = "cdg1";

/** How long the page waits for its first answer before it lets the browser fetch it instead. */
const FIRST_PAINT_MS = 3500;

export default async function GuardiansPage() {
  const e = env();
  const d = deployment(e);
  const config: AppConfig = { chainId: e.chainId, deployment: deploymentInfo(d), deskAgent: e.deskAgent, deskConfigured: e.agentApiUrl !== null, localRpcUrl: e.localRpcUrl };
  let initial: GuardiansBody | null = null;
  try {
    const res = await withDeadline(handleGuardians(d, publicClient(e), bscExternal()), FIRST_PAINT_MS);
    if (res.ok) initial = (await res.json()) as GuardiansBody;
  } catch {
    initial = null;
  }
  return <GuardianBoard initial={initial} serverNow={Math.floor(Date.now() / 1000)} config={config} />;
}
