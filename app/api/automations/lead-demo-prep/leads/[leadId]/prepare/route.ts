import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { prepareLeadDemoAgent } from "@/lib/demo-agent/service";
import { formatUnknownError, jsonError } from "@/lib/http";

const prepareSchema = z.object({
  website_url: z.string().min(1),
  force_rescrape: z.boolean().optional().default(false),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ leadId: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const { leadId } = await context.params;
    const payload = prepareSchema.parse(await request.json());
    const result = await prepareLeadDemoAgent({
      leadId,
      websiteUrl: payload.website_url,
      forceRescrape: payload.force_rescrape,
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
