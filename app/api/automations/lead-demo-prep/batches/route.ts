import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/api-auth";
import { createLeadDemoAutomationBatch, getLeadDemoAutomationSummary } from "@/lib/demo-agent/automation";
import { formatUnknownError, jsonError } from "@/lib/http";

const createBatchSchema = z.object({
  requested_count: z.number().int().min(1).max(100).optional(),
  count: z.number().int().min(1).max(100).optional(),
  max_concurrency: z.number().int().min(1).max(5).optional(),
  maxConcurrency: z.number().int().min(1).max(5).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  filters: z
    .object({
      industry: z.string().nullable().optional(),
      onlyUnprepared: z.boolean().optional(),
      retryFailed: z.boolean().optional(),
      staleAfterDays: z.number().int().min(1).max(365).nullable().optional(),
    })
    .optional(),
  forceReprocess: z.boolean().optional().default(false),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const summary = await getLeadDemoAutomationSummary();
    return NextResponse.json(summary.batches);
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    return authError;
  }

  try {
    const payload = createBatchSchema.parse(await request.json());
    const batch = await createLeadDemoAutomationBatch({
      requestedCount: payload.requested_count ?? payload.count ?? 10,
      maxConcurrency: payload.max_concurrency ?? payload.maxConcurrency ?? 2,
      name: payload.name,
      filters: payload.filters,
      forceReprocess: payload.forceReprocess,
    });

    return NextResponse.json({ batch });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
