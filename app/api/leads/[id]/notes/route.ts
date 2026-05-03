import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";
import { sanitizeUserText } from "@/lib/sanitize";

const noteSchema = z.object({
  noteId: z.string().optional(),
  callAttemptId: z.string().optional(),
  body: z.string(),
  autosave: z.boolean().optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id: leadId } = await context.params;

  try {
    const payload = noteSchema.parse(await request.json());
    const sanitizedBody = sanitizeUserText(payload.body);

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        notes: sanitizedBody,
      },
    });

    if (payload.autosave) {
      return NextResponse.json({ saved: true });
    }

    const note = payload.noteId
      ? await prisma.leadNote.update({
          where: { id: payload.noteId },
          data: {
            body: sanitizedBody,
          },
        })
      : await prisma.leadNote.create({
          data: {
            leadId,
            callAttemptId: payload.callAttemptId,
            body: sanitizedBody,
          },
        });

    return NextResponse.json({ note });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
