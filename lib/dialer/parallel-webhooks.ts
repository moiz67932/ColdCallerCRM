import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { TelnyxWebhookPayload } from "@/lib/telnyx/events";
import { startAttemptRecording } from "@/lib/telnyx/call-flow";

import { cloudflareRequest, orchestrationBackend } from "./orchestration";
export type ProviderDelivery = { rawBody: string; signature: string; timestamp: string; vercelArrival: number; vercelAuthenticated: number };

export async function handleParallelWebhook(event: TelnyxWebhookPayload, delivery?: ProviderDelivery) {
  const payload = event.data.payload ?? {};
  let state: { sessionId?: string; attemptId?: string; role?: string } = {};
  try { state = JSON.parse(Buffer.from(String(payload.client_state ?? ""), "base64").toString("utf8")); } catch { /* Fall back to durable provider IDs. */ }
  const db = getSupabaseAdmin();
  if (!state.sessionId && typeof payload.call_control_id === "string") {
    const { data: operator } = await db.from("dial_sessions").select("id").eq("operator_call_control_id", payload.call_control_id).maybeSingle();
    if (operator) state = { sessionId: operator.id, role: "operator" };
    else {
      const { data: attempt } = await db.from("call_attempts").select("id,dial_session_id").eq("telnyx_call_control_id", payload.call_control_id).not("parallel_batch", "is", null).maybeSingle();
      if (attempt) state = { sessionId: attempt.dial_session_id, attemptId: attempt.id, role: "lead" };
    }
  }
  if (!state.sessionId) return false;
  // Reuse recording/transcript storage and history identifiers without issuing a second bridge.
  if (event.data.event_type.startsWith("call.recording.")) return false;
  const { data: owner, error: ownerError } = await db.from("dial_sessions").select("orchestration_backend,status").eq("id",state.sessionId).single();
  if (ownerError || !owner) throw new Error("Unable to resolve orchestration ownership");
  const terminal=["stopped","completed"].includes(owner.status);
  if (owner.orchestration_backend !== orchestrationBackend() || (terminal && state.role === "operator")) {
    if (!terminal) throw new Error("Active session belongs to a different orchestration backend");
    const {error}=await db.rpc("portive_orchestration_terminal_event",{p_session:state.sessionId,p_attempt:state.attemptId??null,p_role:state.role,p_event:event});
    if(error)throw new Error(error.message);
    return true;
  }
  if (orchestrationBackend() === "cloudflare") {
    if (!delivery) throw new Error("Original signed Telnyx delivery is required for Cloudflare forwarding");
    await cloudflareRequest(`/internal/session/${state.sessionId}`, {kind:"event",eventId:event.data.id,delivery:{...delivery,...state}});
    if (event.data.event_type === "call.bridged" && state.attemptId && state.role === "lead") await startAttemptRecording(state.attemptId);
    return true;
  }
  const { error } = await db.rpc("portive_parallel_event", {
    p_session: state.sessionId, p_attempt: state.attemptId ?? null, p_role: state.role,
    p_type: event.data.event_type, p_payload: payload,
    p_at: event.data.occurred_at ?? new Date().toISOString(), p_event: event.data.id,
  });
  if (error) throw new Error(error.message);
  if (event.data.event_type === "call.bridged" && state.attemptId && state.role === "lead") await startAttemptRecording(state.attemptId);
  return true;
}
