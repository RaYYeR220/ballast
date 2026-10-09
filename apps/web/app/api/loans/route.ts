import { env, publicClient } from "@/lib/server/context";
import { handleLoans } from "@/lib/server/handlers/reads";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(30);

export async function GET(req: Request) {
  const limited = limit.check(req);
  if (limited) return limited;
  const e = env();
  return handleLoans(req, e, publicClient(e));
}
