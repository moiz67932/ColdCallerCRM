import { NextRequest } from "next/server";
import { ZodError } from "zod";

import { createAppointmentPaymentLink } from "@/lib/square/payments";
import { resolveServiceForBooking } from "@/lib/square/catalog";
import { SquareApiError } from "@/lib/square/client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { hasValidElevenLabsToolBearerAuth } from "@/lib/elevenlabs/tool-auth";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { buildPaymentLinkIdempotencyKey } from "@/lib/appointments/idempotency";
import { failJson, okJson, squareFailJson, validationFailJson } from "@/lib/api/paid-appointment-response";
import {
  createDebugId,
  logSupabaseWorkflowEvent,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markPaymentLinkCreated, markPaymentLinkSent } from "@/lib/appointments/status-machine";
import { normalizePhoneNumber } from "@/lib/phone";
import { requireEnv } from "@/lib/env";
import { sendPaymentLinkWhatsApp } from "@/lib/messaging/send-whatsapp";
import { createPayToken } from "@/lib/payments/pay-token";
import {
  CreatePaidAppointmentIntentSchema,
  type CreatePaidAppointmentIntentInput,
} from "@/lib/validation/paid-appointment";
import {
  normalizeMessageEventRow,
  normalizeWorkflowEventRow,
  type SupabaseRow,
} from "@/lib/category7-db";

export const runtime = "nodejs";

function toolError(errorCode: string, step: string, say: string, status = 400, debugId?: string) {
  return failJson({ errorCode, step, message: say, debugId, say }, { status });
}

export async function POST(request: NextRequest) {
  const debugId = createDebugId("create_paid_intent");
  let supabaseForFailure: ReturnType<typeof getSupabaseAdmin> | null = null;
  let createdAppointmentIntentId: string | null = null;

  logWorkflowInfo("paid_appointment_intent.request_start", {
    debug_id: debugId,
    operation: "create_paid_appointment_intent",
    step: "request_start",
  });

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
    logWorkflowInfo("paid_appointment_intent.availability_search_skipped", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "check_square_availability",
      selected_start_at: input.selected_start_at,
      selected_timezone: input.selected_timezone,
      duration_minutes: service.durationMinutes,
      square_location_id: service.locationId,
      square_team_member_id: service.teamMemberId,
      square_service_variation_id: service.serviceVariationId,
      safe_message: "Skipping Square availability search because selected_start_at is already provided for payment intent creation.",
    });

    const appointmentIntent = await insertAppointmentIntent({
      input,
      supabase,
      organizationId: resolvedContext.organizationId,
      clinicId: resolvedContext.clinicId,
      callerPhoneE164,
      service,
    });

    const appointmentIntentId = requireRowId(appointmentIntent, "appointment_intents");
    createdAppointmentIntentId = appointmentIntentId;
    logWorkflowInfo("paid_appointment_intent.intent_created", {
      debug_id: debugId,
      operation: "create_paid_appointment_intent",
      step: "insert_appointment_intent",
      appointment_intent_id: appointmentIntentId,
      conversation_id: input.conversation_id,
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
      serviceName: input.service_name,
      clinicName: resolvedContext.clinicName,
      callerName: input.caller_name,
      callerPhone: callerPhoneE164,
      callerEmail: input.caller_email,
      amountCents: service.depositAmountCents,
      currency: service.currency,
      selectedStartAt: input.selected_start_at,
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

    const whatsAppResult = await sendPaymentLinkWhatsApp({
      appointmentIntentId,
      toPhoneE164: callerPhoneE164,
      patientName: input.caller_name,
      serviceName: input.service_name,
      clinicName: resolvedContext.clinicName,
      paymentLinkUrl: brandedPayUrl,
      paymentButtonToken: payToken,
      selectedTimeDisplay: input.selected_time_display,
    });

    await insertMessageEvent(supabase, {
      organization_id: resolvedContext.organizationId,
      appointment_intent_id: appointmentIntentId,
      provider: "telnyx",
      channel: "whatsapp",
      message_type: "payment_link",
      recipient_phone_e164: callerPhoneE164,
      provider_message_id: whatsAppResult.providerMessageId,
      status: whatsAppResult.status,
      payload: whatsAppResult.raw,
    });

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
        brandedPayUrl,
      },
      {
        step: "payment_link_sent",
        message: "Secure deposit button sent to WhatsApp.",
        debugId,
        appointmentIntentId,
        say: "I've sent the secure deposit button to your WhatsApp. Once completed, your appointment will be confirmed.",
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

async function insertAppointmentIntent(args: {
  input: CreatePaidAppointmentIntentInput;
  supabase: ReturnType<typeof getSupabaseAdmin>;
  organizationId: string;
  clinicId: string | null;
  callerPhoneE164: string;
  service: {
    locationId: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
    depositAmountCents: number;
    currency: string;
  };
}) {
  const { input, supabase, organizationId, clinicId, callerPhoneE164, service } = args;
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
      selected_timezone: input.selected_timezone,
      selected_time_display: input.selected_time_display,
      duration_minutes: service.durationMinutes,
      deposit_amount_cents: service.depositAmountCents,
      currency: service.currency,
      payment_status: "pending",
      appointment_status: "details_collected",
      raw_booking_details: {
        notes: input.notes,
        selected_start_at: input.selected_start_at,
        selected_timezone: input.selected_timezone,
        selected_time_display: input.selected_time_display,
      },
    })
    .select("id")
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
  const normalizedRow = normalizeWorkflowEventRow(row);
  const { error } = await supabase.from("appointment_workflow_events").insert(normalizedRow);

  if (error) {
    logWarn("paid_appointment_intent.workflow_event_insert_failed", { message: error.message });
    logWorkflowError("paid_appointment_intent.workflow_event_insert_failed", {
      operation: "create_paid_appointment_intent",
      step: "insert_workflow_event",
      appointment_intent_id: getString(row, "appointment_intent_id"),
      error_code: "WORKFLOW_EVENT_INSERT_FAILED",
      safe_message: error.message,
    });
    return;
  }

  logSupabaseWorkflowEvent({
    operation: "create_paid_appointment_intent",
    appointment_intent_id: getString(row, "appointment_intent_id"),
    step: getString(row, "event_type"),
    status: getString(normalizedRow, "event_status"),
    payload: row.payload,
  });
}

async function insertMessageEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  const { error } = await supabase.from("message_events").insert(normalizeMessageEventRow(row));

  if (error) {
    logWarn("paid_appointment_intent.message_event_insert_failed", { message: error.message });
  }
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
