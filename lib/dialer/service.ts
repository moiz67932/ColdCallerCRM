import { env } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getOutboundCallerId, getTelnyxManualDialFlow } from "@/lib/telnyx/helpers";
import { hangupAttemptLegs } from "@/lib/telnyx/call-flow";
import type { DialSession, SessionCommandResult } from "./types";
import { parallelReadiness } from "./parallel-readiness";
import { parallelConfiguration } from "./parallel-readiness";
import type { ParallelOptions } from "./parallel-policy";

export function dialerCapabilities() {
  return {
    power: env.DIALER_POWER_ENABLED !== "false" && getTelnyxManualDialFlow() === "browser_first",
    parallel: env.DIALER_PARALLEL_ENABLED === "true",
    parallelPreview: env.DIALER_PARALLEL_ENABLED === "true",
  };
}

export async function sessionCommand(input: {
  action: string; sessionId?: string; controllerId: string; ready: boolean;
  listId?: string; location?: string; attemptLimit?: number; mode?: string; maxLines?: number;
  timeZone?: string; reviewed?: boolean;
  options?: ParallelOptions; callControlId?: string;
  transportReady?: boolean;
}) {
  const existing = input.sessionId ? await getCurrentSession() : null;
  if (input.mode === "parallel" || existing?.mode === "parallel") {
    const starting = input.action === "start" || input.action === "resume";
    const readiness = starting ? await parallelReadiness(true) : null;
    if (readiness && !readiness.enabled) throw new Error(readiness.blockers.join(" "));
    if (starting && readiness!.channels < 2 * (input.maxLines ?? existing?.max_lines ?? 4) + 1) throw new Error("Verified channels must cover prospect, operator and overflow transfer legs");
    if (starting && readiness!.availableCreditCents < (input.options?.maxSpendCents ?? (Number(existing?.parallel_options?.maxSpendCents) || 5000))) throw new Error("Requested session spend exceeds provider available credit");
    const { data, error } = await getSupabaseAdmin().rpc("portive_parallel_command", {
      p_session: input.sessionId ?? null, p_controller: input.controllerId, p_action: input.action,
      p_ready: input.ready, p_list: input.listId ?? null, p_location: input.location ?? null,
      p_lines: input.maxLines ?? 4, p_timezone: input.timeZone ?? null, p_reviewed: input.reviewed ?? false,
      p_options: { ...input.options, verificationId: readiness?.verification?.id, fingerprint: readiness?.fingerprint,
        operatorSipUri: readiness?.sipUri, callControlId: input.callControlId, transportReady: input.transportReady ?? true,
        overflowDestination: parallelConfiguration().overflow, failureAudioUrl: parallelConfiguration().failureAudio },
    });
    if (error) throw new Error(error.message);
    return { session: data, dispatch: false } as SessionCommandResult;
  }
  const capabilities = dialerCapabilities();
  if (["start", "next", "resume", "continue", "skip"].includes(input.action)) {
    if (!capabilities.power) throw new Error("Power Mode requires browser_first calling and DIALER_POWER_ENABLED=true");
    if (!env.TELNYX_PUBLIC_KEY || env.TELNYX_SKIP_SIGNATURE_VERIFICATION === "true") {
      throw new Error("Automated calling requires verified Telnyx webhooks (TELNYX_PUBLIC_KEY; signature bypass disabled)");
    }
    if (!/^\+[1-9]\d{7,14}$/.test(getOutboundCallerId())) throw new Error("Configure a valid E.164 caller ID");
  }
  const { data, error } = await getSupabaseAdmin().rpc("portive_session_command", {
    p_session_id: input.sessionId ?? null, p_controller: input.controllerId, p_action: input.action,
    p_ready: input.ready, p_list_id: input.listId ?? null, p_location: input.location ?? null,
    p_limit: input.attemptLimit ?? 100, p_mode: input.mode ?? "power", p_lines: input.maxLines ?? 1,
    p_timezone: input.timeZone ?? null, p_reviewed: input.reviewed ?? false,
  });
  if (error) throw new Error(error.message);
  return { ...data, ...(data.dispatch ? { callerNumber: getOutboundCallerId() } : {}) } as SessionCommandResult;
}

export async function getCurrentSession() {
  const { data, error } = await getSupabaseAdmin().from("dial_sessions").select("*")
    .in("status", ["running", "paused", "stopping", "unsafe"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Dial sessions unavailable. Apply migration 202611130001_dial_sessions.sql. ${error.message}`);
  return data as DialSession | null;
}

// No new call is ever dispatched from a watchdog or webhook. Only a ready browser can consume a claim.
export async function stopSession(session: DialSession, endUnavailableCall = false) {
  if (session.mode === "parallel") return session;
  const db = getSupabaseAdmin();
  try {
    if (session.active_call_id) {
      const { data: attempt, error } = await db.from("call_attempts").select("*").eq("id", session.active_call_id).single();
      if (error) throw new Error(error.message);
      if (!attempt.ended_at) {
        if (attempt.answered_at && !endUnavailableCall) return session;
        if (!attempt.telnyx_call_control_id && !attempt.telnyx_agent_call_control_id) {
          throw new Error("Provider call identity not confirmed. End the browser call and wait for its terminal event before releasing the session.");
        }
        await hangupAttemptLegs(attempt.id);
        // Wait for provider termination evidence; don't free a reservation on a command acknowledgement.
        return session;
      }
    }
    const { data, error } = await db.from("dial_sessions").update({ status: "stopped", ended_at: new Date().toISOString() })
      .eq("id", session.id).select("*").single();
    if (error) throw new Error(error.message);
    return data as DialSession;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stop failed";
    await db.from("dial_sessions").update({ status: "unsafe", reason: message }).eq("id", session.id);
    throw error;
  }
}

export async function sweepExpiredSessions() {
  const db = getSupabaseAdmin();
  const { error: heartbeatError } = await db.from("app_settings").upsert({
    key: "dialer_watchdog_heartbeat", value_json: { at: new Date().toISOString() },
  }, { onConflict: "key" });
  if (heartbeatError) throw new Error(heartbeatError.message);
  const { data, error } = await db.from("dial_sessions").select("*").eq("mode", "power").in("status", ["running", "paused", "stopping", "unsafe"]);
  if (error) throw new Error(error.message);
  for (const session of (data ?? []) as DialSession[]) {
    if (session.status !== "stopping" && session.status !== "unsafe" && Date.now() - Date.parse(session.heartbeat_at) < 45_000) continue;
    const { error: pauseError } = await db.from("dial_sessions").update({ status: "stopping", reason: "Browser lease expired or stop pending" }).eq("id", session.id);
    if (pauseError) throw new Error(pauseError.message);
    try { await stopSession(session, true); } catch (error) { console.error("Dial session requires review", session.id, error); }
  }
}
