import { serverKeyAvailability } from "@/lib/server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reports which providers have a server-side key available (booleans only), so
 * the client can show "server key active" and route plain chat without the user
 * pasting a key. Everything is false on a bare deployment until env keys are set.
 */
export async function GET() {
  return Response.json(serverKeyAvailability());
}
