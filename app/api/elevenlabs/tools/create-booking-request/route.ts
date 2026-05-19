import { NextRequest, NextResponse } from "next/server";

import { createBookingRequestSchema, createElevenLabsBookingRequest } from "@/lib/elevenlabs/create-booking-request";
import { requireEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

function getBearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function error(reason: string) {
  return NextResponse.json({ ok: false, status: "error", reason });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const expectedToken = requireEnv("ELEVENLABS_TOOL_SECRET");
  const token = getBearerToken(request);

  if (!token || token !== expectedToken) {
    return jsonError("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("invalid_json_payload");
  }

  if (!isRecord(body)) {
    return error("invalid_request_body");
  }

  const parsed = createBookingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error("missing_required_field");
  }

  try {
    const result = await createElevenLabsBookingRequest(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Unexpected ElevenLabs create-booking-request tool error.", err);
    return error("unexpected_create_booking_request_error");
  }
}
