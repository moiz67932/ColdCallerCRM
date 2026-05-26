import { NextRequest } from "next/server";
import { ZodError } from "zod";

import { createSquareBooking, findExactAvailableSlot, searchSquareAvailability } from "@/lib/square/bookings";
import { getOrCreateSquareCustomer } from "@/lib/square/customers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { logError, logWarn } from "@/lib/logger";
import { formatAppointmentDateTimeForMessage, getAppointmentTimeZone } from "@/lib/appointments/appointment-time-format";
import { buildSquareBookingIdempotencyKey } from "@/lib/appointments/idempotency";
import { insertAppointmentWorkflowEvent } from "@/lib/appointments/workflow-events";
import { insertTelnyxMessageEvent } from "@/lib/appointments/message-events";
import { failJson, okJson, validationFailJson, manualReviewJson } from "@/lib/api/paid-appointment-response";
import {
  createDebugId,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markConfirmed, markManualReviewNeeded, markSquareBookingCreated } from "@/lib/appointments/status-machine";
import { requireApiAuth } from "@/lib/api-auth";
import { sendAppointmentConfirmationWhatsApp } from "@/lib/messaging/send-whatsapp";
import {
  AppointmentIdParamSchema,
  ManualConfirmSchema,
  type ManualConfirmInput,
} from "@/lib/validation/paid-appointment";
import {
  type SupabaseRow,
} from "@/lib/category7-db";

export const runtime = "nodejs";

function routeError(errorCode: string, step: string, message: string, status = 400) {
  return failJson({ errorCode, step, message }, { status });
}

function validationError(step: string, error: unknown) {
  return validationFailJson({
    step,
    error: error instanceof ZodError ? error : undefined,
    message: step === "validate_id" ? "Appointment intent id must be a valid UUID." : "Missing or invalid request body.",
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const debugId = createDebugId("manual_confirm");
  logWorkflowInfo("appointments.manual_confirm.request_start", {
    debug_id: debugId,
    operation: "manual_confirm",
    step: "request_start",
  });

  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    logWorkflowError("appointments.manual_confirm.unauthorized", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "authorize",
      error_code: "UNAUTHORIZED",
      status: 401,
    });
    return authError;
  }

  const parsedParams = AppointmentIdParamSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    logWorkflowError("appointments.manual_confirm.invalid_id", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "validate_id",
      error_code: "INVALID_APPOINTMENT_ID",
      status: 400,
    });
    return validationError("validate_id", parsedParams.error);
  }
  const appointmentIntentId = parsedParams.data.id;

  let input: ManualConfirmInput;

  try {
    input = ManualConfirmSchema.parse(await request.json());
  } catch (error) {
    logWorkflowError("appointments.manual_confirm.invalid_request", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "validate_request",
      appointment_intent_id: appointmentIntentId,
      error_code: "INVALID_REQUEST",
      status: 400,
    });
    return validationError("validate_request", error);
  }

  const supabase = getSupabaseAdmin();
  let appointmentIntent: SupabaseRow | null;

  try {
    appointmentIntent = await loadAppointmentIntent(supabase, appointmentIntentId);
  } catch (error) {
    logError("appointments.manual_confirm.load_failed", {
      appointmentIntentId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    logWorkflowError("appointments.manual_confirm.load_failed", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "load_appointment_intent",
      appointment_intent_id: appointmentIntentId,
      error_code: "APPOINTMENT_LOAD_FAILED",
      safe_message: error instanceof Error ? error.message : "Unable to load appointment intent.",
    });
    return routeError("APPOINTMENT_LOAD_FAILED", "load_appointment_intent", "Unable to load appointment intent.", 500);
  }

  if (!appointmentIntent) {
    logWorkflowError("appointments.manual_confirm.not_found", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "load_appointment_intent",
      appointment_intent_id: appointmentIntentId,
      error_code: "APPOINTMENT_NOT_FOUND",
      status: 404,
    });
    return routeError(
      "APPOINTMENT_NOT_FOUND",
      "load_appointment_intent",
      "No appointment intent found for this id.",
      404,
    );
  }

  if (getString(appointmentIntent, "appointment_status") === "confirmed") {
    logWorkflowInfo("appointments.manual_confirm.idempotent_confirmed", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "validate_current_status",
      appointment_intent_id: appointmentIntentId,
      square_booking_id: getString(appointmentIntent, "square_booking_id"),
      status: 200,
    });
    return okJson(
      {
        appointment_status: "confirmed",
        square_booking_id: getString(appointmentIntent, "square_booking_id"),
        square_booking_action: getString(appointmentIntent, "square_booking_id") ? "reused" : "ignored",
        confirmation_sent: false,
        duplicate_or_already_processed: true,
      },
      { step: "already_confirmed", message: "Appointment already confirmed.", debugId, appointmentIntentId },
    );
  }

  // Demo/admin-only escape hatch: this same explicit override also allows
  // manual confirmation before payment completion for operator testing.
  if (getString(appointmentIntent, "payment_status") !== "completed" && !input.override_slot_unavailable) {
    logWorkflowError("appointments.manual_confirm.payment_not_completed", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "validate_payment_status",
      appointment_intent_id: appointmentIntentId,
      error_code: "PAYMENT_NOT_COMPLETED",
      status: 400,
    });
    return routeError(
      "PAYMENT_NOT_COMPLETED",
      "validate_payment_status",
      "Cannot manually confirm before payment is completed unless override is explicitly enabled.",
    );
  }

  try {
    let squareBookingId = getString(appointmentIntent, "square_booking_id");
    let squareBookingAction: "created" | "reused" | "ignored" = squareBookingId ? "reused" : "ignored";

    if (input.create_square_booking && !squareBookingId) {
      appointmentIntent = await createManualSquareBookingIfNeeded(supabase, appointmentIntent, appointmentIntentId, input);
      squareBookingId = getString(appointmentIntent, "square_booking_id");
      squareBookingAction = squareBookingId ? "created" : "ignored";

      if (getString(appointmentIntent, "appointment_status") === "manual_review_needed") {
        return manualReviewJson(
          {
            appointment_status: "manual_review_needed",
            square_booking_id: null,
            square_booking_action: "ignored",
            confirmation_sent: false,
            slot_unavailable: true,
          },
          { debugId, appointmentIntentId, message: "Slot unavailable during manual confirmation." },
        );
      }
    }

    const now = new Date();
    appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
      ...markConfirmed(now),
      last_error: null,
      last_error_at: null,
      internal_notes: appendInternalNote(getString(appointmentIntent, "internal_notes"), input.note, now),
    });

    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "manual_confirmed",
      status: "success",
      payload: {
        create_square_booking: input.create_square_booking,
        send_confirmation: input.send_confirmation,
        override_slot_unavailable: input.override_slot_unavailable,
        note: input.note,
      },
    });

    const confirmationSent = input.send_confirmation
      ? await sendConfirmationMessageSafely(supabase, appointmentIntent, appointmentIntentId)
      : false;

    logWorkflowInfo("appointments.manual_confirm.request_complete", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "request_complete",
      appointment_intent_id: appointmentIntentId,
      square_booking_id: getString(appointmentIntent, "square_booking_id") ?? squareBookingId,
      status: 200,
      safe_message: "Appointment manually confirmed.",
    });

    return okJson(
      {
        appointment_status: "confirmed",
        square_booking_id: getString(appointmentIntent, "square_booking_id") ?? squareBookingId,
        square_booking_action: squareBookingAction,
        confirmation_sent: confirmationSent,
      },
      { step: "manual_confirmed", message: "Appointment manually confirmed.", debugId, appointmentIntentId },
    );
  } catch (error) {
    logError("appointments.manual_confirm.failed", {
      appointmentIntentId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    await safeUpdateLastError(
      supabase,
      appointmentIntentId,
      error instanceof Error ? error.message : "Unable to manually confirm appointment.",
    );
    await insertWorkflowEvent(supabase, {
      organization_id: appointmentIntent ? getString(appointmentIntent, "organization_id") : undefined,
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "manual_confirm_failed", message: error instanceof Error ? error.message : "Unknown error" },
    });
    logWorkflowError("appointments.manual_confirm.failed", {
      debug_id: debugId,
      operation: "manual_confirm",
      step: "manual_confirm",
      appointment_intent_id: appointmentIntentId,
      error_code: "MANUAL_CONFIRM_FAILED",
      status: 500,
      safe_message: error instanceof Error ? error.message : "Unable to manually confirm appointment.",
    });

    return routeError("MANUAL_CONFIRM_FAILED", "manual_confirm", "Unable to manually confirm appointment.", 500);
  }
}

async function createManualSquareBookingIfNeeded(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
  input: ManualConfirmInput,
) {
  const selectedStartAt = requireString(appointmentIntent, "selected_start_at");
  const durationMinutes = requireNumber(appointmentIntent, "duration_minutes");
  let bookingStartAt = selectedStartAt;
  let bookingTeamMemberId = requireString(appointmentIntent, "square_team_member_id");
  let bookingServiceVariationId = requireString(appointmentIntent, "square_service_variation_id");
  let bookingServiceVariationVersion = requireNumber(appointmentIntent, "square_service_variation_version");
  let bookingDurationMinutes = durationMinutes;

  if (!input.override_slot_unavailable) {
    const availability = await searchSquareAvailability({
      locationId: requireString(appointmentIntent, "square_location_id"),
      teamMemberId: bookingTeamMemberId,
      serviceVariationId: bookingServiceVariationId,
      startAt: selectedStartAt,
      endAt: addMinutes(selectedStartAt, durationMinutes + 15),
      selectedStartAt,
      timezone: getString(appointmentIntent, "selected_timezone"),
      appointmentIntentId,
    });
    const slot = findExactAvailableSlot({ desiredStartAt: selectedStartAt, availability });

    if (!slot) {
      await updateAppointmentIntent(supabase, appointmentIntentId, {
        ...markManualReviewNeeded(),
        last_error: "Slot unavailable during manual confirmation",
      });
      await insertWorkflowEvent(supabase, {
        organization_id: getString(appointmentIntent, "organization_id"),
        appointment_intent_id: appointmentIntentId,
        event_type: "manual_review_needed",
        status: "failed",
        payload: { reason: "manual_confirm_slot_unavailable", selected_start_at: selectedStartAt },
      });

      return { ...appointmentIntent, appointment_status: "manual_review_needed" };
    }

    bookingStartAt = selectedStartAt;
    bookingTeamMemberId = slot.teamMemberId;
    bookingServiceVariationId = slot.serviceVariationId;
    bookingServiceVariationVersion = slot.serviceVariationVersion;
    bookingDurationMinutes = slot.durationMinutes;
  }

  // Admin/demo override deliberately bypasses the availability re-check but still
  // asks Square to create the booking. Square may reject the booking if invalid.
  const customer = await getOrCreateSquareCustomer({
    fullName: getString(appointmentIntent, "caller_name") ?? undefined,
    phoneE164: getString(appointmentIntent, "caller_phone_e164") ?? requireString(appointmentIntent, "caller_phone"),
    email: getString(appointmentIntent, "caller_email") ?? undefined,
    appointmentIntentId,
  });
  const booking = await createSquareBooking({
    appointmentIntentId,
    locationId: requireString(appointmentIntent, "square_location_id"),
    customerId: customer.customerId,
    startAt: bookingStartAt,
    teamMemberId: bookingTeamMemberId,
    serviceVariationId: bookingServiceVariationId,
    serviceVariationVersion: bookingServiceVariationVersion,
    durationMinutes: bookingDurationMinutes,
    customerNote: getString(appointmentIntent, "notes") ?? getRawBookingNotes(appointmentIntent),
    idempotencyKey: buildSquareBookingIdempotencyKey(appointmentIntentId),
  });

  appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    ...markSquareBookingCreated(),
    square_booking_id: booking.bookingId,
    square_customer_id: customer.customerId,
    square_booking_created_at: new Date().toISOString(),
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "square_booking_created",
    status: "success",
    payload: { reason: "manual_confirm", square_booking_id: booking.bookingId, square_customer_id: customer.customerId },
  });

  return appointmentIntent;
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
      selectedTimeDisplay: formatAppointmentDateTimeForMessage({
        selectedStartAt: getString(appointmentIntent, "selected_start_at"),
        selectedTimeDisplay: getString(appointmentIntent, "selected_time_display"),
        timeZone: getAppointmentTimeZone(appointmentIntent),
        appointmentIntentId,
        operation: "manual_confirm",
        step: "send_confirmation_whatsapp",
      }),
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
        operation: "manual_confirm",
        failureEventName: "appointments.manual_confirm.message_event_insert_failed",
      },
    );
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "whatsapp_sent",
      status: "success",
      payload: { message_type: "appointment_confirmation", provider: "telnyx", provider_message_id: message.providerMessageId },
    });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown message error.";
    logWarn("appointments.manual_confirm.confirmation_message_failed", {
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
        operation: "manual_confirm",
        failureEventName: "appointments.manual_confirm.message_event_insert_failed",
      },
    );
    await safeUpdateLastError(supabase, appointmentIntentId, message);
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "manual_confirmation_message_failed", message },
    });

    return false;
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

async function safeUpdateLastError(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  lastError: string,
) {
  const { error } = await supabase.from("appointment_intents").update({ last_error: lastError }).eq("id", appointmentIntentId);

  if (error) {
    logWarn("appointments.manual_confirm.last_error_update_failed", { message: error.message });
  }
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  await insertAppointmentWorkflowEvent(supabase, row, {
    operation: "manual_confirm",
    failureEventName: "appointments.manual_confirm.workflow_event_insert_failed",
  });
}

function appendInternalNote(existingNote: string | null, newNote: string | undefined, now: Date) {
  if (!newNote) {
    return existingNote;
  }

  const entry = `[${now.toISOString()}] Manual confirm: ${newNote}`;

  return existingNote ? `${existingNote}\n${entry}` : entry;
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

function getString(row: SupabaseRow, key: string) {
  const value = row[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireNumber(row: SupabaseRow, key: string) {
  const value = Number(row[key]);

  if (!Number.isFinite(value)) {
    throw new Error(`appointment_intents.${key} must be numeric.`);
  }

  return value;
}

function isRecord(value: unknown): value is SupabaseRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
