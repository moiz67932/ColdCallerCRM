export const controlledScenarios = [
  "four_concurrent_ringing", "first_human_bridge", "machine_excluded", "simultaneous_humans",
  "collision_answer_hangup", "unknown_answer_hangup", "one_way_audio_excluded", "first_words_preserved",
  "operator_disconnect", "stop_preserves_conversation", "duplicate_events", "provider_failure_recovery",
  "refresh_no_redial", "dtmf", "consented_recording", "power_manual_regression",
  "realtime_state_delivery",
] as const;

export type ParallelOptions = {
  ringTimeout: number; maxCallSeconds: number; batchDelaySeconds: number; attemptLimit: number;
  maxSpendCents: number; autoContinue: boolean; autoRefill: false; silentRingback: boolean;
};
export const defaultParallelOptions: ParallelOptions = {
  ringTimeout: 30, maxCallSeconds: 300, batchDelaySeconds: 2, attemptLimit: 100,
  maxSpendCents: 5000, autoContinue: true, autoRefill: false, silentRingback: false,
};

export function evidenceBlockers(evidence: Record<string, unknown> | null) {
  if (!evidence) return ["No controlled Telnyx verification report has been installed."];
  const passed = evidence.scenarios as Record<string, unknown> | undefined;
  const missing = controlledScenarios.filter((scenario) => passed?.[scenario] !== true);
  const blockers = missing.map((scenario) => `Controlled test has not passed: ${scenario}`);
  if (evidence.suite !== "portive-parallel-v1" || evidence.passed !== true) blockers.push("Verification suite is incomplete.");
  if (typeof evidence.max_answer_to_audio_ms !== "number" || evidence.max_answer_to_audio_ms > 1500) blockers.push("Answer-to-live-audio latency has not been verified within 1500ms.");
  if (!Array.isArray(evidence.provider_call_ids) || evidence.provider_call_ids.length < 4) blockers.push("Verification report lacks controlled provider call identifiers.");
  return blockers;
}
