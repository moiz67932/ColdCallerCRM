import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getFailedLeadDemoAutomationJobs } from "@/lib/demo-agent/automation";
import { formatUnknownError, jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "25");
    const failedJobs = await getFailedLeadDemoAutomationJobs(Number.isNaN(limit) ? 25 : limit);
    return NextResponse.json({ failed_jobs: failedJobs });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
