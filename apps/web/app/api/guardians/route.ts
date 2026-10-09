import { bscExternal } from "@ballast/sdk";
import { deployment, env, publicClient } from "@/lib/server/context";
import { handleGuardians } from "@/lib/server/handlers/guardians";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(60);

export async function GET(req: Request) {
  const limited = limit.check(req);
  if (limited) return limited;
  const e = env();
  return handleGuardians(deployment(e), publicClient(e), bscExternal());
}
