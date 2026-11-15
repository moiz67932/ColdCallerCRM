import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { dialerCapabilities, getCurrentSession, sessionCommand, stopSession } from "@/lib/dialer/service";
import { formatUnknownError, jsonError } from "@/lib/http";
import { ensureTelnyxConfigured, canReceiveTelnyxVoiceWebhooks } from "@/lib/telnyx/call-flow";
import { checkVoiceWebhookReachability } from "@/lib/telnyx/helpers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { parallelReadiness } from "@/lib/dialer/parallel-readiness";
import { defaultParallelOptions } from "@/lib/dialer/parallel-policy";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  try {
    const [session, lists] = await Promise.all([getCurrentSession(), getSupabaseAdmin().from("lead_lists").select("id,name").order("created_at", { ascending: false })]);
    if (lists.error) throw new Error(lists.error.message);
    const readiness = await parallelReadiness();
    let acceptanceAuthorization = null;
    const grantId = request.nextUrl.searchParams.get("acceptanceGrantId"), controllerId = request.nextUrl.searchParams.get("controllerId");
    if (env.DIALER_ACCEPTANCE_ENABLED === "true" && env.DIALER_PARALLEL_ENABLED === "false" && z.uuid().safeParse(grantId).success && z.uuid().safeParse(controllerId).success) {
      const { data } = await getSupabaseAdmin().from("dialer_acceptance_grants")
        .select("id,list_id,time_zone,destinations,max_spend_cents,expires_at").eq("id", grantId!).eq("controller_id", controllerId!)
        .is("revoked_at", null).is("consumed_session_id", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (data) acceptanceAuthorization = { ...data, destinations: data.destinations.map((d: {phone_number:string;time_zone:string}) => ({phone_number:d.phone_number,time_zone:d.time_zone})) };
    }
    return NextResponse.json({ session, lists: lists.data, acceptanceAuthorization, capabilities: { ...dialerCapabilities(), parallel: readiness.enabled, parallelBlockers: readiness.blockers } });
  } catch (error) { return jsonError(formatUnknownError(error), 503); }
}

const schema = z.object({
  action: z.enum(["start", "next", "pause", "resume", "stop", "heartbeat", "continue", "skip", "operator_ready"]),
  controllerId: z.uuid(), sessionId: z.string().optional(), ready: z.boolean().default(false),
  listId: z.string().optional(), location: z.string().optional(), attemptLimit: z.number().int().min(1).max(500).optional(),
  mode: z.enum(["power", "parallel"]).optional(), maxLines: z.number().int().min(1).max(4).optional(),
  timeZone: z.string().optional(), reviewed: z.boolean().optional(),
  acceptanceGrantId: z.uuid().optional(),
  callControlId: z.string().optional(),
  transportReady: z.boolean().optional(),
  options: z.object({
    ringTimeout: z.number().int().min(15).max(120), maxCallSeconds: z.number().int().min(30).max(1800),
    batchDelaySeconds: z.number().int().min(0).max(60), attemptLimit: z.number().int().min(1).max(500),
    maxSpendCents: z.number().int().min(1).max(100000), autoContinue: z.boolean(),
    autoRefill: z.literal(false), silentRingback: z.boolean(),
  }).default(defaultParallelOptions),
});

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth(request, { mutation: true });
  if (auth) return auth;
  try {
    const input = schema.parse(await request.json());
    if (["start", "next", "resume", "continue", "skip"].includes(input.action) && (!ensureTelnyxConfigured() || !canReceiveTelnyxVoiceWebhooks())) {
      return jsonError("Telnyx configuration or public webhook URL is incomplete", 409);
    }
    if (input.action === "start" || input.action === "resume") {
      const reachable = await checkVoiceWebhookReachability();
      if (!reachable.reachable) return jsonError(`Voice webhook unreachable: ${reachable.reason}`, 409);
    }
    const result = await sessionCommand(input);
    if (result.session.mode === "power" && !input.ready && result.session.active_call_id && result.session.status === "paused") {
      const { error } = await getSupabaseAdmin().from("dial_sessions").update({
        status: "stopping", reason: "Operator media unavailable",
      }).eq("id", result.session.id);
      if (error) throw new Error(error.message);
      result.session.status = "stopping";
    }
    if (input.action === "stop" || result.session.status === "stopping") result.session = await stopSession(result.session);
    return NextResponse.json(result);
  } catch (error) { return jsonError(formatUnknownError(error), 409); }
}
