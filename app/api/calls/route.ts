import { NextRequest, NextResponse } from "next/server";

import { CallOutcome } from "@/lib/db-types";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/workstation-db";

function containsInsensitive(value: unknown, query: string) {
  return typeof value === "string" && value.toLowerCase().includes(query.toLowerCase());
}

function dateFilterValue(value: string, boundary: "start" | "end") {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(boundary === "start" ? 0 : 23, boundary === "start" ? 0 : 59, boundary === "start" ? 0 : 59, boundary === "start" ? 0 : 999);
  }

  return date;
}

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
  const from = fromDate ? dateFilterValue(fromDate, "start") : undefined;
  const to = toDate ? dateFilterValue(toDate, "end") : undefined;
  const limit = Number.isNaN(take) ? 100 : Math.min(500, take);

  const calls = await prisma.callAttempt.findMany({
    where: {
      outcome: normalizedOutcome,
      createdAt:
        from || to
          ? {
              gte: from,
              lte: to,
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
  });

  const filteredCalls = calls
    .filter((call: { lead?: { leadListId?: string; niche?: string | null; businessName?: string | null; contactName?: string | null; phoneNumber?: string | null } | null }) => {
      const lead = call.lead;

      if (!lead) {
        return false;
      }

      if (leadListId && lead.leadListId !== leadListId) {
        return false;
      }

      if (niche && !containsInsensitive(lead.niche, niche)) {
        return false;
      }

      if (
        query &&
        ![lead.businessName, lead.contactName, lead.phoneNumber].some((value) => containsInsensitive(value, query))
      ) {
        return false;
      }

      return true;
    })
    .slice(0, limit);

  return NextResponse.json({ calls: filteredCalls });
}
