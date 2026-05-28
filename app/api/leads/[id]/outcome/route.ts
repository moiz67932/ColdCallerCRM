import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { CallOutcome, type CallOutcome as CallOutcomeType, type LeadDerivedStatus } from "@/lib/db-types";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";
import { computeAttemptSummary } from "@/lib/telnyx/call-flow";

const outcomeSchema = z.object({
  callAttemptId: z.string().optional(),
  outcome: z.enum(Object.values(CallOutcome) as [CallOutcomeType, ...CallOutcomeType[]]),
  operatorNotes: z.string().optional(),
  callbackAt: z.string().datetime().optional(),
  nextAction: z.string().optional(),
});

function mapLeadStatus(outcome: CallOutcomeType): LeadDerivedStatus {
  switch (outcome) {
    case "bad_number":
      return "bad_number";
    case "interested":
      return "interested";
    case "demo_requested":
      return "demo_requested";
    case "not_interested":
      return "closed_lost";
    case "callback":
      return "follow_up";
    default:
      return "contacted";
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id: leadId } = await context.params;

  try {
    const payload = outcomeSchema.parse(await request.json());

    const callAttempt = payload.callAttemptId
      ? await prisma.callAttempt.findUnique({ where: { id: payload.callAttemptId } })
      : await prisma.callAttempt.findFirst({
          where: { leadId },
          orderBy: { createdAt: "desc" },
        });

    if (payload.callAttemptId && !callAttempt) {
      return jsonError("Call attempt not found for this lead", 404);
    }

    if (callAttempt && callAttempt.leadId !== leadId) {
      return jsonError("Call attempt not found for this lead", 404);
    }

    const callbackAt = payload.callbackAt ? new Date(payload.callbackAt) : null;

    const now = new Date();
    const updatedAttempt = callAttempt
      ? await prisma.callAttempt.update({
          where: { id: callAttempt.id },
          data: {
            outcome: payload.outcome,
            operatorNotes: payload.operatorNotes ?? callAttempt.operatorNotes,
            callbackAt,
            nextAction: payload.nextAction ?? callAttempt.nextAction,
          },
        })
      : await prisma.callAttempt.create({
          data: {
            leadId,
            status: "completed",
            outcome: payload.outcome,
            operatorNotes: payload.operatorNotes,
            callbackAt,
            nextAction: payload.nextAction,
            startedAt: now,
            endedAt: now,
            durationSeconds: 0,
            rawSummaryJson: {
              source: "manual_outcome",
              outcome: payload.outcome,
            },
          },
        });

    if (payload.outcome === "callback" && callbackAt) {
      await prisma.followUp.create({
        data: {
          leadId,
          callAttemptId: updatedAttempt.id,
          dueAt: callbackAt,
          status: "open",
          channel: "call",
          note: payload.nextAction ?? "Callback requested",
        },
      });
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        derivedStatus: mapLeadStatus(payload.outcome),
      },
    });

    await computeAttemptSummary(updatedAttempt.id);

    return NextResponse.json({ attempt: updatedAttempt });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
