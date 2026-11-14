export function historyOutcomeLabel(call: { outcome?: string | null; status: string; answeredAt?: unknown; technicalState?: string | null }) {
  if (call.outcome) return call.outcome;
  if (call.status === "voicemail_detected") return "voicemail";
  if (call.status === "canceled" && call.answeredAt) return "completed";
  return call.technicalState ?? call.status;
}

export function historyNote(call: {
  operatorNotes?: string | null;
  notes?: Array<{ body?: string | null }>;
  lead: { notes?: string | null };
}) {
  return call.operatorNotes?.trim() || call.notes?.find((note) => note.body?.trim())?.body?.trim() || call.lead.notes?.trim() || "-";
}
