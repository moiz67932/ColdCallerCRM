import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getLeadDemoAgentStatus } from "@/lib/demo-agent/service";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const status = await getLeadDemoAgentStatus(id);
  return NextResponse.json(status);
}
