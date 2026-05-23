import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import type { JsonObject, JsonValue } from "@/lib/db-types";
import { formatUnknownError, jsonError } from "@/lib/http";
import { logInfo } from "@/lib/logger";
import { prisma } from "@/lib/workstation-db";
import { hangupAttemptLegs, startAttemptRecording } from "@/lib/telnyx/call-flow";

function getHangupSourceFromWebhookPayload(payloadJson: JsonValue) {
  if (!payloadJson || typeof payloadJson !== "object" || Array.isArray(payloadJson)) {
    return null;
  }

  const data = (payloadJson as Record<string, unknown>).data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const payload = (data as Record<string, unknown>).payload;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const hangupSource = (payload as Record<string, unknown>).hangup_source;
  return typeof hangupSource === "string" ? hangupSource : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;

  const callAttempt = await prisma.callAttempt.findUnique({
    where: { id },
    include: {
      lead: {
        include: {
          leadList: true,
        },
      },
      recording: true,
      transcript: true,
      notes: {
        orderBy: { createdAt: "desc" },
      },
      smsMessages: {
        orderBy: { createdAt: "desc" },
      },
      followUps: {
        orderBy: { dueAt: "asc" },
      },
    },
  });

  if (!callAttempt) {
    return NextResponse.json({ error: "Call attempt not found" }, { status: 404 });
  }

  const controlIds = [callAttempt.telnyxCallControlId, callAttempt.telnyxAgentCallControlId].filter(
    (value): value is string => Boolean(value),
  );

  const webhookEvents =
    controlIds.length === 0
      ? []
      : await prisma.telnyxWebhookEvent.findMany({
          where: {
            callControlId: {
              in: controlIds,
            },
          },
          orderBy: { receivedAt: "asc" },
        });

  const latestHangupEvent = [...webhookEvents].reverse().find((event) => event.eventType === "call.hangup");
  const endedBy = latestHangupEvent ? getHangupSourceFromWebhookPayload(latestHangupEvent.payloadJson) : null;

  return NextResponse.json({
    callAttempt: {
      ...callAttempt,
      endedBy,
    },
    webhookEvents,
  });
}

const updateCallAttemptSchema = z
  .object({
    status: z.enum(["connected", "failed", "canceled"]).optional(),
    clientError: z.string().optional(),
    answeredAt: z.string().datetime().optional(),
    debug: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .refine((value) => Boolean(value.status || value.clientError || value.debug), {
    message: "A status update, client error, or debug payload is required",
  });

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id } = await context.params;

  try {
    const payload = updateCallAttemptSchema.parse(await request.json());
    const attempt = await prisma.callAttempt.findUnique({ where: { id } });

    if (!attempt) {
      return jsonError("Call attempt not found", 404);
    }

    const existingSummary =
      attempt.rawSummaryJson && typeof attempt.rawSummaryJson === "object" && !Array.isArray(attempt.rawSummaryJson)
        ? (attempt.rawSummaryJson as JsonObject)
        : null;

    const summaryWithClientError = payload.clientError || payload.debug
      ? ({
          ...(existingSummary ?? {}),
          ...(payload.clientError ? { clientError: payload.clientError } : {}),
          ...(payload.debug ? { clientDebug: payload.debug } : {}),
        })
      : undefined;

    let updated = attempt;

    if (payload.debug) {
      logInfo("Browser WebRTC client debug event", {
        callAttemptId: id,
        leadCallControlId: attempt.telnyxCallControlId,
        browserCallControlId: attempt.telnyxAgentCallControlId,
        ...payload.debug,
      });
    }

    if (payload.status) {
      if (payload.status === "canceled" && !updated.endedAt) {
        await hangupAttemptLegs(updated.id);
      }

      updated = await prisma.callAttempt.update({
        where: { id },
        data: {
          status:
            payload.status === "connected"
              ? updated.status === "voicemail_detected" || updated.endedAt
                ? updated.status
                : "connected"
              : updated.endedAt
                ? updated.status
                : payload.status,
          answeredAt:
            payload.status === "connected" && !updated.answeredAt
              ? payload.answeredAt
                ? new Date(payload.answeredAt)
                : new Date()
              : updated.answeredAt,
          endedAt:
            payload.status === "connected"
              ? updated.endedAt
              : updated.endedAt ?? new Date(),
          rawSummaryJson: summaryWithClientError,
        },
      });

      if (payload.status === "connected") {
        await startAttemptRecording(updated.id);
      }
    } else if (summaryWithClientError) {
      updated = await prisma.callAttempt.update({
        where: { id },
        data: {
          rawSummaryJson: summaryWithClientError,
        },
      });
    }

    return NextResponse.json({ attempt: updated });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
