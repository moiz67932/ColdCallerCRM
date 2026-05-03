import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getLeadDemoAutomationSummary } from "@/lib/demo-agent/automation";
import { formatUnknownError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  try {
    return NextResponse.json(await getLeadDemoAutomationSummary());
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
