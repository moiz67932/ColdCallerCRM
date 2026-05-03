import { NextRequest, NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { requireEnv } from "@/lib/env";
import { formatUnknownError, jsonError } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdmin();
    const organizationId = requireEnv("DEMO_RUNTIME_ORGANIZATION_ID");
    const { data: batch, error: batchError } = await supabase
      .from("lead_demo_automation_batches")
      .select("*")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (batchError) throw new Error(batchError.message);
    if (!batch) return jsonError("Automation batch not found", 404);

    const { data: jobs, error: jobsError } = await supabase
      .from("lead_demo_automation_jobs")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("batch_id", id)
      .order("created_at", { ascending: true });

    if (jobsError) throw new Error(jobsError.message);

    return NextResponse.json({ batch, jobs: jobs ?? [] });
  } catch (error) {
    return jsonError(formatUnknownError(error), 400);
  }
}
