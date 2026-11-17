// Premium AMD reports human as soon as it can classify the greeting. Bound the
// provider analysis at 5s; SQL allows 3s for authenticated webhook delivery.
export const AMD_ANALYSIS_MS = 5000;
export const AMD_DEADLINE_MS = 8000;
export const premiumAmd = {
  answering_machine_detection: 'premium' as const,
  answering_machine_detection_config: { total_analysis_time_millis: AMD_ANALYSIS_MS },
};

// Existing sessions without an explicit policy retain their AMD behavior.
export function prospectAnswerOptions(options: { answerPolicy?: unknown }) {
  return options.answerPolicy === "first_answer" ? {} : premiumAmd;
}
