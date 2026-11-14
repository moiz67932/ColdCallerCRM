import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { CallOutcome, type CallOutcome as CallOutcomeType } from "@/lib/db-types";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sanitizeUserText } from "@/lib/sanitize";
import { computeAttemptSummary } from "@/lib/telnyx/call-flow";

const outcomeSchema = z.object({
  callAttemptId: z.string().optional(),
  outcome: z.enum(Object.values(CallOutcome) as [CallOutcomeType, ...CallOutcomeType[]]),
  operatorNotes: z.string().optional(),
  callbackAt: z.string().datetime().optional(),
  nextAction: z.string().optional(),
});

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
    if (callAttempt?.dialSessionId && !callAttempt.endedAt) {
      return jsonError("End the session call before saving its after-call disposition", 409);
    }

    const now = new Date();
    const targetAttempt = callAttempt ?? await prisma.callAttempt.create({
      data: { leadId, status: "completed", startedAt: now, endedAt: now, durationSeconds: 0,
        rawSummaryJson: { source: "manual_outcome" } },
    });
    const { error } = await getSupabaseAdmin().rpc("portive_save_disposition", {
      p_attempt_id: targetAttempt.id, p_lead_id: leadId, p_outcome: payload.outcome,
      p_notes: payload.operatorNotes === undefined ? null : sanitizeUserText(payload.operatorNotes),
      p_callback: payload.callbackAt ?? null, p_next_action: payload.nextAction ?? null,
    });
    if (error) throw new Error(error.message);
    const updatedAttempt = await prisma.callAttempt.findUnique({ where: { id: targetAttempt.id } });
    if (!updatedAttempt) throw new Error("Saved call attempt could not be reloaded");

    await computeAttemptSummary(updatedAttempt.id);

    return NextResponse.json({ attempt: updatedAttempt });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
