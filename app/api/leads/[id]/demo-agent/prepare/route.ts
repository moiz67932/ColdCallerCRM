import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { formatUnknownError, jsonError } from "@/lib/http";
import { prepareLeadDemoAgent } from "@/lib/demo-agent/service";

const prepareSchema = z.object({
  website_url: z.string().min(1),
  activate: z.boolean().optional().default(false),
  force_rescrape: z.boolean().optional().default(false),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const { id } = await context.params;
    const payload = prepareSchema.parse(await request.json());
    const result = await prepareLeadDemoAgent({
      leadId: id,
      websiteUrl: payload.website_url,
      activate: payload.activate,
      forceRescrape: payload.force_rescrape,
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
