import { env } from "@/lib/server/context";
import { handleDesk } from "@/lib/server/handlers/desk";
import { rateLimiter } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

const limit = rateLimiter(120);

export async function GET(req: Request, ctx: { params: Promise<{ view: string }> }) {
  const limited = limit.check(req);
  if (limited) return limited;
  const { view } = await ctx.params;
  return handleDesk(req, view, { baseUrl: env().agentApiUrl });
}
