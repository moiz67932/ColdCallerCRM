import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/workstation-db";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      leadList: true,
      callAttempts: {
        orderBy: { createdAt: "desc" },
        include: {
          recording: true,
          transcript: true,
          smsMessages: true,
        },
      },
      leadNotes: {
        orderBy: { createdAt: "desc" },
      },
      followUps: {
        orderBy: { dueAt: "asc" },
      },
      smsMessages: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  return NextResponse.json({ lead });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const lead = await prisma.lead.findUnique({ where: { id } });

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const existingCustomFields =
    lead.customFieldsJson && typeof lead.customFieldsJson === "object" && !Array.isArray(lead.customFieldsJson)
      ? (lead.customFieldsJson as Record<string, unknown>)
      : {};

  const updatedLead = await prisma.lead.update({
    where: { id },
    data: {
      customFieldsJson: {
        ...existingCustomFields,
        workspaceHidden: true,
        workspaceHiddenAt: new Date().toISOString(),
      },
    },
  });

  return NextResponse.json({ lead: updatedLead });
}
