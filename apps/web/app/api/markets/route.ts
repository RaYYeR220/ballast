import { env, publicClient } from "@/lib/server/context";
import { handleMarkets } from "@/lib/server/handlers/reads";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET() {
  const e = env();
  return handleMarkets(e, publicClient(e));
}
