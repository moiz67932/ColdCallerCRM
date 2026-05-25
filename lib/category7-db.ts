import "server-only";

export type SupabaseRow = Record<string, unknown>;

const MESSAGE_EVENT_STATUSES = new Set(["queued", "sent", "delivered", "failed", "cancelled"]);

export function normalizeWorkflowEventRow(row: SupabaseRow): SupabaseRow {
  const normalized = { ...row };

  if (normalized.event_status === undefined && normalized.status !== undefined) {
    normalized.event_status = normalized.status;
  }

  delete normalized.status;
  return normalized;
}

export function normalizeMessageEventRow(row: SupabaseRow): SupabaseRow {
  const normalized = { ...row };

  if (normalized.to_phone_e164 === undefined && normalized.recipient_phone_e164 !== undefined) {
    normalized.to_phone_e164 = normalized.recipient_phone_e164;
  }

  if (normalized.to_phone === undefined && normalized.to_phone_e164 !== undefined) {
    normalized.to_phone = normalized.to_phone_e164;
  }

  if (typeof normalized.status === "string" && !MESSAGE_EVENT_STATUSES.has(normalized.status)) {
    normalized.provider_status = normalized.provider_status ?? normalized.status;
    normalized.status = "sent";
  }

  delete normalized.recipient_phone_e164;
  return normalized;
}

export function normalizeAppointmentPaymentRow(row: SupabaseRow): SupabaseRow {
  const normalized = { ...row };

  if (normalized.status === undefined && normalized.payment_status !== undefined) {
    normalized.status = normalized.payment_status;
  }

  if (normalized.square_checkout_url === undefined && normalized.square_payment_link_url !== undefined) {
    normalized.square_checkout_url = normalized.square_payment_link_url;
  }

  if (normalized.raw_square_payment === undefined && normalized.raw !== undefined) {
    normalized.raw_square_payment = normalized.raw;
  }

  delete normalized.payment_status;
  delete normalized.square_payment_link_url;
  delete normalized.raw;
  return normalized;
}
