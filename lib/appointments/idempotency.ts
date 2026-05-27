import "server-only";

import crypto from "crypto";

const SQUARE_IDEMPOTENCY_MAX_LENGTH = 192;

export type TelnyxMessageType = "payment_link" | "confirmation" | "reminder" | "manual_review" | string;

export function buildPaymentLinkIdempotencyKey(appointmentIntentId: string) {
  return buildStableKey(`appointment_intent:${normalizeAppointmentIntentId(appointmentIntentId)}:payment_link:v1`);
}

export function buildSquareBookingIdempotencyKey(appointmentIntentId: string) {
  return buildStableKey(`booking_${normalizeAppointmentIntentId(appointmentIntentId)}`);
}

export function buildTelnyxMessageIdempotencyKey(appointmentIntentId: string, messageType: TelnyxMessageType) {
  const normalizedMessageType = messageType.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");

  if (!normalizedMessageType) {
    throw new Error("Missing message type for Telnyx idempotency key.");
  }

  return buildStableKey(`appointment_intent:${normalizeAppointmentIntentId(appointmentIntentId)}:whatsapp_${normalizedMessageType}:v1`);
}

function normalizeAppointmentIntentId(appointmentIntentId: string) {
  const trimmed = appointmentIntentId.trim();

  if (!trimmed) {
    throw new Error("Missing appointment intent ID for idempotency key.");
  }

  return trimmed;
}

function buildStableKey(key: string) {
  if (key.length <= SQUARE_IDEMPOTENCY_MAX_LENGTH) {
    return key;
  }

  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${key.slice(0, SQUARE_IDEMPOTENCY_MAX_LENGTH - digest.length - 1)}:${digest}`;
}
