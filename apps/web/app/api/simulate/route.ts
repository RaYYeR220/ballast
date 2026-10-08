import { deployment, env, publicClient } from "@/lib/server/context";
import { handleSimulate, simulateDeps, simulateGuard } from "@/lib/server/handlers/simulate";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(40);

export async function POST(req: Request) {
  const limited = limit.check(req);
  if (limited) return limited;
  const e = env();
  const client = publicClient(e);
  const d = deployment(e);
  const guard = simulateGuard({ chainId: e.chainId, deployment: d.ok ? d.deployment : null, client, ticketSecret: e.binance?.apiSecret ?? null });
  return handleSimulate(req, simulateDeps(e, client), guard);
}
