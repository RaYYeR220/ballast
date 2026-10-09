import { handleRwaStatus } from "@/lib/server/handlers/rwa";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(60);

export async function GET(req: Request) {
  const limited = limit.check(req);
  if (limited) return limited;
  return handleRwaStatus();
}
