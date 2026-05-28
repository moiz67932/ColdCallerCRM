import { NextRequest } from "next/server";
import { ZodError } from "zod";

import { createAppointmentPaymentLink } from "@/lib/square/payments";
import { findExactAvailableSlot, searchSquareAvailability } from "@/lib/square/bookings";
import { resolveServiceForBooking } from "@/lib/square/catalog";
import { SquareApiError } from "@/lib/square/client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { hasValidElevenLabsToolBearerAuth } from "@/lib/elevenlabs/tool-auth";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { buildPaymentLinkIdempotencyKey } from "@/lib/appointments/idempotency";
import { insertAppointmentWorkflowEvent } from "@/lib/appointments/workflow-events";
import { insertTelnyxMessageEvent } from "@/lib/appointments/message-events";
import { failJson, okJson, squareFailJson, validationFailJson } from "@/lib/api/paid-appointment-response";
import {
  createDebugId,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markPaymentLinkCreated, markPaymentLinkSent } from "@/lib/appointments/status-machine";
import { normalizePhoneNumber } from "@/lib/phone";
import { getMissingPaidAppointmentEnvNames, requireEnv } from "@/lib/env";
import { sendPaymentLinkWhatsApp } from "@/lib/messaging/send-whatsapp";
import { createPayToken } from "@/lib/payments/pay-token";
import { buildDepositPricingDetails } from "@/lib/payments/deposit-pricing";
import { getSupabaseRuntimeFingerprint } from "@/lib/runtime-env-debug";
import {
  CreatePaidAppointmentIntentSchema,
  type CreatePaidAppointmentIntentInput,
} from "@/lib/validation/paid-appointment";
import {
  type SupabaseRow,
} from "@/lib/category7-db";

export const runtime = "nodejs";

const SQUARE_AVAILABILITY_TIMEOUT_MS = 8_000;
type NormalizedPaidAppointmentIntentInput = CreatePaidAppointmentIntentInput & { selected_start_at: string };

function toolError(errorCode: string, step: string, say: string, status = 400, debugId?: string) {
  return failJson({ errorCode, step, message: say, debugId, say }, { status });
}

export async function POST(request: NextRequest) {
  const debugId = createDebugId("create_paid_intent");
  let supabaseForFailure: ReturnType<typeof getSupabaseAdmin> | null = null;
  let createdAppointmentIntentId: string | null = null;
  let resolvedOrganizationIdForFailure: string | null = null;

  logWorkflowInfo("paid_appointment_intent.request_start", {
    debug_id: debugId,
    operation: "create_paid_appointment_intent",
    step: "request_start",
    ...getSupabaseRuntimeFingerprint(),
  });

  const missingEnvNames = getMissingPaidAppointmentEnvNames();

  if (missingEnvNames.length > 0) {
    logWorkflowError("paid_appointment_intent.env_not_configured", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "validate_runtime_env",
      status: 503,
      error_code: "PAID_APPOINTMENT_ENV_NOT_CONFIGURED",
      missing_env: missingEnvNames,
      safe_message: "Paid appointment workflow environment is not fully configured.",
    });
    return failJson(
      {
        errorCode: "PAID_APPOINTMENT_ENV_NOT_CONFIGURED",
        step: "validate_runtime_env",
        message: "Paid appointment workflow is not fully configured.",
        debugId,
        safeDetails: { missing_env: missingEnvNames },
        say: "I'm having trouble creating the secure deposit link right now. A team member can help review this.",
      },
      { status: 503 },
    );
  }

  if (!hasValidElevenLabsToolBearerAuth(request.headers, requireEnv("ELEVENLABS_TOOL_SECRET"))) {
    logWorkflowError("paid_appointment_intent.unauthorized", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "authorize",
      status: 401,
      error_code: "UNAUTHORIZED",
      safe_message: "ElevenLabs tool request failed bearer auth.",
    });
    return failJson(
      { errorCode: "UNAUTHORIZED", step: "authorize", message: "Unauthorized.", debugId, say: "Unauthorized." },
      { status: 401 },
    );
  }

  try {
    const body = await request.json();
    const input = CreatePaidAppointmentIntentSchema.parse(body);
    const supabase = getSupabaseAdmin();
    supabaseForFailure = supabase;
    const resolvedContext = await resolveOrganizationContext(input, supabase);
    resolvedOrganizationIdForFailure = resolvedContext.organizationId;
    const callerPhoneE164 = resolveCallerPhoneE164(input.caller_phone);

    if (!callerPhoneE164) {
      return toolError(
        "INVALID_CALLER_PHONE",
        "validate_request",
        "I need a valid phone number before I can send the secure deposit link.",
        400,
        debugId,
      );
    }

    const service = await resolveServiceForBooking({
      organizationId: resolvedContext.organizationId,
      serviceName: input.service_name,
    });
    const selectedTimezone =
      input.clinic_timezone ??
      input.selected_timezone ??
      (await resolveBusinessTimezone({
        supabase,
        organizationId: resolvedContext.organizationId,
        clinicId: input.clinic_id ?? service.clinicId ?? resolvedContext.clinicId,
        squareLocationId: service.locationId,
      }));
    const timeNormalization = normalizeAppointmentStartAt({
      input,
      clinicTimezone: selectedTimezone,
      organizationId: resolvedContext.organizationId,
      serviceName: service.serviceName,
      debugId,
    });
    const normalizedInput: NormalizedPaidAppointmentIntentInput = {
      ...input,
      selected_start_at: timeNormalization.selectedStartAt,
      selected_timezone: selectedTimezone,
      clinic_timezone: selectedTimezone,
    };
    const selectedTimeDisplay =
      input.selected_time_display ?? formatSelectedTimeDisplay(normalizedInput.selected_start_at, selectedTimezone);
    const pricingDetails = buildDepositPricingDetails({
      serviceName: service.serviceName,
      servicePriceCents: service.servicePriceCents,
      depositPercentBps: service.depositPercentBps,
      depositAmountCents: service.depositAmountCents,
      currency: service.currency,
    });
    logWorkflowInfo("paid_appointment_intent.availability_search_start", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "check_square_availability",
      selected_start_at: normalizedInput.selected_start_at,
      selected_timezone: selectedTimezone,
      selected_time_display: selectedTimeDisplay,
      duration_minutes: service.durationMinutes,
      square_location_id: service.locationId,
      square_team_member_id: service.teamMemberId,
      square_service_variation_id: service.serviceVariationId,
      timeout_ms: SQUARE_AVAILABILITY_TIMEOUT_MS,
    });
    const availability = await searchSquareAvailability({
      locationId: service.locationId,
      teamMemberId: service.teamMemberId,
      serviceVariationId: service.serviceVariationId,
      startAt: normalizedInput.selected_start_at,
      endAt: addMinutes(normalizedInput.selected_start_at, service.durationMinutes + 15),
      selectedStartAt: normalizedInput.selected_start_at,
      timezone: selectedTimezone,
      timeoutMs: SQUARE_AVAILABILITY_TIMEOUT_MS,
    });
    const slot = findExactAvailableSlot({ desiredStartAt: normalizedInput.selected_start_at, availability });
    logWorkflowInfo("paid_appointment_intent.availability_search_complete", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "check_square_availability",
      selected_start_at: normalizedInput.selected_start_at,
      selected_timezone: selectedTimezone,
      availability_count: availability.length,
      exact_slot_found: Boolean(slot),
    });

    if (!slot) {
      throw new PaidAppointmentIntentError({
        errorCode: "SLOT_UNAVAILABLE",
        step: "check_square_availability",
        say: "That appointment time is no longer available, so I did not send a deposit link. Please choose another time.",
        status: 409,
      });
    }

    const appointmentIntent = await insertAppointmentIntent({
      input: normalizedInput,
      supabase,
      organizationId: resolvedContext.organizationId,
      clinicId: input.clinic_id ?? service.clinicId ?? resolvedContext.clinicId,
      callerPhoneE164,
      service,
      selectedTimezone,
      selectedTimeDisplay,
    });

    const appointmentIntentId = requireRowId(appointmentIntent, "appointment_intents");
    createdAppointmentIntentId = appointmentIntentId;
    logWorkflowInfo("paid_appointment_intent.intent_created", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "insert_appointment_intent",
      appointment_intent_id: appointmentIntentId,
      organization_id: resolvedContext.organizationId,
      conversation_id: input.conversation_id,
      caller_phone_e164_masked: maskPhone(callerPhoneE164),
      service_name: input.service_name,
      selected_start_at: normalizedInput.selected_start_at,
      selected_timezone: selectedTimezone,
      selected_time_display: selectedTimeDisplay,
      payment_status: getString(appointmentIntent, "payment_status"),
      appointment_status: getString(appointmentIntent, "appointment_status"),
      idempotency_key: getString(appointmentIntent, "idempotency_key"),
      row_action: "created",
    });
    await insertWorkflowEvent(supabase, {
      organization_id: resolvedContext.organizationId,
      appointment_intent_id: appointmentIntentId,
      event_type: "details_collected",
      status: "success",
      payload: { source: "elevenlabs_call" },
    });

    const paymentLink = await createAppointmentPaymentLink({
      appointmentIntentId,
      locationId: service.locationId,
      serviceName: service.serviceName,
      clinicName: resolvedContext.clinicName,
      callerName: input.caller_name,
      callerPhone: callerPhoneE164,
      callerEmail: input.caller_email,
      amountCents: pricingDetails.deposit_amount_cents ?? service.depositAmountCents,
      currency: service.currency,
      depositPercentText: pricingDetails.deposit_percent_text,
      selectedStartAt: normalizedInput.selected_start_at,
      idempotencyKey: buildPaymentLinkIdempotencyKey(appointmentIntentId),
    });
    const payToken = createPayToken({ appointmentIntentId, expiresInMinutes: 60 * 24 * 14 });
    const brandedPayUrl = `${getPublicAppUrl()}/pay/${payToken}`;

    await updateAppointmentIntent(supabase, appointmentIntentId, {
      square_payment_link_id: paymentLink.paymentLinkId,
      square_order_id: paymentLink.orderId,
      square_payment_link_url: paymentLink.checkoutUrl,
      ...markPaymentLinkCreated(),
    });
    await insertWorkflowEvent(supabase, {
      organization_id: resolvedContext.organizationId,
      appointment_intent_id: appointmentIntentId,
      event_type: "payment_link_created",
      status: "success",
      payload: { square_payment_link_id: paymentLink.paymentLinkId, square_order_id: paymentLink.orderId },
    });

    const whatsAppResult = await (async () => {
      try {
        return await sendPaymentLinkWhatsApp({
          appointmentIntentId,
          toPhoneE164: callerPhoneE164,
          patientName: input.caller_name,
          serviceName: input.service_name,
          clinicName: resolvedContext.clinicName,
          paymentLinkUrl: brandedPayUrl,
          paymentButtonToken: payToken,
          selectedTimeDisplay: selectedTimeDisplay,
        });
      } catch (error) {
        await insertTelnyxMessageEvent(
          supabase,
          {
            organizationId: resolvedContext.organizationId,
            appointmentIntentId,
            toPhoneE164: callerPhoneE164,
            messageType: "payment_link",
            status: "failed",
            error,
            payload: { message_type: "payment_link" },
          },
          {
            operation: "create_paid_appointment_intent",
            failureEventName: "paid_appointment_intent.message_event_insert_failed",
          },
        );

        throw new PaidAppointmentIntentError({
          errorCode: "PAYMENT_LINK_SEND_FAILED",
          step: "send_whatsapp",
          say: "I created the secure deposit link, but I'm having trouble sending it to WhatsApp right now. A team member can resend it.",
          status: 502,
        });
      }
    })();

    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: resolvedContext.organizationId,
        appointmentIntentId,
        toPhoneE164: callerPhoneE164,
        messageType: "payment_link",
        providerMessageId: whatsAppResult.providerMessageId,
        status: "sent",
        payload: {
          provider_response: whatsAppResult.raw,
          telnyx_status: whatsAppResult.status,
        },
      },
      {
        operation: "create_paid_appointment_intent",
        failureEventName: "paid_appointment_intent.message_event_insert_failed",
      },
    );

    await updateAppointmentIntent(supabase, appointmentIntentId, {
      ...markPaymentLinkSent(),
      payment_link_sent_at: new Date().toISOString(),
    });
    await insertWorkflowEvent(supabase, {
      organization_id: resolvedContext.organizationId,
      appointment_intent_id: appointmentIntentId,
      event_type: "payment_link_sent",
      status: "success",
      payload: { provider: "telnyx", provider_message_id: whatsAppResult.providerMessageId },
    });
    await insertWorkflowEvent(supabase, {
      organization_id: resolvedContext.organizationId,
      appointment_intent_id: appointmentIntentId,
      event_type: "whatsapp_sent",
      status: "success",
      payload: { message_type: "payment_link", provider: "telnyx", provider_message_id: whatsAppResult.providerMessageId },
    });

    logInfo("paid_appointment_intent.created", {
      appointmentIntentId,
      organizationId: resolvedContext.organizationId,
      paymentLinkSent: true,
    });
    logWorkflowInfo("paid_appointment_intent.request_complete", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "request_complete",
      appointment_intent_id: appointmentIntentId,
      conversation_id: input.conversation_id,
      square_order_id: paymentLink.orderId,
      telnyx_message_id: whatsAppResult.providerMessageId,
      status: 200,
      safe_message: "Paid appointment intent created and WhatsApp payment link sent.",
    });

    return okJson(
      {
        payment_link_sent: true,
        masked_phone: maskPhone(callerPhoneE164),
        payment_status: "pending",
        appointment_status: "payment_link_sent",
        payment_link_action: "created",
        appointment_intent_id: appointmentIntentId,
        brandedPayUrl,
        service_price_cents: pricingDetails.service_price_cents,
        deposit_percent: pricingDetails.deposit_percent,
        deposit_percent_bps: pricingDetails.deposit_percent_bps,
        deposit_amount_cents: pricingDetails.deposit_amount_cents,
        currency: pricingDetails.currency,
        service_price_text: pricingDetails.service_price_text,
        deposit_amount_text: pricingDetails.deposit_amount_text,
        deposit_policy_text: pricingDetails.deposit_policy_text,
        human_deposit_sentence: pricingDetails.human_deposit_sentence,
      },
      {
        step: "payment_link_sent",
        message: "Secure deposit button sent to WhatsApp.",
        debugId,
        appointmentIntentId,
        say: buildPaymentLinkSentSay(),
      },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      logWorkflowError("paid_appointment_intent.invalid_request", {
        debug_id: debugId,
        operation: "create_paid_appointment_intent",
        step: "validate_request",
        error_code: "INVALID_REQUEST",
        status: 400,
      });
      return validationFailJson({
        step: "validate_request",
        error,
        debugId,
        message: "Readable appointment details are required before sending a deposit link.",
        say: "I need one more detail before I can send the deposit link.",
      });
    }

    if (error instanceof SyntaxError) {
      logWorkflowError("paid_appointment_intent.invalid_json", {
        debug_id: debugId,
        operation: "create_paid_appointment_intent",
        step: "parse_request",
        error_code: "VALIDATION_FAILED",
        status: 400,
      });
      return failJson(
        {
          errorCode: "VALIDATION_FAILED",
          step: "parse_request",
          message: "Request body must be valid JSON.",
          debugId,
          safeDetails: { field_errors: [{ field: "body", message: "Invalid JSON payload." }] },
          say: "I need one more detail before I can send the deposit link.",
        },
        { status: 400 },
      );
    }

    if (error instanceof PaidAppointmentIntentError) {
      if (supabaseForFailure && createdAppointmentIntentId) {
        await safeUpdateLastError(supabaseForFailure, createdAppointmentIntentId, error.say);
        await insertWorkflowEvent(supabaseForFailure, {
          organization_id: resolvedOrganizationIdForFailure,
          appointment_intent_id: createdAppointmentIntentId,
          event_type: "failed",
          status: "failed",
          payload: { reason: error.errorCode, step: error.step, message: error.say },
        });
      }
      logWorkflowError("paid_appointment_intent.failed", {
        debug_id: debugId,
        operation: "create_paid_appointment_intent",
        step: error.step,
        error_code: error.errorCode,
        status: error.status,
        safe_message: error.say,
      });
      return toolError(error.errorCode, error.step, error.say, error.status, debugId);
    }

    if (error instanceof SquareApiError) {
      logError("paid_appointment_intent.square_error", {
        status: error.status,
        endpoint: error.endpoint,
        method: error.method,
      });
      logWorkflowError("paid_appointment_intent.square_error", {
        debug_id: debugId,
        operation: "create_paid_appointment_intent",
        step: "square_request",
        method: error.method,
        path: error.endpoint,
        status: error.status,
        error_code: "SQUARE_REQUEST_FAILED",
        square_error_body: error.errorBody,
        safe_message: "Square request failed while creating paid appointment intent.",
      });
      if (supabaseForFailure && createdAppointmentIntentId) {
        await safeUpdateLastError(supabaseForFailure, createdAppointmentIntentId, "Square request failed.");
        await insertWorkflowEvent(supabaseForFailure, {
          organization_id: resolvedOrganizationIdForFailure,
          appointment_intent_id: createdAppointmentIntentId,
          event_type: "failed",
          status: "failed",
          payload: { reason: "SQUARE_REQUEST_FAILED", method: error.method, endpoint: error.endpoint, status: error.status },
        });
      }

      return squareFailJson({
        step: "square_request",
        message: "I'm having trouble checking the appointment system right now. A team member can help review this.",
        debugId,
        safeDetails: { status: error.status, method: error.method, endpoint: error.endpoint },
        say: "I'm having trouble checking the appointment system right now. A team member can help review this.",
      });
    }

    logError("paid_appointment_intent.unexpected_error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    if (supabaseForFailure && createdAppointmentIntentId) {
      const message = error instanceof Error ? error.message : "Unexpected paid appointment intent error.";
      await safeUpdateLastError(supabaseForFailure, createdAppointmentIntentId, message);
      await insertWorkflowEvent(supabaseForFailure, {
        organization_id: resolvedOrganizationIdForFailure,
        appointment_intent_id: createdAppointmentIntentId,
        event_type: "failed",
        status: "failed",
        payload: { reason: "UNEXPECTED_ERROR", message },
      });
    }
    logWorkflowError("paid_appointment_intent.unexpected_error", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "create_paid_appointment_intent",
      status: 500,
      error_code: "UNEXPECTED_ERROR",
      safe_message: error instanceof Error ? error.message : "Unexpected paid appointment intent error.",
    });

    return toolError(
      "UNEXPECTED_ERROR",
      "create_paid_appointment_intent",
      "I'm having trouble creating the secure deposit link right now. A team member can help review this.",
      500,
      debugId,
    );
  }
}

function normalizeAppointmentStartAt(args: {
  input: CreatePaidAppointmentIntentInput;
  clinicTimezone: string;
  organizationId: string;
  serviceName: string;
  debugId: string;
}) {
  const { input, clinicTimezone, organizationId, serviceName, debugId } = args;
  const selectedStartAtReceived = input.selected_start_at ?? null;
  let selectedStartAtNormalized = selectedStartAtReceived;

  if (input.preferred_date && input.preferred_time) {
    selectedStartAtNormalized = selectedStartAtFromPreferredDateTime({
      preferredDate: input.preferred_date,
      preferredTime: input.preferred_time,
      timezone: clinicTimezone,
    });
  }

  if (!selectedStartAtNormalized) {
    throw new PaidAppointmentIntentError({
      errorCode: "MISSING_APPOINTMENT_TIME",
      step: "normalize_appointment_time",
      say: "I need the appointment date and time before I can send the deposit link.",
      status: 400,
    });
  }

  const mismatch = Boolean(
    selectedStartAtReceived &&
    input.preferred_date &&
    input.preferred_time &&
    Math.abs(new Date(selectedStartAtNormalized).getTime() - new Date(selectedStartAtReceived).getTime()) > 60_000,
  );

  logWorkflowInfo("paid_appointment_intent.time_normalized", {
    debug_id: debugId,
    operation: "create_paid_appointment_intent",
    step: "normalize_appointment_time",
    preferred_date: input.preferred_date ?? null,
    preferred_time: input.preferred_time ?? null,
    clinic_timezone: clinicTimezone,
    selected_start_at_received: selectedStartAtReceived,
    selected_start_at_normalized: selectedStartAtNormalized,
    service_name: serviceName,
    organization_id: organizationId,
    selected_start_at_mismatch: mismatch,
  });

  if (mismatch) {
    logWarn("paid_appointment_intent.selected_start_at_mismatch_normalized", {
      debug_id: debugId,
      preferred_date: input.preferred_date,
      preferred_time: input.preferred_time,
      clinic_timezone: clinicTimezone,
      selected_start_at_received: selectedStartAtReceived,
      selected_start_at_normalized: selectedStartAtNormalized,
      service_name: serviceName,
      organization_id: organizationId,
    });
  }

  return { selectedStartAt: selectedStartAtNormalized };
}

function selectedStartAtFromPreferredDateTime(input: {
  preferredDate: string;
  preferredTime: string;
  timezone: string;
}) {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.preferredDate);
  const timeParts = parsePreferredTime(input.preferredTime);

  if (!dateParts || !timeParts) {
    throw new PaidAppointmentIntentError({
      errorCode: "INVALID_APPOINTMENT_TIME",
      step: "normalize_appointment_time",
      say: "I need a clear appointment date and time before I can send the deposit link.",
      status: 400,
    });
  }

  const [, year, month, day] = dateParts;
  return zonedLocalTimeToUtcIso({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: timeParts.hour,
    minute: timeParts.minute,
    timezone: input.timezone,
  });
}

function parsePreferredTime(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const period = match[3];

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === "am" && hour === 12) hour = 0;
    if (period === "pm" && hour < 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

function zonedLocalTimeToUtcIso(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new PaidAppointmentIntentError({
      errorCode: "INVALID_CLINIC_TIMEZONE",
      step: "normalize_appointment_time",
      say: "I need the clinic timezone before I can send the deposit link.",
      status: 400,
    });
  }
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(formatter, candidate);
    const targetUtcMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
    const actualUtcMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diffMs = targetUtcMs - actualUtcMs;

    if (diffMs === 0) break;
    candidate = new Date(candidate.getTime() + diffMs);
  }

  return candidate.toISOString();
}

function zonedParts(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

async function resolveOrganizationContext(input: CreatePaidAppointmentIntentInput, supabase: ReturnType<typeof getSupabaseAdmin>) {
  if (input.organization_id) {
    return {
      organizationId: input.organization_id,
      clinicId: input.clinic_id ?? null,
      clinicName: "the clinic",
    };
  }

  if (!input.lead_demo_profile_id) {
    throw new PaidAppointmentIntentError({
      errorCode: "ORGANIZATION_NOT_FOUND",
      step: "resolve_organization",
      say: "I need the clinic context before I can send the secure deposit link.",
      status: 400,
    });
  }

  const { data, error } = await supabase
    .from("lead_demo_profiles")
    .select("*")
    .eq("id", input.lead_demo_profile_id)
    .maybeSingle();

  if (error) {
    throw new PaidAppointmentIntentError({
      errorCode: "ORGANIZATION_LOOKUP_FAILED",
      step: "resolve_organization",
      say: "I'm having trouble finding the clinic record right now.",
      status: 500,
    });
  }

  const row = (data ?? {}) as SupabaseRow;
  const organizationId = getString(row, "organization_id") ?? getString(row, "organizationId");

  if (!organizationId) {
    throw new PaidAppointmentIntentError({
      errorCode: "ORGANIZATION_NOT_FOUND",
      step: "resolve_organization",
      say: "I need the clinic context before I can send the secure deposit link.",
      status: 400,
    });
  }

  return {
    organizationId,
    clinicId: getString(row, "clinic_id") ?? getString(row, "clinicId"),
    clinicName:
      getString(row, "clinic_name") ??
      getString(row, "clinicName") ??
      getString(row, "business_name") ??
      getString(row, "businessName") ??
      "the clinic",
  };
}

async function resolveBusinessTimezone(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  organizationId: string;
  clinicId: string | null;
  squareLocationId: string;
}) {
  if (input.clinicId) {
    const { data, error } = await input.supabase
      .from("clinics")
      .select("timezone")
      .eq("id", input.clinicId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();

    if (!error) {
      const timezone = getString((data ?? {}) as SupabaseRow, "timezone");
      if (timezone) return timezone;
    }
  }

  const { data, error } = await input.supabase
    .from("square_integrations")
    .select("square_timezone")
    .eq("organization_id", input.organizationId)
    .eq("square_location_id", input.squareLocationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (!error) {
    const timezone = getString((data ?? {}) as SupabaseRow, "square_timezone");
    if (timezone) return timezone;
  }

  return "UTC";
}

function formatSelectedTimeDisplay(selectedStartAt: string, timezone: string) {
  const date = new Date(selectedStartAt);

  if (!Number.isFinite(date.getTime())) {
    return selectedStartAt;
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

function addMinutes(isoDate: string, minutes: number) {
  return new Date(new Date(isoDate).getTime() + minutes * 60_000).toISOString();
}

async function insertAppointmentIntent(args: {
  input: NormalizedPaidAppointmentIntentInput;
  supabase: ReturnType<typeof getSupabaseAdmin>;
  organizationId: string;
  clinicId: string | null;
  callerPhoneE164: string;
  selectedTimezone: string;
  selectedTimeDisplay: string;
  service: {
    locationId: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
    clinicId: string | null;
    servicePriceCents: number | null;
    depositPercentBps: number;
    depositAmountCents: number;
    currency: string;
    pricingSource: string;
  };
}) {
  const { input, supabase, organizationId, clinicId, callerPhoneE164, selectedTimezone, selectedTimeDisplay, service } = args;
  const { data, error } = await supabase
    .from("appointment_intents")
    .insert({
      organization_id: organizationId,
      clinic_id: input.clinic_id ?? clinicId,
      lead_id: input.lead_id,
      lead_demo_profile_id: input.lead_demo_profile_id,
      source: "elevenlabs_call",
      provider: "square",
      conversation_id: input.conversation_id,
      caller_name: input.caller_name,
      caller_phone: input.caller_phone,
      caller_phone_e164: callerPhoneE164,
      caller_email: input.caller_email,
      service_name: input.service_name,
      square_location_id: service.locationId,
      square_team_member_id: service.teamMemberId,
      square_service_variation_id: service.serviceVariationId,
      square_service_variation_version: service.serviceVariationVersion,
      selected_start_at: input.selected_start_at,
      selected_timezone: selectedTimezone,
      selected_time_display: selectedTimeDisplay,
      duration_minutes: service.durationMinutes,
      service_price_cents: service.servicePriceCents,
      deposit_percent_bps: service.depositPercentBps,
      deposit_amount_cents: service.depositAmountCents,
      currency: service.currency,
      pricing_source: service.pricingSource,
      payment_status: "pending",
      appointment_status: "details_collected",
      raw_booking_details: {
        notes: input.notes,
        preferred_date: input.preferred_date,
        preferred_time: input.preferred_time,
        selected_start_at: input.selected_start_at,
        selected_timezone: selectedTimezone,
        selected_time_display: selectedTimeDisplay,
        pricing: {
          service_price_cents: service.servicePriceCents,
          deposit_percent_bps: service.depositPercentBps,
          deposit_amount_cents: service.depositAmountCents,
          currency: service.currency,
          pricing_source: service.pricingSource,
        },
      },
      metadata: {
        pricing_source: service.pricingSource,
        service_price_cents: service.servicePriceCents,
        deposit_percent_bps: service.depositPercentBps,
        deposit_amount_cents: service.depositAmountCents,
        currency: service.currency,
      },
    })
    .select("id,organization_id,caller_phone_e164,service_name,selected_start_at,payment_status,appointment_status,idempotency_key")
    .single();

  if (error) {
    throw new PaidAppointmentIntentError({
      errorCode: "APPOINTMENT_INTENT_CREATE_FAILED",
      step: "insert_appointment_intent",
      say: "I'm having trouble saving the appointment details right now.",
      status: 500,
    });
  }

  return data as SupabaseRow;
}

async function updateAppointmentIntent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  patch: SupabaseRow,
) {
  const { error } = await supabase.from("appointment_intents").update(patch).eq("id", appointmentIntentId);

  if (error) {
    throw new PaidAppointmentIntentError({
      errorCode: "APPOINTMENT_INTENT_UPDATE_FAILED",
      step: "update_appointment_intent",
      say: "I created the deposit link, but I'm having trouble updating the appointment record.",
      status: 500,
    });
  }
}

async function safeUpdateLastError(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  lastError: string,
) {
  const { error } = await supabase.from("appointment_intents").update({ last_error: lastError }).eq("id", appointmentIntentId);

  if (error) {
    logWarn("paid_appointment_intent.last_error_update_failed", { message: error.message });
  }
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  await insertAppointmentWorkflowEvent(supabase, row, {
    operation: "create_paid_appointment_intent",
    failureEventName: "paid_appointment_intent.workflow_event_insert_failed",
  });
}

function resolveCallerPhoneE164(callerPhone: string) {
  const normalized = normalizePhoneNumber(callerPhone);

  if (normalized) {
    return normalized;
  }

  return callerPhone.trim().startsWith("+") ? callerPhone.trim() : null;
}

function requireRowId(row: SupabaseRow, tableName: string) {
  const id = getString(row, "id");

  if (!id) {
    throw new Error(`${tableName} insert did not return an id.`);
  }

  return id;
}

function getString(row: SupabaseRow, key: string) {
  const value = row[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function maskPhone(phoneE164: string) {
  const digits = phoneE164.replace(/\D/g, "");
  const last4 = digits.slice(-4);

  if (!last4) {
    return "********";
  }

  return phoneE164.startsWith("+1") ? `+1******${last4}` : `******${last4}`;
}

function getPublicAppUrl() {
  return (process.env.PUBLIC_APP_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function buildPaymentLinkSentSay() {
  return "Done, I sent it to your WhatsApp. You can review it there before paying.";
}

class PaidAppointmentIntentError extends Error {
  errorCode: string;
  step: string;
  say: string;
  status: number;

  constructor(args: { errorCode: string; step: string; say: string; status: number }) {
    super(args.errorCode);
    this.name = "PaidAppointmentIntentError";
    this.errorCode = args.errorCode;
    this.step = args.step;
    this.say = args.say;
    this.status = args.status;
  }
}
