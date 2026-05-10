import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireEnv } from "@/lib/env";
import { formatUnknownError, jsonError } from "@/lib/http";
import { resolveDemoContextRequestSchema, resolveElevenLabsDemoContext } from "@/lib/elevenlabs/resolve-demo-context";

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
    const input = resolveDemoContextRequestSchema.parse(body);
    const result = await resolveElevenLabsDemoContext(input);

    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonError("Invalid request body", 400);
    }

    return jsonError(formatUnknownError(error), 400);
  }
}
