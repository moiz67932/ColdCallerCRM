import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";

const followUpSchema = z.object({
  dueAt: z.string().datetime(),
  status: z.enum(["open", "completed", "canceled"]).default("open"),
  channel: z.enum(["call", "sms"]),
  note: z.string().optional(),
  callAttemptId: z.string().optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id: leadId } = await context.params;

  try {
    const payload = followUpSchema.parse(await request.json());
    if (payload.callAttemptId) {
      const attempt = await prisma.callAttempt.findUnique({ where: { id: payload.callAttemptId } });
      if (!attempt || attempt.leadId !== leadId) return jsonError("Call attempt not found for this lead", 404);
    }

    const followUp = await prisma.followUp.create({
      data: {
        leadId,
        callAttemptId: payload.callAttemptId,
        dueAt: new Date(payload.dueAt),
        status: payload.status,
        channel: payload.channel,
        note: payload.note,
      },
    });

    if (payload.status === "open") {
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          derivedStatus: "follow_up",
        },
      });
    }

    return NextResponse.json({ followUp });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
