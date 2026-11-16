import { env } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getOutboundCallerId, getTelnyxManualDialFlow } from "@/lib/telnyx/helpers";
import { hangupAttemptLegs } from "@/lib/telnyx/call-flow";
import type { DialSession, SessionCommandResult } from "./types";
import { parallelReadiness } from "./parallel-readiness";
import { assertOrchestrationBackend, orchestrationBackend, prepareOrchestration, wakeOrchestration } from "./orchestration";
import type { ParallelOptions } from "./parallel-policy";
import {budgetQuote} from './budget';
import {parallelFingerprint} from './parallel-fingerprint';
import {dailyHeadroom} from './funding';
import { acceptanceStartOptions } from "./acceptance";
import { parallelLeadFilters } from "./parallel-filters";

export function dialerCapabilities() {
  return {
    power: env.DIALER_POWER_ENABLED !== "false" && getTelnyxManualDialFlow() === "browser_first",
    parallel: env.DIALER_PARALLEL_ENABLED === "true",
    parallelPreview: env.DIALER_PARALLEL_ENABLED === "true",
    acceptance: env.DIALER_ACCEPTANCE_ENABLED === "true" && env.DIALER_PARALLEL_ENABLED === "false" && orchestrationBackend() === "cloudflare",
  };
}

export async function sessionCommand(input: {
  action: string; sessionId?: string; controllerId: string; ready: boolean;
  listId?: string; location?: string; parallelLocation?: string; attemptLimit?: number; mode?: string; maxLines?: number;
  timeZone?: string; reviewed?: boolean;
  options?: ParallelOptions; callControlId?: string;
  transportReady?: boolean;
  acceptanceGrantId?: string;
}) {
  await assertOrchestrationBackend(input.sessionId);
  if (["start", "resume", "next", "continue", "skip"].includes(input.action)) await prepareOrchestration();
  const existing = input.sessionId ? await getCurrentSession() : null;
  if (input.mode === "parallel" || existing?.mode === "parallel") {
    if (input.action === "start" && input.acceptanceGrantId) {
      const options = await acceptanceStartOptions(input.acceptanceGrantId, input.controllerId);
      const { data, error } = await getSupabaseAdmin().rpc("portive_parallel_command", {
        p_session: null, p_controller: input.controllerId, p_action: "start", p_ready: input.ready,
        p_reviewed: input.reviewed ?? false, p_options: options,
      });
      if (error) throw new Error(error.message);
      await wakeOrchestration(data.id);
      return { session: data, dispatch: false } as SessionCommandResult;
    }
    const starting = input.action === "start" || input.action === "resume";
    const readiness = starting ? await parallelReadiness(true) : null;
    if (readiness && !readiness.enabled) throw new Error(readiness.blockers.join(" "));
    if (input.action === "resume" && existing?.parallel_options?.fingerprint !== readiness?.fingerprint) throw new Error("Provider configuration changed; stop and reconcile this session before starting a new one");
    if (starting && readiness!.channels < (input.maxLines ?? existing?.max_lines ?? 4) + 1) throw new Error("Provider channels must cover each prospect line and the operator leg");
    if(input.action==='start'&&readiness!.budget.profile?.pricingMode==='owner-provisional'&&input.options?.spendingApproved!==true)throw Error('Accept the bounded session spending limit before Start');
    const funding=input.action==='start'?await dailyHeadroom(readiness!.dailyLimitCents):null;
    const pricedOptions=input.options??existing?.parallel_options;
    const quote=input.action==='start'&&readiness!.budget.profile?budgetQuote(readiness!.budget.profile,pricedOptions as unknown as Parameters<typeof budgetQuote>[1],input.maxLines??existing?.max_lines??4):null;
    if(quote&&quote.shortfallCents)throw Error(`Session requires ${quote.requiredCents} cents; increase maximum spend by ${quote.shortfallCents} cents or reduce duration/lines`);
    if(quote&&quote.requiredCents+readiness!.budget.heldCents>readiness!.availableCreditCents)throw Error(`Funded exposure requires ${quote.requiredCents} cents plus ${readiness!.budget.heldCents} cents of unsettled prior calls; available ${readiness!.availableCreditCents} cents`);
    if(quote&&quote.requiredCents+readiness!.budget.heldCents>funding!.cents)throw Error(`Remaining provider daily headroom is ${funding!.cents} cents; funded exposure needs ${quote.requiredCents+readiness!.budget.heldCents} cents`);
    const fundedBudget=quote?Math.min(input.options!.maxSpendCents,readiness!.availableCreditCents-readiness!.budget.heldCents,funding!.cents-readiness!.budget.heldCents):undefined;
    if(input.action==='resume'&&parallelFingerprint(existing?.parallel_options?.costProfile as Record<string,unknown>??{})!==parallelFingerprint(readiness?.budget.profile??{}))throw Error('Tariff changed; stop and reconcile before funding a new session');
    const { data, error } = await getSupabaseAdmin().rpc("portive_parallel_command", {
      p_session: input.sessionId ?? null, p_controller: input.controllerId, p_action: input.action,
      p_ready: input.ready, ...parallelLeadFilters(input),
      p_lines: input.maxLines ?? 4, p_timezone: input.timeZone ?? null, p_reviewed: input.reviewed ?? false,
      p_options: { ...input.options, ...(fundedBudget!==undefined?{maxSpendCents:fundedBudget}:{}), accountChannels: readiness?.channels, costProfile: readiness?.budget.profile, sessionSeconds:quote?.sessionSeconds, availableCreditCents:readiness?.availableCreditCents, dailyHeadroomCents:funding?.cents, fingerprint: readiness?.fingerprint,
        operatorSipUri: readiness?.sipUri, callControlId: input.callControlId, transportReady: input.transportReady ?? true },
    });
    if (error) throw new Error(error.message);
    await wakeOrchestration(data.id);
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
  await wakeOrchestration(data.session.id);
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
  if (session.mode === "parallel" || orchestrationBackend() === "cloudflare") return session;
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
  if (orchestrationBackend() !== "node") throw new Error("Node watchdog is disabled for the selected backend");
  await assertOrchestrationBackend();
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
