import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import type { JsonObject, JsonValue } from "@/lib/db-types";
import { formatUnknownError, jsonError } from "@/lib/http";
import { logInfo } from "@/lib/logger";
import { prisma } from "@/lib/workstation-db";
import { hangupAttemptLegs, startAttemptRecording } from "@/lib/telnyx/call-flow";
import { resolveClientStatus } from "@/lib/telnyx/lifecycle";
import { isBrowserFirstManualDialFlow } from "@/lib/telnyx/call-flow";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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

  const controlIds = (callAttempt.parallelBatch != null
    ? [callAttempt.telnyxCallControlId, callAttempt.overflowCallControlId]
    : [callAttempt.telnyxCallControlId, callAttempt.telnyxAgentCallControlId]).filter(
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
    recordingConsent: z.literal(true).optional(),
    clientError: z.string().optional(),
    answeredAt: z.string().datetime().optional(),
    debug: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    progressState: z.string().optional(),
    telnyxIds: z
      .object({
        callControlId: z.string().nullish(),
        callSessionId: z.string().nullish(),
        callLegId: z.string().nullish(),
      })
      .optional(),
  })
  .refine((value) => Boolean(value.status || value.recordingConsent || value.clientError || value.debug || value.progressState || value.telnyxIds), {
    message: "A status update, client error, progress update, Telnyx ID update, or debug payload is required",
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
    if (payload.recordingConsent) {
      await prisma.callAttempt.update({ where: { id }, data: { recordingConsentAt: new Date() } });
      await startAttemptRecording(id);
      return NextResponse.json({ saved: true });
    }
    if (attempt.parallelBatch !== null && attempt.parallelBatch !== undefined) {
      if (payload.status === "canceled" && !attempt.endedAt) {
        const { error } = await getSupabaseAdmin().rpc("portive_enqueue", {
          p_session: attempt.dialSessionId, p_attempt: id, p_action: "hangup", p_key: `${id}:operator-end`,
        });
        if (error) throw new Error(error.message);
      } else if (payload.status) return jsonError("Parallel lifecycle changes require provider events", 409);
      return NextResponse.json({ attempt });
    }
    const providerIds = payload.telnyxIds ? (isBrowserFirstManualDialFlow() ? {
      telnyxCallControlId: payload.telnyxIds.callControlId ?? attempt.telnyxCallControlId,
      telnyxCallSessionId: payload.telnyxIds.callSessionId ?? attempt.telnyxCallSessionId,
      telnyxCallLegId: payload.telnyxIds.callLegId ?? attempt.telnyxCallLegId,
    } : {
      telnyxAgentCallControlId: payload.telnyxIds.callControlId ?? attempt.telnyxAgentCallControlId,
      telnyxAgentCallLegId: payload.telnyxIds.callLegId ?? attempt.telnyxAgentCallLegId,
    }) : {};

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
    const summaryWithProgress =
      payload.progressState || payload.telnyxIds
        ? ({
            ...(summaryWithClientError ?? existingSummary ?? {}),
            ...(payload.progressState ? { progressState: payload.progressState, progressUpdatedAt: new Date().toISOString() } : {}),
            ...(payload.telnyxIds
              ? {
                  browserLegTelnyxIds: {
                    callControlId: payload.telnyxIds.callControlId ?? null,
                    callSessionId: payload.telnyxIds.callSessionId ?? null,
                    callLegId: payload.telnyxIds.callLegId ?? null,
                  },
                }
              : {}),
          } as JsonObject)
        : summaryWithClientError;

    let updated = attempt;

    if (payload.debug) {
      logInfo("Browser WebRTC client debug event", {
        callAttemptId: id,
        leadCallControlId: attempt.telnyxCallControlId,
        browserCallControlId: attempt.telnyxAgentCallControlId,
        ...payload.debug,
      });
    }

    if (payload.progressState || payload.telnyxIds) {
      logInfo("Browser WebRTC progress update", {
        callAttemptId: id,
        progressState: payload.progressState,
        browserCallControlId: payload.telnyxIds?.callControlId ?? attempt.telnyxAgentCallControlId ?? attempt.telnyxCallControlId,
        browserCallSessionId: payload.telnyxIds?.callSessionId ?? attempt.telnyxCallSessionId,
        browserCallLegId: payload.telnyxIds?.callLegId ?? attempt.telnyxAgentCallLegId ?? attempt.telnyxCallLegId,
      });
    }

    if (payload.status) {
      if (payload.status === "canceled" && !updated.endedAt) {
        await hangupAttemptLegs(updated.id);
      }

      updated = await prisma.callAttempt.update({
        where: { id },
        data: {
          status: resolveClientStatus(updated, payload.status),
          ...(payload.status === "connected" ? { wasBridgedToOperator: true, technicalState: "bridged" } : {}),
          ...(payload.status === "canceled" ? { terminationReason: "operator_hangup" } : {}),
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
          ...(payload.status !== "connected" && ["busy", "no_answer"].includes(payload.progressState ?? "") && !updated.answeredAt
            ? { technicalState: payload.progressState, outcome: payload.progressState === "no_answer" ? "no_answer" : updated.outcome } : {}),
          ...providerIds,
          rawSummaryJson: summaryWithProgress,
        },
      });

      if (payload.status === "connected") {
        await startAttemptRecording(updated.id);
      }
    } else if (summaryWithProgress || payload.telnyxIds) {
      updated = await prisma.callAttempt.update({
        where: { id },
        data: {
          ...providerIds,
          rawSummaryJson: summaryWithProgress,
        },
      });
    }

    return NextResponse.json({ attempt: updated });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
