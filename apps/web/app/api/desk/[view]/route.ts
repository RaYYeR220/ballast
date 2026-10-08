import { env } from "@/lib/server/context";
import { handleDesk } from "@/lib/server/handlers/desk";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ view: string }> }) {
  const { view } = await ctx.params;
  return handleDesk(req, view, { baseUrl: env().agentApiUrl });
}
