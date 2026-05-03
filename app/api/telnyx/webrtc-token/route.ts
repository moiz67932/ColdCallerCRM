import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, getClientIp, jsonError } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { ensureTelnyxConfigured } from "@/lib/telnyx/call-flow";
import { createTelnyxWebRtcToken, ensureTelnyxConnectionWebhookConfigured } from "@/lib/telnyx/helpers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const ip = getClientIp(request);
  const rateLimit = consumeRateLimit(`telnyx-webrtc-token:${ip}`, {
    max: 60,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return jsonError("Too many WebRTC token requests in a short window", 429);
  }

  if (!ensureTelnyxConfigured()) {
    return jsonError("Telnyx configuration is incomplete. Check settings/environment.", 400);
  }

  try {
    await ensureTelnyxConnectionWebhookConfigured();
    const token = await createTelnyxWebRtcToken();
    return NextResponse.json({ token });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
