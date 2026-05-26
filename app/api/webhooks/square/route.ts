import { NextRequest } from "next/server";

import {
  extractSquarePaymentIdsFromEvent,
  getSquareWebhookConfig,
  isSquarePaymentUpdatedEvent,
  normalizeSquareWebhookEvent,
  parseSquareWebhookEvent,
  SQUARE_SIGNATURE_HEADER,
  verifySquareWebhookSignature,
} from "@/lib/square/webhooks";
import {
  findExactAvailableSlot,
  searchSquareAvailability,
  createSquareBooking,
} from "@/lib/square/bookings";
import { getOrCreateSquareCustomer } from "@/lib/square/customers";
import { mapSquarePaymentStatus, retrieveSquarePayment } from "@/lib/square/payments";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { logError, logWarn } from "@/lib/logger";
import { buildSquareBookingIdempotencyKey } from "@/lib/appointments/idempotency";
import { insertAppointmentWorkflowEvent } from "@/lib/appointments/workflow-events";
import { insertTelnyxMessageEvent } from "@/lib/appointments/message-events";
import {
  createDebugId,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markConfirmed, markManualReviewNeeded, markPaymentCompleted, markSquareBookingCreated } from "@/lib/appointments/status-machine";
import { sendAppointmentConfirmationWhatsApp, sendManualReviewWhatsApp } from "@/lib/messaging/send-whatsapp";
import { safeParseSquareWebhookEvent } from "@/lib/validation/paid-appointment";
import { failJson, manualReviewJson, okJson, validationFailJson } from "@/lib/api/paid-appointment-response";
import {
  normalizeAppointmentPaymentRow,
  type SupabaseRow,
} from "@/lib/category7-db";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const debugId = createDebugId("square_webhook");
  logWorkflowInfo("square.webhook.request_start", {
    debug_id: debugId,
    operation: "square_webhook",
    step: "request_start",
  });

  const rawBody = await request.text();
  const signatureHeader = request.headers.get(SQUARE_SIGNATURE_HEADER);
  const config = (() => {
    try {
      return getSquareWebhookConfig();
    } catch (error) {
      logError("square.webhook.missing_signature_config", {
        message: error instanceof Error ? error.message : "Unknown Square webhook config error.",
      });
      logWorkflowError("square.webhook.missing_signature_config", {
        debug_id: debugId,
        operation: "square_webhook",
        step: "load_webhook_config",
        error_code: "SQUARE_WEBHOOK_CONFIG_MISSING",
        safe_message: error instanceof Error ? error.message : "Square webhook config missing.",
      });
      return null;
    }
  })();

  if (!config) {
    return failJson(
      {
        errorCode: "SQUARE_WEBHOOK_CONFIG_MISSING",
        step: "load_webhook_config",
        message: "Square webhook signature is not configured.",
        debugId,
      },
      { status: 500 },
    );
  }

  if (!config.notificationUrl) {
    logError("square.webhook.missing_notification_url");
    logWorkflowError("square.webhook.missing_notification_url", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "load_webhook_config",
      status: 500,
      error_code: "SQUARE_WEBHOOK_NOTIFICATION_URL_MISSING",
    });
    return failJson(
      {
        errorCode: "SQUARE_WEBHOOK_NOTIFICATION_URL_MISSING",
        step: "load_webhook_config",
        message: "Square webhook notification URL is not configured.",
        debugId,
      },
      { status: 500 },
    );
  }

  const signatureValid = verifySquareWebhookSignature({
    rawBody,
    signatureHeader,
    notificationUrl: config.notificationUrl,
    signatureKey: config.signatureKey,
  });

  if (!signatureValid) {
    logWarn("square.webhook.invalid_signature");
    logWorkflowError("square.webhook.invalid_signature", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "verify_signature",
      status: 403,
      error_code: "INVALID_SQUARE_SIGNATURE",
      safe_message: "Square webhook signature verification failed.",
    });
    return failJson(
      { errorCode: "INVALID_SQUARE_SIGNATURE", step: "verify_signature", message: "Invalid Square webhook signature.", debugId },
      { status: 403 },
    );
  }

  let event: unknown;

  try {
    event = parseSquareWebhookEvent(rawBody);
  } catch {
    logWorkflowError("square.webhook.invalid_json", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "parse_event",
      status: 400,
      error_code: "INVALID_JSON",
    });
    return failJson(
      {
        errorCode: "VALIDATION_FAILED",
        step: "parse_square_webhook_event",
        message: "Square webhook payload must be valid JSON.",
        debugId,
        safeDetails: { field_errors: [{ field: "body", message: "Invalid JSON payload." }] },
      },
      { status: 400 },
    );
  }

  const parsedWebhookEvent = safeParseSquareWebhookEvent(event);

  if (!parsedWebhookEvent.success) {
    return validationFailJson({
      step: "validate_square_webhook_event",
      message: "Square webhook payload shape is invalid.",
      error: parsedWebhookEvent.error,
      debugId,
    });
  }

  const normalizedEvent = normalizeSquareWebhookEvent(event);
  logWorkflowInfo("square.webhook.event_received", {
    debug_id: debugId,
    operation: "square_webhook",
    step: "event_received",
    event_type: normalizedEvent.eventType,
    payload: {
      event_id: normalizedEvent.eventId,
      merchant_id: normalizedEvent.merchantId,
      data_id: normalizedEvent.dataId,
    },
  });
  const supabase = getSupabaseAdmin();

  if (!isSquarePaymentUpdatedEvent(event)) {
    logWorkflowInfo("square.webhook.ignored_event", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "ignore_event",
      status: 200,
      event_type: normalizedEvent.eventType,
    });
    return okJson(
      { received: true, ignored: true, event_type: normalizedEvent.eventType },
      { step: "square_webhook_ignored", message: "Unhandled Square event ignored.", debugId },
    );
  }

  const ids = extractSquarePaymentIdsFromEvent(event);
  let paymentId = ids.paymentId;
  let orderId = ids.orderId;
  let squareStatus = ids.status;
  let squarePayment = getPaymentFromWebhookEvent(event);

  if (!paymentId && !orderId) {
    logWorkflowInfo("square.webhook.missing_payment_ids", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "extract_payment_ids",
      status: 200,
      error_code: "MISSING_PAYMENT_AND_ORDER_ID",
    });
    return okJson(
      { received: true, ignored: true, event_type: normalizedEvent.eventType, reason: "missing_payment_and_order_id" },
      { step: "square_webhook_ignored", message: "Square payment identifiers missing; event ignored.", debugId },
    );
  }

  if (paymentId && (!orderId || !squareStatus)) {
    squarePayment = await retrievePaymentSafely(paymentId);
    orderId ??= getString(squarePayment, "order_id");
    squareStatus ??= getString(squarePayment, "status");
  }

  let appointmentIntent = orderId ? await findAppointmentIntentByOrderId(supabase, orderId) : null;

  if (!appointmentIntent && paymentId && !squarePayment) {
    squarePayment = await retrievePaymentSafely(paymentId);
    orderId = getString(squarePayment, "order_id");
    squareStatus = getString(squarePayment, "status") ?? squareStatus;
    appointmentIntent = orderId ? await findAppointmentIntentByOrderId(supabase, orderId) : null;
  }

  if (!appointmentIntent) {
    logWarn("square.webhook.appointment_intent_not_found", { paymentId, orderId });
    logWorkflowError("square.webhook.appointment_intent_not_found", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "load_appointment_intent",
      square_payment_id: paymentId,
      square_order_id: orderId,
      status: 200,
      error_code: "APPOINTMENT_INTENT_NOT_FOUND",
    });
    return okJson(
      { received: true, event_type: normalizedEvent.eventType, appointment_intent_found: false },
      { step: "square_webhook_ignored", message: "Appointment intent not found; event ignored.", debugId },
    );
  }

  const appointmentIntentId = requireString(appointmentIntent, "id");

  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_source: "square_webhook",
    event_status: "received",
    message: "Square webhook received.",
    payload: {
      event_id: normalizedEvent.eventId,
      event_type: normalizedEvent.eventType,
      data_id: normalizedEvent.dataId,
    },
    event_type: "square_webhook_received",
  });

  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "payment_updated",
    status: "received",
    payload: { payment_id: paymentId, order_id: orderId, square_status: squareStatus },
  });

  if (getString(appointmentIntent, "payment_status") === "completed" && getString(appointmentIntent, "square_booking_id")) {
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "duplicate_webhook_ignored",
      status: "ignored",
      payload: { payment_id: paymentId, order_id: orderId, square_booking_id: getString(appointmentIntent, "square_booking_id") },
    });
    logWorkflowInfo("square.webhook.idempotent_duplicate", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "idempotency_check",
      appointment_intent_id: appointmentIntentId,
      square_payment_id: paymentId,
      square_order_id: orderId,
      square_booking_id: getString(appointmentIntent, "square_booking_id"),
      status: 200,
    });
    return okJson(
      { received: true, duplicate_or_already_processed: true },
      {
        step: "square_webhook_duplicate_ignored",
        message: "Duplicate event ignored",
        debugId,
        appointmentIntentId,
      },
    );
  }

  if (paymentId && !squarePayment) {
    squarePayment = await retrievePaymentSafely(paymentId);
    orderId ??= getString(squarePayment, "order_id");
    squareStatus ??= getString(squarePayment, "status");
  }

  paymentId ??= getString(squarePayment, "id");
  orderId ??= getString(squarePayment, "order_id");
  squareStatus ??= getString(squarePayment, "status");

  const internalPaymentStatus = mapSquarePaymentStatus(squareStatus);

  if (internalPaymentStatus !== "completed") {
    await persistPaymentStatus(supabase, appointmentIntent, {
      paymentId,
      orderId,
      paymentStatus: internalPaymentStatus,
      rawPayment: squarePayment,
    });

    logWorkflowInfo("square.webhook.payment_status_updated", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "payment_status_updated",
      appointment_intent_id: appointmentIntentId,
      square_payment_id: paymentId,
      square_order_id: orderId,
      status: 200,
      payment_status: internalPaymentStatus,
    });

    return okJson(
      { received: true, event_type: normalizedEvent.eventType, payment_status: internalPaymentStatus },
      { step: "payment_status_updated", message: "Payment status updated.", debugId, appointmentIntentId },
    );
  }

  if (!paymentId) {
    logWorkflowError("square.webhook.completed_payment_missing_id", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "validate_completed_payment",
      appointment_intent_id: appointmentIntentId,
      square_order_id: orderId,
      status: 422,
      error_code: "COMPLETED_PAYMENT_MISSING_ID",
      safe_message: "Completed Square payment webhook did not include a payment ID.",
    });
    return failJson(
      {
        errorCode: "COMPLETED_PAYMENT_MISSING_ID",
        step: "validate_completed_payment",
        message: "Completed Square payment webhook did not include a payment ID.",
        debugId,
        appointmentIntentId,
      },
      { status: 422 },
    );
  }

  const paidAt = new Date();
  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markPaymentCompleted(paidAt),
    square_payment_id: paymentId,
  });
  await persistPaymentStatus(supabase, appointmentIntent, {
    paymentId,
    orderId,
    paymentStatus: "completed",
    rawPayment: squarePayment,
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "payment_completed",
    status: "success",
    payload: { payment_id: paymentId, order_id: orderId },
  });

  try {
    const result = await confirmPaidAppointment(supabase, appointmentIntent, appointmentIntentId);
    logWorkflowInfo("square.webhook.request_complete", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "request_complete",
      appointment_intent_id: appointmentIntentId,
      square_payment_id: paymentId,
      square_order_id: orderId,
      square_booking_id: result.squareBookingId,
      status: 200,
      safe_message: "Square payment webhook processed.",
    });

    return okJson(
      {
        received: true,
        event_type: normalizedEvent.eventType,
        payment_status: "completed",
        appointment_status: result.appointmentStatus,
        square_booking_id: result.squareBookingId,
        manual_review_needed: result.manualReviewNeeded,
        square_booking_action: result.reusedExistingBooking ? "reused" : result.manualReviewNeeded ? "ignored" : "created",
      },
      { step: "square_webhook_processed", message: "Square payment webhook processed.", debugId, appointmentIntentId },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown booking error.";

    logError("square.webhook.confirmation_failed", { appointmentIntentId, message });
    logWorkflowError("square.webhook.confirmation_failed", {
      debug_id: debugId,
      operation: "square_webhook",
      step: "confirm_paid_appointment",
      appointment_intent_id: appointmentIntentId,
      square_payment_id: paymentId,
      square_order_id: orderId,
      error_code: "CONFIRMATION_FAILED",
      safe_message: message,
    });
    await markIntentManualReview(supabase, appointmentIntent, appointmentIntentId, message);

    return manualReviewJson(
      {
        received: true,
        event_type: normalizedEvent.eventType,
        payment_status: "completed",
        appointment_status: "manual_review_needed",
        manual_review_needed: true,
      },
      { debugId, appointmentIntentId, message: "Payment completed but appointment needs manual review." },
    );
  }
}

async function confirmPaidAppointment(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  const existingBookingId = getString(appointmentIntent, "square_booking_id");

  if (existingBookingId) {
    return {
      appointmentStatus: getString(appointmentIntent, "appointment_status") ?? "square_booking_created",
      squareBookingId: existingBookingId,
      manualReviewNeeded: false,
      reusedExistingBooking: true,
    };
  }

  const selectedStartAt = requireString(appointmentIntent, "selected_start_at");
  const durationMinutes = requireNumber(appointmentIntent, "duration_minutes");
  const availability = await searchSquareAvailability({
    locationId: requireString(appointmentIntent, "square_location_id"),
    teamMemberId: requireString(appointmentIntent, "square_team_member_id"),
    serviceVariationId: requireString(appointmentIntent, "square_service_variation_id"),
    startAt: selectedStartAt,
    endAt: addMinutes(selectedStartAt, durationMinutes + 15),
    selectedStartAt,
    timezone: getString(appointmentIntent, "selected_timezone"),
    appointmentIntentId,
  });
  const slot = findExactAvailableSlot({ desiredStartAt: selectedStartAt, availability });

  if (!slot) {
    await markIntentManualReview(supabase, appointmentIntent, appointmentIntentId, "Slot unavailable after payment");
    return {
      appointmentStatus: "manual_review_needed",
      squareBookingId: null,
      manualReviewNeeded: true,
    };
  }

  const customer = await getOrCreateSquareCustomer({
    fullName: getString(appointmentIntent, "caller_name") ?? undefined,
    phoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
    email: getString(appointmentIntent, "caller_email") ?? undefined,
    appointmentIntentId,
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
    customerNote: getString(appointmentIntent, "notes") ?? getRawBookingNotes(appointmentIntent),
    idempotencyKey: buildSquareBookingIdempotencyKey(appointmentIntentId),
  });
  const now = new Date();

  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markSquareBookingCreated(),
    square_booking_id: booking.bookingId,
    square_customer_id: customer.customerId,
    square_booking_created_at: now.toISOString(),
  });
  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markConfirmed(now),
  });

  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "square_booking_created",
    status: "success",
    payload: { square_booking_id: booking.bookingId, square_customer_id: customer.customerId },
  });

  await sendConfirmationMessageSafely(supabase, appointmentIntent, appointmentIntentId);

  return {
    appointmentStatus: "confirmed",
    squareBookingId: booking.bookingId,
    manualReviewNeeded: false,
    reusedExistingBooking: false,
  };
}

async function markIntentManualReview(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
  lastError: string,
) {
  await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markManualReviewNeeded(),
    last_error: lastError,
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "manual_review_needed",
    status: "failed",
    payload: { message: lastError },
  });
  await sendManualReviewMessageSafely(supabase, appointmentIntent, appointmentIntentId);
}

async function sendConfirmationMessageSafely(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  try {
    const message = await sendAppointmentConfirmationWhatsApp({
      appointmentIntentId,
      toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
      patientName: requireString(appointmentIntent, "caller_name"),
      serviceName: requireString(appointmentIntent, "service_name"),
      clinicName: getString(appointmentIntent, "clinic_name") ?? "the clinic",
      selectedTimeDisplay: getString(appointmentIntent, "selected_time_display") ?? requireString(appointmentIntent, "selected_start_at"),
    });

    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
        messageType: "appointment_confirmation",
        providerMessageId: message.providerMessageId,
        status: "sent",
        payload: {
          provider_response: message.raw,
          telnyx_status: message.status,
        },
      },
      {
        operation: "square_webhook",
        failureEventName: "square.webhook.message_event_insert_failed",
      },
    );
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "whatsapp_sent",
      status: "success",
      payload: { message_type: "appointment_confirmation", provider: "telnyx", provider_message_id: message.providerMessageId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown message error.";
    logWarn("square.webhook.confirmation_message_failed", {
      appointmentIntentId,
      message,
    });
    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
        messageType: "appointment_confirmation",
        status: "failed",
        error,
      },
      {
        operation: "square_webhook",
        failureEventName: "square.webhook.message_event_insert_failed",
      },
    );
    await safeUpdateLastError(supabase, appointmentIntentId, message);
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "confirmation_message_failed", message },
    });
  }
}

async function sendManualReviewMessageSafely(
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
      selectedTimeDisplay: getString(appointmentIntent, "selected_time_display") ?? undefined,
    });

    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
        messageType: "manual_review",
        providerMessageId: message.providerMessageId,
        status: "sent",
        payload: {
          provider_response: message.raw,
          telnyx_status: message.status,
        },
      },
      {
        operation: "square_webhook",
        failureEventName: "square.webhook.message_event_insert_failed",
      },
    );
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "whatsapp_sent",
      status: "success",
      payload: { message_type: "manual_review", provider: "telnyx", provider_message_id: message.providerMessageId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown message error.";
    logWarn("square.webhook.manual_review_message_failed", {
      appointmentIntentId,
      message,
    });
    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone"),
        messageType: "manual_review",
        status: "failed",
        error,
      },
      {
        operation: "square_webhook",
        failureEventName: "square.webhook.message_event_insert_failed",
      },
    );
    await safeUpdateLastError(supabase, appointmentIntentId, message);
  }
}

async function findAppointmentIntentByOrderId(supabase: ReturnType<typeof getSupabaseAdmin>, orderId: string) {
  const { data, error } = await supabase.from("appointment_intents").select("*").eq("square_order_id", orderId).limit(1).maybeSingle();

  if (error) {
    logWarn("square.webhook.intent_lookup_failed", { message: error.message });
    return null;
  }

  return data as SupabaseRow | null;
}

async function retrievePaymentSafely(paymentId: string | null) {
  if (!paymentId) {
    return null;
  }

  try {
    const response = await retrieveSquarePayment(paymentId);
    return isRecord(response.payment) ? response.payment : null;
  } catch (error) {
    logWarn("square.webhook.retrieve_payment_failed", {
      paymentId,
      message: error instanceof Error ? error.message : "Unknown Square payment lookup error.",
    });
    return null;
  }
}

async function persistPaymentStatus(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  input: { paymentId: string | null; orderId: string | null; paymentStatus: string; rawPayment: SupabaseRow | null },
) {
  const appointmentIntentId = requireString(appointmentIntent, "id");

  await updateAppointmentIntent(supabase, appointmentIntentId, {
    payment_status: input.paymentStatus,
    square_payment_id: input.paymentId,
  });
  await upsertAppointmentPayment(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    clinic_id: getString(appointmentIntent, "clinic_id"),
    appointment_intent_id: appointmentIntentId,
    provider: "square",
    square_payment_id: input.paymentId,
    square_order_id: input.orderId ?? getString(appointmentIntent, "square_order_id"),
    square_payment_link_id: getString(appointmentIntent, "square_payment_link_id"),
    square_payment_link_url: getString(appointmentIntent, "square_payment_link_url"),
    amount_cents: getNumber(appointmentIntent, "deposit_amount_cents"),
    currency: getString(appointmentIntent, "currency"),
    payment_status: input.paymentStatus,
    raw: input.rawPayment,
  });
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

async function safeUpdateLastError(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  lastError: string,
) {
  const { error } = await supabase.from("appointment_intents").update({ last_error: lastError }).eq("id", appointmentIntentId);

  if (error) {
    logWarn("square.webhook.last_error_update_failed", { message: error.message });
  }
}

async function upsertAppointmentPayment(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  const normalizedRow = normalizeAppointmentPaymentRow(row);
  const paymentId = getString(normalizedRow, "square_payment_id");
  const appointmentIntentId = getString(normalizedRow, "appointment_intent_id");
  const orderId = getString(normalizedRow, "square_order_id");

  if (!paymentId) {
    const fallbackConflictKey = "appointment_intent_id,square_order_id";

    if (appointmentIntentId && orderId) {
      const { data: existing, error: lookupError } = await supabase
        .from("appointment_payments")
        .select("id")
        .eq("appointment_intent_id", appointmentIntentId)
        .eq("square_order_id", orderId)
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        logWarn("square.webhook.payment_lookup_failed", { message: lookupError.message });
        return;
      }

      const existingId = getString(existing, "id");

      if (existingId) {
        const { error } = await supabase.from("appointment_payments").update(normalizedRow).eq("id", existingId);

        if (error) {
          logWarn("square.webhook.payment_update_failed", { message: error.message });
          return;
        }

        logAppointmentPaymentUpsertSuccess(normalizedRow, fallbackConflictKey, "update");
        return;
      }
    }

    const { error } = await supabase.from("appointment_payments").insert(normalizedRow);

    if (error) {
      logWarn("square.webhook.payment_insert_failed", { message: error.message });
      return;
    }

    logAppointmentPaymentUpsertSuccess(normalizedRow, "none", "insert");
    return;
  }

  const conflictKey = "square_payment_id";
  const { data: existing, error: lookupError } = await supabase
    .from("appointment_payments")
    .select("id")
    .eq("square_payment_id", paymentId)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    logWarn("square.webhook.payment_lookup_failed", { message: lookupError.message });
    return;
  }

  const existingId = getString(existing, "id");

  if (existingId) {
    const { error } = await supabase.from("appointment_payments").update(normalizedRow).eq("id", existingId);

    if (error) {
      logWarn("square.webhook.payment_update_failed", { message: error.message });
      return;
    }

    logAppointmentPaymentUpsertSuccess(normalizedRow, conflictKey, "update");
    return;
  }

  const { error } = await supabase.from("appointment_payments").insert(normalizedRow);

  if (error) {
    if (isUniqueViolation(error)) {
      const { error: updateError } = await supabase.from("appointment_payments").update(normalizedRow).eq("square_payment_id", paymentId);

      if (updateError) {
        logWarn("square.webhook.payment_update_after_conflict_failed", { message: updateError.message });
        return;
      }

      logAppointmentPaymentUpsertSuccess(normalizedRow, conflictKey, "update_after_conflict");
      return;
    }

    logWarn("square.webhook.payment_insert_failed", { message: error.message });
    return;
  }

  logAppointmentPaymentUpsertSuccess(normalizedRow, conflictKey, "insert");
}

function logAppointmentPaymentUpsertSuccess(row: SupabaseRow, conflictKey: string, action: string) {
  logWorkflowInfo("appointment_payment.upsert_success", {
    operation: "square_webhook",
    step: "upsert_appointment_payment",
    appointment_intent_id: getString(row, "appointment_intent_id"),
    square_payment_id: getString(row, "square_payment_id"),
    square_order_id: getString(row, "square_order_id"),
    conflict_key: conflictKey,
    action,
  });
}

function isUniqueViolation(error: { code?: string | null; message?: string | null }) {
  return error.code === "23505" || /duplicate key/i.test(error.message ?? "");
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  await insertAppointmentWorkflowEvent(supabase, row, {
    operation: "square_webhook",
    failureEventName: "square.webhook.workflow_event_insert_failed",
  });
}

function getPaymentFromWebhookEvent(event: unknown) {
  if (!isRecord(event)) return null;
  const data = event.data;
  if (!isRecord(data)) return null;
  const object = data.object;
  if (!isRecord(object)) return null;
  const payment = object.payment;
  return isRecord(payment) ? payment : null;
}

function addMinutes(isoDate: string, minutes: number) {
  return new Date(new Date(isoDate).getTime() + minutes * 60_000).toISOString();
}

function getRawBookingNotes(row: SupabaseRow) {
  const raw = row.raw_booking_details;

  if (isRecord(raw) && typeof raw.notes === "string") {
    return raw.notes;
  }

  return undefined;
}

function requireString(row: SupabaseRow, key: string) {
  const value = getString(row, key);

  if (!value) {
    throw new Error(`appointment_intents.${key} is required.`);
  }

  return value;
}

function getString(row: unknown, key: string) {
  if (!isRecord(row)) return null;
  const value = row[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireNumber(row: SupabaseRow, key: string) {
  const value = getNumber(row, key);

  if (value === null) {
    throw new Error(`appointment_intents.${key} must be numeric.`);
  }

  return value;
}

function getNumber(row: SupabaseRow, key: string) {
  const value = Number(row[key]);

  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is SupabaseRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
