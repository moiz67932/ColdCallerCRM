import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { matchElevenLabsService, MatchServiceError, matchServiceRequestSchema } from "@/lib/elevenlabs/match-service";

export const runtime = "nodejs";

function getBearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export async function POST(request: NextRequest) {
  const expectedToken = requireEnv("ELEVENLABS_TOOL_SECRET");
  const token = getBearerToken(request);

  if (!token || token !== expectedToken) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const input = matchServiceRequestSchema.parse(body);
    const result = await matchElevenLabsService(input);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonError("Missing or invalid spoken_service.", 400);
    }

    if (error instanceof MatchServiceError) {
      return jsonError(error.message, error.status);
    }

    return jsonError("Unexpected match_service error.", 500);
  }
}
