import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getTelnyxClient } from "@/lib/telnyx/client";
import { env } from "@/lib/env";
import { getVoiceWebhookUrl } from "@/lib/telnyx/helpers";
import { dispatchCommands } from "./parallel-dispatch";
import { parallelConfiguration } from "./parallel-readiness";
import { parallelFingerprint } from "./parallel-fingerprint";

import { assertOrchestrationBackend, orchestrationBackend } from "./orchestration";

export type ParallelCommand = {
  id: string; session_id: string; attempt_id: string | null; action: string;
  parameters: Record<string, string>; state: string;
};

// Separate interface permits controlled tests to hold every dial request in flight
// and verify actual concurrent invocation without accessing the phone network.
export async function tickParallelSessions() {
  if (orchestrationBackend() !== "node") throw new Error("Node executor is disabled for this backend");
  await assertOrchestrationBackend();
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("dial_sessions").select("id,controller_id,status,parallel_options").eq("mode", "parallel")
    .in("status", ["running", "paused", "stopping", "unsafe"]);
  if (error) throw new Error(error.message);
  for (const session of data ?? []) {
    if (session.status === "running" && (env.DIALER_PARALLEL_ENABLED !== "true" || session.parallel_options.fingerprint !== parallelFingerprint(parallelConfiguration()))) {
      await db.from("dial_sessions").update({ status: "paused", reason: "Parallel provider configuration changed; reverify before resuming" }).eq("id", session.id);
      await db.rpc("portive_cancel_parallel", { p_session: session.id, p_reason: "configuration_changed" });
    }
    const { error: tickError } = await db.rpc("portive_parallel_command", { p_session: session.id, p_controller: session.controller_id, p_action: "tick" });
    if (tickError) {
      await db.from("dial_sessions").update({ status: "unsafe", reason: tickError.message }).eq("id", session.id);
      throw new Error(tickError.message);
    }
  }
}

export async function drainParallelCommands() {
  if (orchestrationBackend() !== "node") throw new Error("Node executor is disabled for this backend");
  await assertOrchestrationBackend();
  const db = getSupabaseAdmin();
  // A process crash after a command was sent is uncertain, never a redial lease.
  const { data: stale } = await db.from("dial_commands").update({ state: "uncertain", error: "Worker lost command acknowledgement" })
    .eq("state", "executing").lt("claimed_at", new Date(Date.now() - 60_000).toISOString()).select("session_id");
  for (const row of stale ?? []) await db.from("dial_sessions").update({ status: "unsafe", reason: "Provider command acknowledgement missing" }).eq("id", row.session_id);
  const { data, error } = await db.rpc("portive_claim_parallel_commands", { p_limit: 4 });
  if (error) throw new Error(error.message);
  const results = await dispatchCommands((data ?? []) as ParallelCommand[], execute);
  for (const result of results) if (result.status === "rejected") console.error("Parallel command failed", result.reason);
}

async function execute(command: ParallelCommand) {
  const db = getSupabaseAdmin();
  try {
    const { data: session, error } = await db.from("dial_sessions").select("*").eq("id", command.session_id).single();
    if (error) throw new Error(error.message);
    const { data: attempt } = command.attempt_id ? await db.from("call_attempts").select("*").eq("id", command.attempt_id).single() : { data: null };
    if (command.action === "dial_lead" && (session.status !== "running" || session.active_call_id || !session.browser_media_ready || attempt?.termination_reason)) {
      await db.from("dial_commands").update({ state: "canceled", completed_at: new Date().toISOString() }).eq("id", command.id);
      await db.from("call_attempts").update({ status: "canceled", ended_at: new Date().toISOString(), technical_state: session.active_call_id ? "canceled_after_winner" : "canceled_before_answer" }).eq("id", command.attempt_id!);
      return;
    }
    const client = getTelnyxClient();
    const clientState = (role: string) => Buffer.from(JSON.stringify({ sessionId: session.id, attemptId: command.attempt_id, role })).toString("base64");
    let response: unknown;
    const leg = attempt?.telnyx_call_control_id;
    if (command.action === "dial_operator" || command.action === "dial_lead") {
      const operator = command.action === "dial_operator";
      const remaining=Math.floor((Date.parse(session.parallel_options.deadlineAt??'')-Date.now())/1000);
      if(session.parallel_options.budgetVersion!=='exposure-v1'||!Number.isFinite(remaining)||remaining<(operator?28:session.parallel_options.maxCallSeconds+session.parallel_options.ringTimeout+23))throw Error('Funded session deadline cannot cover another call');
      const result = await client.calls.dial({
        connection_id: env.TELNYX_PARALLEL_CONNECTION_ID || env.TELNYX_CONNECTION_ID!, from: env.TELNYX_FROM_NUMBER!,
        to: operator ? session.parallel_options.operatorSipUri : command.parameters.to,
        webhook_url: getVoiceWebhookUrl(), client_state: clientState(operator ? "operator" : "lead"),
        command_id: command.id, timeout_secs: operator ? 20 : session.parallel_options.ringTimeout,
        time_limit_secs: operator ? remaining-28 : session.parallel_options.maxCallSeconds+15,
        ...(operator ? {} : { answering_machine_detection: "premium" as const }),
      });
      const ids = result.data;
      if (!ids?.call_control_id) throw new Error("Provider returned no call-control identifier");
      if (operator) {
        const { error: writeError } = await db.from("dial_sessions").update({ operator_call_control_id: ids.call_control_id })
          .eq("id", session.id);
        if (writeError) throw new Error(writeError.message);
      } else {
        const { error: writeError } = await db.from("call_attempts").update({ telnyx_call_control_id: ids.call_control_id,
          telnyx_call_leg_id: ids.call_leg_id, telnyx_call_session_id: ids.call_session_id,
        }).eq("id", command.attempt_id!);
        if (writeError) throw new Error(writeError.message);
      }
      response = result;
    } else if (command.action === "bridge") {
      if (!leg || !session.operator_call_control_id || session.active_call_id !== command.attempt_id || attempt.ended_at) throw new Error("Bridge no longer targets the active winning leg");
      response = await client.calls.actions.bridge(session.operator_call_control_id, {
        call_control_id_to_bridge_with: leg, command_id: command.id,
        park_after_unbridge: "self", prevent_double_bridge: true,
      });
    } else if (command.action === "overflow") {
      if (!leg || attempt.ended_at) throw new Error("Answered overflow call has no live provider identity");
      response = await client.calls.actions.transfer(leg, {
        to: session.parallel_options.overflowDestination, from: env.TELNYX_FROM_NUMBER!,
        command_id: command.id, early_media: true, timeout_secs: 10,
        time_limit_secs: session.parallel_options.maxCallSeconds,
        target_leg_client_state: clientState("overflow"),
      });
    } else if (command.action === "failure_playback") {
      if (!leg || attempt.ended_at) throw new Error("Failure playback target is no longer alive");
      response = await client.calls.actions.startPlayback(leg, { audio_url: session.parallel_options.failureAudioUrl, command_id: command.id, loop: 1 });
    } else if (command.action === "hangup" || command.action === "hangup_operator") {
      if (command.parameters.force !== "true" && command.action === "hangup" && !attempt?.ended_at && attempt?.answered_at && attempt.answer_classification !== "machine" && attempt.termination_reason) {
        const { error: collisionError } = await db.rpc("portive_answer_collision", { p_session: session.id, p_attempt: attempt.id });
        if (collisionError) throw new Error(collisionError.message);
        command.parameters.force = "true";
        const { error: saveError } = await db.from("dial_commands").update({ parameters: command.parameters }).eq("id", command.id);
        if (saveError) throw new Error(saveError.message);
      }
      const target = command.action === "hangup_operator" ? session.operator_call_control_id : leg;
      if (attempt?.ended_at) response = { alreadyEnded: true };
      else if (!target) {
        // A dial may still be in flight. Leave this command pending until its ID arrives.
        const { error: deferError } = await db.from("dial_commands").update({ state: "pending", claimed_at: null }).eq("id", command.id);
        if (deferError) throw new Error(deferError.message);
        return;
      }
      else response = await client.calls.actions.hangup(target, { command_id: command.id });
    } else throw new Error("Unknown call-control action");
    const { error: savedError } = await db.from("dial_commands").update({ state: "confirmed", response_json: response, completed_at: new Date().toISOString() }).eq("id", command.id);
    if (savedError) throw new Error(savedError.message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Provider command failed";
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    const rejected = status >= 400 && status < 500 && status !== 408;
    if (command.action === "dial_lead" && rejected && command.attempt_id) {
      await db.from("call_attempts").update({ status: "failed", technical_state: "failed", ended_at: new Date().toISOString(), termination_reason: `provider_${status}: ${reason}` }).eq("id", command.attempt_id);
    }
    if (command.action === "bridge" && rejected && command.attempt_id) {
      const { data: failedAttempt } = await db.from("call_attempts").select("telnyx_call_control_id").eq("id", command.attempt_id).maybeSingle();
      if (failedAttempt?.telnyx_call_control_id) {
        try { await getTelnyxClient().calls.actions.hangup(failedAttempt.telnyx_call_control_id, { command_id: `${command.id}:bridge-failure-hangup` }); } catch { /* Unsafe session state below prevents new dialing. */ }
      }
    }
    if (command.action === "overflow" && rejected && command.attempt_id) {
      await db.rpc("portive_failure_playback", { p_session: command.session_id, p_attempt: command.attempt_id, p_reason: reason });
    }
    await db.from("dial_commands").update({ state: "uncertain", error: reason }).eq("id", command.id);
    await db.from("dial_sessions").update({ status: "unsafe", reason: `${command.action}: ${reason}` }).eq("id", command.session_id);
    await db.from("dial_audit_events").insert({ session_id: command.session_id, attempt_id: command.attempt_id, event_type: "provider_command_failed", details: { action: command.action, reason } });
    throw error;
  }
}
