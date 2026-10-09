import type { Metadata, Viewport } from "next";
import { AppRoot } from "@/components/app/AppRoot";
import type { AppConfig } from "@/lib/app-config";
import { deployment, env } from "@/lib/server/context";
import { deploymentInfo } from "@/lib/server/deployment";

export const metadata: Metadata = {
  title: "Your week | Ballast",
  description: "Your Ballast credit line on BNB Chain: health now and after the coming gap, the agent's shields and restores, and every refusal.",
};

export const viewport: Viewport = { themeColor: "#070f22" };

// the deployment and the environment are read per request, so a new deployment file needs no rebuild
export const dynamic = "force-dynamic";

export default function AppPage() {
  const e = env();
  const config: AppConfig = {
    chainId: e.chainId,
    deployment: deploymentInfo(deployment(e)),
    deskAgent: e.deskAgent,
    deskConfigured: e.agentApiUrl !== null,
    localRpcUrl: e.localRpcUrl,
  };
  return <AppRoot config={config} />;
}
