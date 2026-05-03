import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { cancelLeadDemoAutomationBatch } from "@/lib/demo-agent/automation";
import { formatUnknownError, jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const { id } = await context.params;
    await cancelLeadDemoAutomationBatch(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
