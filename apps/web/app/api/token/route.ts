import { env, publicClient } from "@/lib/server/context";
import { handleToken } from "@/lib/server/handlers/reads";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleToken(req, publicClient(env()));
}
