import { NextRequest, NextResponse } from "next/server";

import { CallOutcome } from "@/lib/db-types";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/workstation-db";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const searchParams = request.nextUrl.searchParams;

  const query = searchParams.get("q") ?? undefined;
  const outcome = searchParams.get("outcome") ?? undefined;
  const leadListId = searchParams.get("leadListId") ?? undefined;
  const niche = searchParams.get("niche") ?? undefined;
  const fromDate = searchParams.get("from") ?? undefined;
  const toDate = searchParams.get("to") ?? undefined;
  const take = Number(searchParams.get("take") ?? "100");

  const normalizedOutcome = outcome && Object.values(CallOutcome).includes(outcome as CallOutcome)
    ? (outcome as CallOutcome)
    : undefined;

  const calls = await prisma.callAttempt.findMany({
    where: {
      outcome: normalizedOutcome,
      lead: {
        leadListId,
        niche: niche ? { contains: niche, mode: "insensitive" } : undefined,
        OR: query
          ? [
              { businessName: { contains: query, mode: "insensitive" } },
              { contactName: { contains: query, mode: "insensitive" } },
              { phoneNumber: { contains: query, mode: "insensitive" } },
            ]
          : undefined,
      },
      createdAt:
        fromDate || toDate
          ? {
              gte: fromDate ? new Date(fromDate) : undefined,
              lte: toDate ? new Date(toDate) : undefined,
            }
          : undefined,
    },
    include: {
      lead: {
        include: {
          leadList: true,
        },
      },
      recording: true,
      transcript: true,
    },
    orderBy: { createdAt: "desc" },
    take: Number.isNaN(take) ? 100 : Math.min(500, take),
  });

  return NextResponse.json({ calls });
}
