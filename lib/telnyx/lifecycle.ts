import type { CallStatus } from "@/lib/db-types";

export type AnswerClassification = "human" | "machine" | "unknown";

export function classifyAnswer(result?: string | null): AnswerClassification {
  if (["human", "human_business", "human_residence"].includes(result ?? "")) return "human";
  if (["machine", "beep_detected"].includes(result ?? "")) return "machine";
  return "unknown";
}

// Browser hangup is a user action, not evidence that a conversation never happened.
export function resolveClientStatus(
  attempt: { status: CallStatus; answeredAt?: unknown; endedAt?: unknown },
  requested: "connected" | "failed" | "canceled",
): CallStatus {
  if (attempt.endedAt || attempt.status === "voicemail_detected") return attempt.status;
  if (requested === "connected") return "connected";
  if (attempt.answeredAt || attempt.status === "connected") return "completed";
  return requested;
}

