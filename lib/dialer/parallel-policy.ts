export const controlledScenarios = [
  "four_concurrent_ringing", "first_human_bridge", "machine_excluded", "simultaneous_humans",
  "collision_answer_hangup", "unknown_answer_hangup", "one_way_audio_excluded", "first_words_preserved",
  "operator_disconnect", "stop_preserves_conversation", "duplicate_events", "provider_failure_recovery",
  "refresh_no_redial", "dtmf", "consented_recording", "power_manual_regression",
  "realtime_state_delivery",
] as const;

export type ParallelOptions = {
  ringTimeout: number; maxCallSeconds: number; batchDelaySeconds: number; attemptLimit: number;
  sessionSeconds?: number; spendingApproved?: boolean; answerPolicy?: "first_answer" | "confirmed_human";
  maxSpendCents: number; autoContinue: boolean; autoRefill: false; silentRingback: boolean;
};
export const defaultParallelOptions: ParallelOptions = {
  answerPolicy: "first_answer", ringTimeout: 15, maxCallSeconds: 60, sessionSeconds:900, batchDelaySeconds: 2, attemptLimit: 100,
  maxSpendCents: 100, autoContinue: true, autoRefill: false, silentRingback: false,
};

export const cloudflareScenarios = ["cloudflare_four_dispatch", "cloudflare_collision_hangup", "cloudflare_restart_recovery", "cloudflare_alarm_delay", "cloudflare_quota_fail_closed", "cloudflare_rollback_fence"] as const;
export function evidenceBlockers(evidence: Record<string, unknown> | null, backend: "node" | "cloudflare" = "node") {
  if (!evidence) return ["No controlled Telnyx verification report has been installed."];
  const passed = evidence.scenarios as Record<string, unknown> | undefined;
  const missing = controlledScenarios.filter((scenario) => passed?.[scenario] !== true);
  const blockers = missing.map((scenario) => `Controlled test has not passed: ${scenario}`);
  if (evidence.suite !== "portive-parallel-v1" || evidence.passed !== true) blockers.push("Verification suite is incomplete.");
  if (typeof evidence.max_answer_to_audio_ms !== "number" || !Number.isFinite(evidence.max_answer_to_audio_ms) || evidence.max_answer_to_audio_ms < 0 || evidence.max_answer_to_audio_ms > 1500) blockers.push("Answer-to-live-audio latency has not been verified within 1500ms.");
  if (typeof evidence.peak_concurrent_legs !== "number" || !Number.isFinite(evidence.peak_concurrent_legs) || !Number.isInteger(evidence.peak_concurrent_legs) || evidence.peak_concurrent_legs < 5) blockers.push("Controlled report must prove a finite integer peak of at least five concurrent legs.");
  if (!Array.isArray(evidence.provider_call_ids) || evidence.provider_call_ids.length < 4) blockers.push("Verification report lacks controlled provider call identifiers.");
  if (backend === "cloudflare") {
    if (evidence.orchestration_backend !== "cloudflare") blockers.push("Controlled report must verify the Cloudflare orchestration path.");
    for (const scenario of cloudflareScenarios) if (passed?.[scenario] !== true) blockers.push(`Controlled Cloudflare test has not passed: ${scenario}`);
    const latency=evidence.cloudflare_latency as Record<string,unknown>|undefined;
    if (!latency || ["p50_ms","p95_ms","max_ms"].some(key => typeof latency[key] !== "number" || !Number.isFinite(latency[key]) || Number(latency[key]) < 0) || Number(latency.max_ms)>1500 || Number(latency.p50_ms)>Number(latency.p95_ms) || Number(latency.p95_ms)>Number(latency.max_ms)) blockers.push("Measured Cloudflare p50/p95/maximum answer-to-audio latency is required (maximum 1500ms).");
  }
  return blockers;
}
