import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { okJson, failJson } from "@/lib/api/paid-appointment-response";
import { formatAppointmentDateTimeForMessage, getAppointmentTimeZone } from "@/lib/appointments/appointment-time-format";
import { buildSquareBookingIdempotencyKey } from "@/lib/appointments/idempotency";
import { insertTelnyxMessageEvent } from "@/lib/appointments/message-events";
import { markConfirmed, markManualReviewNeeded, markSquareBookingCreated } from "@/lib/appointments/status-machine";
import { insertAppointmentWorkflowEvent } from "@/lib/appointments/workflow-events";
import { type SupabaseRow } from "@/lib/category7-db";
import { createDebugId, logWorkflowError, logWorkflowInfo } from "@/lib/logging/workflow-logger";
import { sendAppointmentConfirmationWhatsApp, sendManualReviewWhatsApp } from "@/lib/messaging/send-whatsapp";
import { createSquareBooking, findExactAvailableSlot, searchSquareAvailability } from "@/lib/square/bookings";
import { SquareApiError } from "@/lib/square/client";
import { getOrCreateSquareCustomer } from "@/lib/square/customers";
import { extractSquareErrors } from "@/lib/square/error-details";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { AppointmentIntentIdSchema } from "@/lib/validation/paid-appointment";

export const runtime = "nodejs";

const SQUARE_AVAILABILITY_TIMEOUT_MS = 8_000;
const SQUARE_CUSTOMER_TIMEOUT_MS = 8_000;
const SQUARE_CREATE_BOOKING_TIMEOUT_MS = 10_000;

export async function POST(request: NextRequest) {
  const debugId = createDebugId("retry_square_booking");
  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const parsedId = AppointmentIntentIdSchema.safeParse(getString(body, "appointment_intent_id"));

  if (!parsedId.success) {
    return failJson(
      { errorCode: "INVALID_APPOINTMENT_INTENT_ID", step: "validate_request", message: "appointment_intent_id must be a UUID.", debugId },
      { status: 400 },
    );
  }

  const appointmentIntentId = parsedId.data;
  const supabase = getSupabaseAdmin();
  const appointmentIntent = await loadAppointmentIntent(supabase, appointmentIntentId);

  if (!appointmentIntent) {
    return failJson(
      { errorCode: "APPOINTMENT_INTENT_NOT_FOUND", step: "load_appointment_intent", message: "Appointment intent not found.", debugId },
      { status: 404 },
    );
  }

  if (getString(appointmentIntent, "payment_status") !== "completed" || getString(appointmentIntent, "square_booking_id")) {
    return failJson(
      {
        errorCode: "NOT_RETRYABLE",
        step: "validate_retry_state",
        message: "Only completed paid intents without a Square booking can be retried.",
        debugId,
        appointmentIntentId,
      },
      { status: 409 },
    );
  }

  const bookingStatus = getString(appointmentIntent, "booking_status");

  if (bookingStatus && !["booking_failed", "creating_booking", "failed"].includes(bookingStatus)) {
    return failJson(
      { errorCode: "NOT_RETRYABLE", step: "validate_retry_state", message: `booking_status ${bookingStatus} is not retryable.`, debugId, appointmentIntentId },
      { status: 409 },
    );
  }

  try {
    const result = await retrySquareBooking(supabase, appointmentIntent, appointmentIntentId);
    return okJson(
      {
        appointment_status: result.appointmentStatus,
        square_booking_id: result.squareBookingId,
        manual_review_needed: result.manualReviewNeeded,
      },
      { step: "retry_square_booking_complete", message: "Square booking retry completed.", debugId, appointmentIntentId },
    );
  } catch (error) {
    const details = getSafeBookingErrorDetails(error);
    await finalizeBookingFailedAfterPayment(supabase, appointmentIntent, appointmentIntentId, error);
    return okJson(
      {
        appointment_status: "manual_review_needed",
        manual_review_needed: true,
        error_code: details.code,
        message: details.message,
      },
      { step: "retry_square_booking_failed", message: "Square booking retry failed and was moved to manual review.", debugId, appointmentIntentId },
    );
  }
}

async function retrySquareBooking(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  const bookingIdempotencyKey = buildSquareBookingIdempotencyKey(appointmentIntentId);
  const selectedStartAt = requireString(appointmentIntent, "selected_start_at");
  const durationMinutes = requireNumber(appointmentIntent, "duration_minutes");
  const locationId = requireString(appointmentIntent, "square_location_id");
  const teamMemberId = requireString(appointmentIntent, "square_team_member_id");
  const serviceVariationId = requireString(appointmentIntent, "square_service_variation_id");

  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    booking_status: "creating_booking",
    last_error: null,
    last_error_code: null,
    last_booking_attempt_at: new Date().toISOString(),
    booking_attempt_count: (getNumber(appointmentIntent, "booking_attempt_count") ?? 0) + 1,
  });

  logWorkflowInfo("admin.retry_square_booking.started", {
    operation: "retry_square_booking",
    step: "retry_square_booking",
    appointment_intent_id: appointmentIntentId,
    selected_start_at: selectedStartAt,
    selected_timezone: getString(appointmentIntent, "selected_timezone"),
    selected_time_display: getString(appointmentIntent, "selected_time_display"),
    location_id: locationId,
    team_member_id: teamMemberId,
    service_variation_id: serviceVariationId,
    square_booking_idempotency_key: bookingIdempotencyKey,
  });

  const availability = await searchSquareAvailability({
    locationId,
    teamMemberId,
    serviceVariationId,
    startAt: selectedStartAt,
    endAt: addMinutes(selectedStartAt, durationMinutes + 15),
    selectedStartAt,
    timezone: getString(appointmentIntent, "selected_timezone"),
    appointmentIntentId,
    timeoutMs: SQUARE_AVAILABILITY_TIMEOUT_MS,
  });
  const slot = findExactAvailableSlot({ desiredStartAt: selectedStartAt, availability });

  if (!slot) {
    throw new Error("Slot unavailable after payment");
  }

  const customer = await getOrCreateSquareCustomer({
    fullName: getString(appointmentIntent, "caller_name") ?? undefined,
    phoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
    email: getString(appointmentIntent, "caller_email") ?? undefined,
    appointmentIntentId,
    timeoutMs: SQUARE_CUSTOMER_TIMEOUT_MS,
  });

  const booking = await createSquareBooking({
    appointmentIntentId,
    locationId: slot.locationId,
    customerId: customer.customerId,
    startAt: selectedStartAt,
    teamMemberId: slot.teamMemberId,
    serviceVariationId: slot.serviceVariationId,
    serviceVariationVersion: slot.serviceVariationVersion,
    durationMinutes: slot.durationMinutes,
    customerNote: getString(appointmentIntent, "notes") ?? undefined,
    idempotencyKey: bookingIdempotencyKey,
    timeoutMs: SQUARE_CREATE_BOOKING_TIMEOUT_MS,
  });
  const now = new Date();

  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markSquareBookingCreated(),
    square_booking_id: booking.bookingId,
    square_customer_id: customer.customerId,
    square_booking_created_at: now.toISOString(),
    booking_status: "created",
    last_error: null,
    last_error_code: null,
  });
  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markConfirmed(now),
    last_error: null,
    last_error_code: null,
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "square_booking_created",
    status: "success",
    payload: { square_booking_id: booking.bookingId, square_customer_id: customer.customerId, source: "admin_retry" },
  });
  await sendConfirmationMessage(supabase, appointmentIntent, appointmentIntentId);

  return {
    appointmentStatus: "confirmed",
    squareBookingId: booking.bookingId,
    manualReviewNeeded: false,
  };
}

async function finalizeBookingFailedAfterPayment(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
  error: unknown,
) {
  const details = getSafeBookingErrorDetails(error);

  logWorkflowError("admin.retry_square_booking.failed", {
    operation: "retry_square_booking",
    step: "booking_failed_after_payment",
    appointment_intent_id: appointmentIntentId,
    error_code: details.code,
    safe_message: details.message,
    square_status: details.squareStatus,
    square_errors: details.squareErrors,
  });
  await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markManualReviewNeeded(),
    booking_status: "booking_failed",
    last_error: details.message,
    last_error_code: details.code,
    updated_at: new Date().toISOString(),
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "booking_failed_after_payment",
    status: "failed",
    message: details.message,
    error_message: details.message,
    payload: { error_code: details.code, square_status: details.squareStatus, square_errors: details.squareErrors, source: "admin_retry" },
  });
  await sendManualReviewMessage(supabase, appointmentIntent, appointmentIntentId);
}

async function sendConfirmationMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  const message = await sendAppointmentConfirmationWhatsApp({
    appointmentIntentId,
    toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
    patientName: requireString(appointmentIntent, "caller_name"),
    serviceName: requireString(appointmentIntent, "service_name"),
    clinicName: getString(appointmentIntent, "clinic_name") ?? "the clinic",
    selectedTimeDisplay: formatAppointmentTimeForMessage(appointmentIntent, appointmentIntentId, "send_confirmation_whatsapp"),
  });

  await insertTelnyxMessageEvent(supabase, {
    organizationId: getString(appointmentIntent, "organization_id"),
    appointmentIntentId,
    appointmentIntent,
    toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
    messageType: "appointment_confirmation",
    providerMessageId: message.providerMessageId,
    status: "sent",
    payload: { provider_response: message.raw, telnyx_status: message.status },
  }, { operation: "retry_square_booking", failureEventName: "admin.retry_square_booking.message_event_insert_failed" });
}

async function sendManualReviewMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  try {
    const message = await sendManualReviewWhatsApp({
      appointmentIntentId,
      toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
      patientName: requireString(appointmentIntent, "caller_name"),
      serviceName: requireString(appointmentIntent, "service_name"),
      clinicName: getString(appointmentIntent, "clinic_name") ?? "the clinic",
      selectedTimeDisplay: formatAppointmentTimeForMessage(appointmentIntent, appointmentIntentId, "send_manual_review_whatsapp"),
    });

    await insertTelnyxMessageEvent(supabase, {
      organizationId: getString(appointmentIntent, "organization_id"),
      appointmentIntentId,
      appointmentIntent,
      toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
      messageType: "manual_review",
      providerMessageId: message.providerMessageId,
      status: "sent",
      payload: { provider_response: message.raw, telnyx_status: message.status },
    }, { operation: "retry_square_booking", failureEventName: "admin.retry_square_booking.message_event_insert_failed" });
  } catch {
    // The retry endpoint must still leave the appointment in manual review even if the fallback message fails.
  }
}

async function loadAppointmentIntent(supabase: ReturnType<typeof getSupabaseAdmin>, appointmentIntentId: string) {
  const { data, error } = await supabase.from("appointment_intents").select("*").eq("id", appointmentIntentId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load appointment intent: ${error.message}`);
  }

  return data as SupabaseRow | null;
}

async function updateAppointmentIntent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  patch: SupabaseRow,
) {
  const { data, error } = await supabase.from("appointment_intents").update(patch).eq("id", appointmentIntentId).select("*").single();

  if (error) {
    throw new Error(`Failed to update appointment intent: ${error.message}`);
  }

  return data as SupabaseRow;
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  await insertAppointmentWorkflowEvent(supabase, row, {
    operation: "retry_square_booking",
    failureEventName: "admin.retry_square_booking.workflow_event_insert_failed",
  });
}

function getSafeBookingErrorDetails(error: unknown) {
  const squareErrors = error instanceof SquareApiError ? extractSquareErrors(error.errorBody) : undefined;
  const firstSquareError = squareErrors?.[0];
  const isTimeout = error instanceof Error && (error.name === "AbortError" || /timed out|timeout/i.test(error.message));

  if (isTimeout) {
    return {
      code: "SQUARE_BOOKING_TIMEOUT",
      message: "Square booking request timed out",
      squareStatus: error instanceof SquareApiError ? error.status : undefined,
      squareErrors,
    };
  }

  return {
    code: firstSquareError?.code ?? (error instanceof SquareApiError ? "SQUARE_API_ERROR" : "BOOKING_FAILED_AFTER_PAYMENT"),
    message: error instanceof Error ? error.message : "Booking failed after payment.",
    squareStatus: error instanceof SquareApiError ? error.status : undefined,
    squareErrors,
  };
}

function formatAppointmentTimeForMessage(appointmentIntent: SupabaseRow, appointmentIntentId: string, step: string) {
  return formatAppointmentDateTimeForMessage({
    selectedStartAt: getString(appointmentIntent, "selected_start_at"),
    selectedTimeDisplay: getString(appointmentIntent, "selected_time_display"),
    timeZone: getAppointmentTimeZone(appointmentIntent),
    appointmentIntentId,
    operation: "retry_square_booking",
    step,
  });
}

function addMinutes(isoDate: string, minutes: number) {
  return new Date(new Date(isoDate).getTime() + minutes * 60_000).toISOString();
}

function requireString(row: SupabaseRow, key: string) {
  const value = getString(row, key);

  if (!value) {
    throw new Error(`appointment_intents.${key} is required.`);
  }

  return value;
}

function requireNumber(row: SupabaseRow, key: string) {
  const value = getNumber(row, key);

  if (value === null) {
    throw new Error(`appointment_intents.${key} must be numeric.`);
  }

  return value;
}

function getString(row: unknown, key: string) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const value = (row as Record<string, unknown>)[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(row: SupabaseRow, key: string) {
  const value = Number(row[key]);

  return Number.isFinite(value) ? value : null;
}
