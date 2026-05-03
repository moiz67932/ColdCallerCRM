import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { LeadDerivedStatus } from "@/lib/db-types";
import { sortLeadsForQueue, getLeadTags } from "@/lib/lead-queue";
import { prisma } from "@/lib/workstation-db";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const searchParams = request.nextUrl.searchParams;
  const leadListId = searchParams.get("leadListId") ?? undefined;
  const niche = searchParams.get("niche") ?? undefined;
  const status = searchParams.get("status") ?? undefined;
  const query = searchParams.get("q") ?? undefined;
  const sortMode = searchParams.get("sort") ?? "queue";
  const take = Number(searchParams.get("take") ?? "200");

  const derivedStatus = status && Object.values(LeadDerivedStatus).includes(status as LeadDerivedStatus)
    ? (status as LeadDerivedStatus)
    : undefined;

  const leads = await prisma.lead.findMany({
    where: {
      leadListId,
      niche: niche ? { contains: niche, mode: "insensitive" } : undefined,
      derivedStatus,
      OR: query
        ? [
            { businessName: { contains: query, mode: "insensitive" } },
            { contactName: { contains: query, mode: "insensitive" } },
            { phoneNumber: { contains: query, mode: "insensitive" } },
            { city: { contains: query, mode: "insensitive" } },
          ]
        : undefined,
    },
    include: {
      leadList: true,
      callAttempts: {
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          recording: true,
          transcript: true,
        },
      },
      followUps: {
        where: { status: "open" },
        orderBy: { dueAt: "asc" },
      },
    },
    take: Number.isNaN(take) ? 200 : Math.min(500, take),
    orderBy: { createdAt: "asc" },
  });

  const sorted = sortMode === "queue" ? sortLeadsForQueue(leads) : leads;

  return NextResponse.json({
    leads: sorted.map((lead: Parameters<typeof getLeadTags>[0]) => ({
      ...lead,
      tags: getLeadTags(lead as Parameters<typeof getLeadTags>[0]),
    })),
  });
}
