import { deployment, env, publicClient } from "@/lib/server/context";
import { handleAccounts } from "@/lib/server/handlers/reads";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const e = env();
  return handleAccounts(req, deployment(e), publicClient(e));
}
