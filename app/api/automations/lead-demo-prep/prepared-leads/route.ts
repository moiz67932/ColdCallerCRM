import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getPreparedLeadDemoProfiles } from "@/lib/demo-agent/automation";
import { formatUnknownError, jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "25");
    const preparedLeads = await getPreparedLeadDemoProfiles(Number.isNaN(limit) ? 25 : limit);
    return NextResponse.json({ prepared_leads: preparedLeads });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
