import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/workstation-db";
import { sanitizeUserText } from "@/lib/sanitize";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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

    if (payload.callAttemptId) {
      const attempt = await prisma.callAttempt.findUnique({ where: { id: payload.callAttemptId } });
      if (!attempt || attempt.leadId !== leadId) return jsonError("Call attempt not found for this lead", 404);
    }
    if (payload.noteId) {
      const { data: note, error } = await getSupabaseAdmin().from("lead_notes").select("lead_id").eq("id", payload.noteId).single();
      if (error || note?.lead_id !== leadId) return jsonError("Note not found for this lead", 404);
    }

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
          where: { id: payload.noteId, leadId },
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
