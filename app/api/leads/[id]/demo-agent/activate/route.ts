import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { activateLeadDemoAgent } from "@/lib/demo-agent/service";
import { formatUnknownError, jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const { id } = await context.params;
    const result = await activateLeadDemoAgent(id);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
