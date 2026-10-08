import { handleRwaStatus } from "@/lib/server/handlers/rwa";

export const runtime = "nodejs";
export const preferredRegion = "cdg1";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleRwaStatus();
}
