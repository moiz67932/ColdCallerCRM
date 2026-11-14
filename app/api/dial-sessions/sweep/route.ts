import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { sweepExpiredSessions } from "@/lib/dialer/service";
import { drainParallelCommands, tickParallelSessions } from "@/lib/dialer/parallel-worker";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const expected = env.DIALER_WATCHDOG_SECRET;
  const received = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || expected.length < 32 || Buffer.byteLength(expected) !== Buffer.byteLength(received) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.nextUrl.searchParams.has("commands")) await drainParallelCommands();
  else { await sweepExpiredSessions(); await tickParallelSessions(); }
  return NextResponse.json({ swept: true });
}
