import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { logError } from "@/lib/logger";
import { getSmsTemplateName, normalizeAndValidateSmsNumber } from "@/lib/messaging/sms";
import { sanitizeUserText } from "@/lib/sanitize";
import { getTelnyxClient } from "@/lib/telnyx/client";
import { prisma } from "@/lib/workstation-db";

export const runtime = "nodejs";

const sendSmsSchema = z.object({
  leadId: z.string().min(1).optional(),
  to: z.string().min(1),
  body: z.string().min(1).max(1600),
  templateKey: z.string().min(1).optional(),
  consentSource: z.literal("verbal_phone_call"),
  consentNote: z.string().max(500).optional(),
});

function getConfiguredFromNumber() {
  return env.TELNYX_SMS_FROM_NUMBER ?? env.TELNYX_MESSAGING_FROM_NUMBER ?? null;
}

function getTelnyxErrorDetails(error: unknown) {
  const fallback = {
    code: "TELNYX_SEND_FAILED",
    message: "Telnyx could not send the SMS. Check the number and messaging profile configuration.",
  };

  if (!error || typeof error !== "object") {
    return fallback;
  }

  const errorRecord = error as {
    message?: unknown;
    errors?: Array<{ code?: unknown; title?: unknown; detail?: unknown }>;
  };
  const firstError = Array.isArray(errorRecord.errors) ? errorRecord.errors[0] : undefined;
  const code = typeof firstError?.code === "string" ? firstError.code : fallback.code;
  const message =
    typeof firstError?.title === "string"
      ? firstError.title
      : typeof firstError?.detail === "string"
        ? firstError.detail
        : typeof errorRecord.message === "string"
          ? errorRecord.message
          : fallback.message;

  return { code, message };
}

function getMessageStatus(data: { to?: Array<{ status?: string }>; status?: string } | undefined) {
  return data?.to?.[0]?.status ?? data?.status ?? "queued";
}

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const fromNumber = getConfiguredFromNumber();

  if (!fromNumber) {
    return jsonError("Messaging is not configured. Set TELNYX_SMS_FROM_NUMBER.", 400);
  }

  if (!env.TELNYX_API_KEY) {
    return jsonError("Messaging is not configured. Set TELNYX_API_KEY.", 400);
  }

  let queuedMessageId: string | null = null;

  try {
    const payload = sendSmsSchema.parse(await request.json());
    const normalizedTo = normalizeAndValidateSmsNumber(payload.to, "US");

    if (!normalizedTo.ok) {
      return jsonError(normalizedTo.error, 400);
    }

    const sanitizedBody = sanitizeUserText(payload.body);

    if (!sanitizedBody) {
      return jsonError("Enter a message before sending.", 400);
    }

    const lead = payload.leadId
      ? await prisma.lead.findUnique({
          where: { id: payload.leadId },
          include: {
            callAttempts: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        })
      : null;

    if (payload.leadId && !lead) {
      return jsonError("Lead not found.", 404);
    }

    const latestAttempt = Array.isArray(lead?.callAttempts) ? lead.callAttempts[0] : null;
    const queuedMessage = await prisma.smsMessage.create({
      data: {
        leadId: payload.leadId ?? null,
        callAttemptId: latestAttempt?.id ?? null,
        direction: "outbound",
        fromNumber,
        toNumber: normalizedTo.number,
        text: sanitizedBody,
        templateKey: payload.templateKey,
        status: "queued",
        consentSource: payload.consentSource,
        consentNote: payload.consentNote ?? "User checked permission box in calling workspace",
        sentBy: "operator",
      },
    });

    queuedMessageId = queuedMessage.id;

    const sendPayload: Record<string, unknown> = {
      from: fromNumber,
      to: normalizedTo.number,
      text: sanitizedBody,
      type: "SMS",
    };

    if (env.TELNYX_MESSAGING_PROFILE_ID) {
      sendPayload.messaging_profile_id = env.TELNYX_MESSAGING_PROFILE_ID;
    }

    if (env.TELNYX_USE_PROFILE_WEBHOOKS) {
      sendPayload.use_profile_webhooks = env.TELNYX_USE_PROFILE_WEBHOOKS === "true";
    }

    const client = getTelnyxClient();
    const response = await client.messages.send(sendPayload as unknown as Parameters<typeof client.messages.send>[0]);
    const telnyxMessageId = response.data?.id ?? null;
    const status = getMessageStatus(response.data);

    await prisma.smsMessage.update({
      where: { id: queuedMessage.id },
      data: {
        telnyxMessageId,
        status,
        rawPayloadJson: response as never,
      },
    });

    if (payload.leadId) {
      await prisma.leadNote
        .create({
          data: {
            leadId: payload.leadId,
            callAttemptId: latestAttempt?.id,
            body: `SMS sent: ${getSmsTemplateName(payload.templateKey)} to ${normalizedTo.number}`,
          },
        })
        .catch((noteError: unknown) => {
          logError("sms_activity_note_create_failed", {
            leadId: payload.leadId,
            message: noteError instanceof Error ? noteError.message : "Unknown note error",
          });
        });
    }

    return NextResponse.json({
      ok: true,
      messageId: telnyxMessageId,
      status,
      to: normalizedTo.number,
    });
  } catch (error) {
    const details = getTelnyxErrorDetails(error);

    if (queuedMessageId) {
      await prisma.smsMessage
        .update({
          where: { id: queuedMessageId },
          data: {
            status: "failed",
            errorCode: details.code,
            errorMessage: details.message,
            error: details.message,
            rawPayloadJson: details,
          },
        })
        .catch(() => undefined);
    }

    logError("telnyx_sms_send_failed", {
      code: details.code,
      message: details.message,
    });

    if (error instanceof z.ZodError) {
      return jsonError("Check the SMS form and try again.", 400);
    }

    return jsonError(details.message, queuedMessageId ? 502 : 400);
  }
}
