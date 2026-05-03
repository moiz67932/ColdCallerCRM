import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";
import { computeAttemptSummary } from "@/lib/telnyx/call-flow";
import { getTelnyxClient } from "@/lib/telnyx/client";

const sendSmsSchema = z.object({
  text: z.string().min(1).max(1200),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  if (!env.TELNYX_MESSAGING_FROM_NUMBER) {
    return jsonError("Messaging is not configured. Set TELNYX_MESSAGING_FROM_NUMBER.", 400);
  }

  const { id } = await context.params;

  try {
    const payload = sendSmsSchema.parse(await request.json());

    const callAttempt = await prisma.callAttempt.findUnique({
      where: { id },
      include: { lead: true },
    });

    if (!callAttempt) {
      return jsonError("Call attempt not found", 404);
    }

    const queuedMessage = await prisma.smsMessage.create({
      data: {
        leadId: callAttempt.leadId,
        callAttemptId: callAttempt.id,
        direction: "outbound",
        fromNumber: env.TELNYX_MESSAGING_FROM_NUMBER,
        toNumber: callAttempt.lead.phoneNumber,
        text: payload.text,
        status: "queued",
      },
    });

    const client = getTelnyxClient();

    const response = await client.messages.send({
      from: env.TELNYX_MESSAGING_FROM_NUMBER,
      to: callAttempt.lead.phoneNumber,
      text: payload.text,
      webhook_url: env.APP_BASE_URL ? `${env.APP_BASE_URL.replace(/\/$/, "")}/api/webhooks/telnyx/messaging` : undefined,
    });

    const telnyxMessageId = response.data?.id;

    const message = await prisma.smsMessage.update({
      where: {
        id: queuedMessage.id,
      },
      data: {
        telnyxMessageId,
        status: "sent",
        rawPayloadJson: response as never,
      },
    });

    await computeAttemptSummary(callAttempt.id);

    return NextResponse.json({ message });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
