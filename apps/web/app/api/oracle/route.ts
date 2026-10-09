import { deployment, env, publicClient } from "@/lib/server/context";
import { handleOracle } from "@/lib/server/handlers/oracle";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(60);

export async function GET(req: Request) {
  const limited = limit.check(req);
  if (limited) return limited;
  const e = env();
  return handleOracle(deployment(e), publicClient(e), req);
}
