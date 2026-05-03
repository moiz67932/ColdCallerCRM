import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, getClientIp, jsonError } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { canReceiveTelnyxVoiceWebhooks, createWebRtcCallAttempt, encodeClientState, ensureTelnyxConfigured } from "@/lib/telnyx/call-flow";
import { checkVoiceWebhookReachability, ensureTelnyxConnectionWebhookConfigured, getWebhookBaseUrlIssue } from "@/lib/telnyx/helpers";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const ip = getClientIp(request);
  const rateLimit = consumeRateLimit(`call-init:${ip}`, {
    max: 20,
    windowMs: 5 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return jsonError("Too many call attempts in a short window", 429);
  }

  if (!ensureTelnyxConfigured()) {
    return jsonError("Telnyx configuration is incomplete. Check settings/environment.", 400);
  }

  if (!canReceiveTelnyxVoiceWebhooks()) {
    return jsonError(getWebhookBaseUrlIssue() ?? "Telnyx webhooks are not reachable.", 400);
  }

  const webhookReachability = await checkVoiceWebhookReachability();

  if (!webhookReachability.reachable) {
    return jsonError(
      `Telnyx voice webhooks are currently unreachable (${webhookReachability.reason ?? "unknown reason"}). ` +
        "Restart your public tunnel (for example ngrok) and make sure APP_BASE_URL points to the active URL.",
      400,
    );
  }

  const { id } = await context.params;

  try {
    await ensureTelnyxConnectionWebhookConfigured();
    const { attempt, lead } = await createWebRtcCallAttempt(id);

    return NextResponse.json({
      attempt,
      callSession: {
        attemptId: attempt.id,
        clientState: encodeClientState({
          attemptId: attempt.id,
          role: "agent",
        }),
        callerNumber: env.TELNYX_FROM_NUMBER,
        destinationNumber: lead.phoneNumber,
      },
    });
  } catch (error) {
    const message = formatUnknownError(error);
    const status = message.includes("active call") ? 409 : 400;
    return jsonError(message, status);
  }
}
