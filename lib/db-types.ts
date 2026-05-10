export const LeadDerivedStatus = {
  new: "new",
  contacted: "contacted",
  follow_up: "follow_up",
  interested: "interested",
  closed_lost: "closed_lost",
  bad_number: "bad_number",
  demo_requested: "demo_requested",
} as const;

export type LeadDerivedStatus = (typeof LeadDerivedStatus)[keyof typeof LeadDerivedStatus];

export const CallStatus = {
  dialing: "dialing",
  connected: "connected",
  voicemail_detected: "voicemail_detected",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
} as const;

export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export const CallOutcome = {
  answered: "answered",
  voicemail: "voicemail",
  no_answer: "no_answer",
  not_interested: "not_interested",
  callback: "callback",
  gatekeeper: "gatekeeper",
  bad_number: "bad_number",
  interested: "interested",
  demo_requested: "demo_requested",
} as const;

export type CallOutcome = (typeof CallOutcome)[keyof typeof CallOutcome];

export const TranscriptStatus = {
  pending: "pending",
  completed: "completed",
  failed: "failed",
} as const;

export type TranscriptStatus = (typeof TranscriptStatus)[keyof typeof TranscriptStatus];

export const ElevenLabsDemoBindingStatus = {
  active: "active",
  inactive: "inactive",
  expired: "expired",
  replaced: "replaced",
  failed: "failed",
} as const;

export type ElevenLabsDemoBindingStatus = (typeof ElevenLabsDemoBindingStatus)[keyof typeof ElevenLabsDemoBindingStatus];

export type JsonObject = Record<string, unknown>;
export type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;
