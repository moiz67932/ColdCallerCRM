import { NextRequest, NextResponse } from "next/server";

import { buildElevenLabsConversationInitiationClientData } from "@/lib/elevenlabs/conversation-initiation";
import { hasValidElevenLabsToolBearerAuth } from "@/lib/elevenlabs/tool-auth";
import { requireEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const expectedToken = requireEnv("ELEVENLABS_TOOL_SECRET");

  if (!hasValidElevenLabsToolBearerAuth(request.headers, expectedToken)) {
    return jsonError("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const result = await buildElevenLabsConversationInitiationClientData(body);
  return NextResponse.json(result);
}
