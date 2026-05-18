import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  createAppointmentRequestSchema,
  createElevenLabsAppointmentRequest,
  CreateAppointmentRequestError,
} from "@/lib/elevenlabs/create-appointment-request";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

function getBearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function toolError(error: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error, message }, { status });
}

export async function POST(request: NextRequest) {
  const expectedToken = requireEnv("ELEVENLABS_TOOL_SECRET");
  const token = getBearerToken(request);

  if (!token || token !== expectedToken) {
    return toolError("unauthorized", "Unauthorized", 401);
  }

  try {
    const body = await request.json();
    const input = createAppointmentRequestSchema.parse(body);
    const result = await createElevenLabsAppointmentRequest(input);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return toolError("invalid_request", "Missing or invalid required appointment fields.", 400);
    }

    if (error instanceof CreateAppointmentRequestError) {
      return toolError(error.error, error.message, error.status);
    }

    console.error("Unexpected create_appointment_request error.", error);
    return toolError("unexpected_error", "Unexpected create_appointment_request error.", 500);
  }
}
