import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, getClientIp, jsonError } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { logError, logInfo } from "@/lib/logger";
import {
  canReceiveTelnyxVoiceWebhooks,
  createOutboundCallAttempt,
  ensureTelnyxConfigured,
  initiateOutboundCall,
  isBrowserFirstManualDialFlow,
} from "@/lib/telnyx/call-flow";
import {
  checkVoiceWebhookReachability,
  getTelnyxErrorDiagnostics,
  getOutboundCallerId,
  getWebhookBaseUrlIssue,
} from "@/lib/telnyx/helpers";
import { prisma } from "@/lib/workstation-db";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = request.headers.get("x-vercel-id") ?? randomUUID();
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
  const payload = (await request.json().catch(() => ({}))) as {
    action?: "create_attempt" | "start_pstn";
    attemptId?: string;
    webrtcReady?: boolean;
  };
  const manualDialFlow = isBrowserFirstManualDialFlow() ? "browser_first" : "pstn_first";

  try {
    logInfo("Handling lead call bootstrap request", {
      requestId,
      ip,
      leadId: id,
      action: payload.action ?? "create_attempt",
      activeAttemptId: payload.attemptId ?? null,
      manualDialFlow,
    });

    if (payload.action === "start_pstn") {
      if (manualDialFlow === "browser_first") {
        return jsonError("PSTN-first start is disabled while TELNYX_MANUAL_DIAL_FLOW=browser_first.", 409);
      }

      if (!payload.attemptId || !payload.webrtcReady) {
        return jsonError("Browser softphone was not ready.", 400);
      }

      const existingAttempt = await prisma.callAttempt.findUnique({
        where: { id: payload.attemptId },
        include: { lead: true },
      });

      if (!existingAttempt || existingAttempt.leadId !== id) {
        return jsonError("Call attempt not found for this lead.", 404);
      }

      logInfo("Browser WebRTC ready confirmed; starting PSTN dial", {
        requestId,
        ip,
        leadId: id,
        activeAttemptId: existingAttempt.id,
        telnyxReadyForAttempt: true,
      });

      const attempt = await initiateOutboundCall(existingAttempt.id);

      logInfo("Created and initiated outbound Telnyx call", {
        requestId,
        ip,
        leadId: id,
        attemptId: attempt.id,
        callControlId: attempt.telnyxCallControlId,
      });

      return NextResponse.json({
        attempt,
        lead: existingAttempt.lead,
        manualDialFlow,
        callerNumber: getOutboundCallerId(),
      });
    }

    const { attempt, lead } = await createOutboundCallAttempt(id);

    logInfo("Created outbound call attempt awaiting browser WebRTC readiness", {
      requestId,
      ip,
      leadId: id,
      attemptId: attempt.id,
      activeAttemptId: attempt.id,
      manualDialFlow,
    });

    return NextResponse.json({
      attempt,
      lead,
      manualDialFlow,
      callerNumber: getOutboundCallerId(),
    });
  } catch (error) {
    const message = formatUnknownError(error);
    const status = message.includes("active call") ? 409 : 400;

    logError("Lead call bootstrap request failed", {
      requestId,
      ip,
      leadId: id,
      status,
      ...getTelnyxErrorDiagnostics(error),
    });

    return jsonError(message, status);
  }
}
