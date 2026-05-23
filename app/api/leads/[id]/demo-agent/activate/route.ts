import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  const { id } = await context.params;

  return NextResponse.json(
    {
      error:
        "This endpoint has been retired. Use /api/leads/[id]/demo-agent/prepare and /api/leads/[id]/demo-agent/status instead.",
      leadId: id,
    },
    { status: 410 },
  );
}
