import { deployment, env, publicClient } from "@/lib/server/context";
import { handleOracle } from "@/lib/server/handlers/oracle";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET() {
  const e = env();
  return handleOracle(deployment(e), publicClient(e));
}
