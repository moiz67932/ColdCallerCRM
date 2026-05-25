import { NextRequest } from "next/server";
import { ZodError } from "zod";

import { createAppointmentPaymentLink } from "@/lib/square/payments";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { logError, logWarn } from "@/lib/logger";
import { buildPaymentLinkIdempotencyKey } from "@/lib/appointments/idempotency";
import { failJson, okJson, validationFailJson, telnyxFailJson } from "@/lib/api/paid-appointment-response";
import {
  createDebugId,
  logSupabaseWorkflowEvent,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markPaymentLinkCreated, markPaymentLinkSent } from "@/lib/appointments/status-machine";
import { requireApiAuth } from "@/lib/api-auth";
import { sendPaymentLinkWhatsApp } from "@/lib/messaging/send-whatsapp";
import { createPayToken } from "@/lib/payments/pay-token";
import {
  AppointmentIdParamSchema,
  SendLinkAgainSchema,
  type SendLinkAgainInput,
} from "@/lib/validation/paid-appointment";
import {
  normalizeMessageEventRow,
  normalizeWorkflowEventRow,
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
  const debugId = createDebugId("send_link_again");
  logWorkflowInfo("appointments.send_link_again.request_start", {
    debug_id: debugId,
    operation: "send_link_again",
    step: "request_start",
  });

  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    logWorkflowError("appointments.send_link_again.unauthorized", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "authorize",
      error_code: "UNAUTHORIZED",
      status: 401,
    });
    return authError;
  }

  const parsedParams = AppointmentIdParamSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    logWorkflowError("appointments.send_link_again.invalid_id", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "validate_id",
      error_code: "INVALID_APPOINTMENT_ID",
      status: 400,
    });
    return validationError("validate_id", parsedParams.error);
  }
  const appointmentIntentId = parsedParams.data.id;

  let input: SendLinkAgainInput;

  try {
    input = SendLinkAgainSchema.parse(await request.json());
  } catch (error) {
    logWorkflowError("appointments.send_link_again.invalid_request", {
      debug_id: debugId,
      operation: "send_link_again",
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
    logError("appointments.send_link_again.load_failed", {
      appointmentIntentId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    logWorkflowError("appointments.send_link_again.load_failed", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "load_appointment_intent",
      appointment_intent_id: appointmentIntentId,
      error_code: "APPOINTMENT_LOAD_FAILED",
      safe_message: error instanceof Error ? error.message : "Unable to load appointment intent.",
    });
    return routeError("APPOINTMENT_LOAD_FAILED", "load_appointment_intent", "Unable to load appointment intent.", 500);
  }

  if (!appointmentIntent) {
    logWorkflowError("appointments.send_link_again.not_found", {
      debug_id: debugId,
      operation: "send_link_again",
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

  if (getString(appointmentIntent, "payment_status") === "completed") {
    logWorkflowInfo("appointments.send_link_again.payment_completed", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "validate_payment_status",
      appointment_intent_id: appointmentIntentId,
      error_code: "PAYMENT_ALREADY_COMPLETED",
      status: 400,
      safe_message: "Payment is already completed; payment link was not resent.",
    });
    return routeError(
      "PAYMENT_ALREADY_COMPLETED",
      "validate_payment_status",
      "Payment is already completed, so the payment link was not resent.",
    );
  }

  const recipient = input.to_phone_e164 ?? getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone");

  if (!recipient?.startsWith("+")) {
    logWorkflowError("appointments.send_link_again.invalid_recipient", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "resolve_recipient",
      appointment_intent_id: appointmentIntentId,
      error_code: "INVALID_RECIPIENT_PHONE",
      status: 400,
    });
    return routeError(
      "INVALID_RECIPIENT_PHONE",
      "resolve_recipient",
      "A valid +E.164 phone number is required to resend the payment link.",
    );
  }

  try {
    const existingCheckoutUrl = getString(appointmentIntent, "square_payment_link_url");
    const reusedExistingLink = Boolean(existingCheckoutUrl);
    const forceNewLinkIgnored = Boolean(existingCheckoutUrl && input.force_new_link);

    if (!reusedExistingLink) {
      appointmentIntent = await createAndPersistPaymentLink(supabase, appointmentIntent, appointmentIntentId);
    }

    const checkoutUrl = requireString(appointmentIntent, "square_payment_link_url");
    const payToken = createPayToken({ appointmentIntentId, expiresInMinutes: 60 * 24 * 14 });
    const brandedPayUrl = `${getPublicAppUrl()}/pay/${payToken}`;

    try {
      const message = await sendPaymentLinkWhatsApp({
        appointmentIntentId,
        toPhoneE164: recipient,
        patientName: requireString(appointmentIntent, "caller_name"),
        serviceName: requireString(appointmentIntent, "service_name"),
        clinicName: getString(appointmentIntent, "clinic_name") ?? "the clinic",
        paymentLinkUrl: brandedPayUrl,
        paymentButtonToken: payToken,
        selectedTimeDisplay: getString(appointmentIntent, "selected_time_display") ?? undefined,
      });

      await insertMessageEvent(supabase, {
        organization_id: getString(appointmentIntent, "organization_id"),
        appointment_intent_id: appointmentIntentId,
        provider: "telnyx",
        channel: "whatsapp",
        message_type: "payment_link",
        recipient_phone_e164: recipient,
        provider_message_id: message.providerMessageId,
        status: message.status,
        payload: message.raw,
      });

      appointmentIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
        ...markPaymentLinkSent(),
        payment_link_sent_at: new Date().toISOString(),
      });
      await insertWorkflowEvent(supabase, {
        organization_id: getString(appointmentIntent, "organization_id"),
        appointment_intent_id: appointmentIntentId,
        event_type: "payment_link_resent",
        status: "success",
        payload: {
          reused_existing_link: reusedExistingLink,
          force_new_link_ignored: forceNewLinkIgnored,
          recipient_phone_e164: recipient,
          provider_message_id: message.providerMessageId,
        },
      });
      await insertWorkflowEvent(supabase, {
        organization_id: getString(appointmentIntent, "organization_id"),
        appointment_intent_id: appointmentIntentId,
        event_type: "whatsapp_sent",
        status: "success",
        payload: { message_type: "payment_link", provider: "telnyx", provider_message_id: message.providerMessageId },
      });

      logWorkflowInfo("appointments.send_link_again.request_complete", {
        debug_id: debugId,
        operation: "send_link_again",
        step: "request_complete",
        appointment_intent_id: appointmentIntentId,
        square_order_id: getString(appointmentIntent, "square_order_id"),
        telnyx_message_id: message.providerMessageId,
        status: 200,
        safe_message: "Payment link resent by WhatsApp.",
      });

      return okJson(
        {
          payment_link_sent: true,
          reused_existing_link: reusedExistingLink,
          payment_link_action: reusedExistingLink ? "reused" : "created",
          force_new_link_ignored: forceNewLinkIgnored,
          checkout_url: checkoutUrl,
          brandedPayUrl,
        },
        {
          step: "payment_link_sent",
          message: "Payment link sent.",
          debugId,
          appointmentIntentId,
        },
      );
    } catch (error) {
      const safeError = error instanceof Error ? error.message : "Unknown WhatsApp send error.";

      await insertWorkflowEvent(supabase, {
        organization_id: getString(appointmentIntent, "organization_id"),
        appointment_intent_id: appointmentIntentId,
        event_type: "failed",
        status: "failed",
        payload: {
          reason: "payment_link_resend_failed",
          reused_existing_link: reusedExistingLink,
          recipient_phone_e164: recipient,
          message: safeError,
        },
      });
      await safeUpdateLastError(supabase, appointmentIntentId, safeError);
      logWarn("appointments.send_link_again.message_failed", { appointmentIntentId, message: safeError });
      logWorkflowError("appointments.send_link_again.message_failed", {
        debug_id: debugId,
        operation: "send_link_again",
        step: "send_whatsapp",
        appointment_intent_id: appointmentIntentId,
        error_code: "PAYMENT_LINK_SEND_FAILED",
        status: 502,
        safe_message: safeError,
      });

      return telnyxFailJson(
        {
          step: "send_whatsapp",
          message: safeError,
          debugId,
          appointmentIntentId,
          safeDetails: {
            payment_link_sent: false,
            reused_existing_link: reusedExistingLink,
            payment_link_action: reusedExistingLink ? "reused" : "created",
            force_new_link_ignored: forceNewLinkIgnored,
            checkout_url: checkoutUrl,
            brandedPayUrl,
          },
        },
        { status: 502 },
      );
    }
  } catch (error) {
    logError("appointments.send_link_again.failed", {
      appointmentIntentId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    await safeUpdateLastError(
      supabase,
      appointmentIntentId,
      error instanceof Error ? error.message : "Unable to resend payment link.",
    );
    await insertWorkflowEvent(supabase, {
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "payment_link_resend_failed", message: error instanceof Error ? error.message : "Unknown error" },
    });
    logWorkflowError("appointments.send_link_again.failed", {
      debug_id: debugId,
      operation: "send_link_again",
      step: "send_link_again",
      appointment_intent_id: appointmentIntentId,
      error_code: "PAYMENT_LINK_RESEND_FAILED",
      status: 500,
      safe_message: error instanceof Error ? error.message : "Unable to resend payment link.",
    });

    return routeError("PAYMENT_LINK_RESEND_FAILED", "send_link_again", "Unable to resend payment link.", 500);
  }
}

async function createAndPersistPaymentLink(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  const paymentLink = await createAppointmentPaymentLink({
    appointmentIntentId,
    locationId: requireString(appointmentIntent, "square_location_id"),
    serviceName: requireString(appointmentIntent, "service_name"),
    clinicName: getString(appointmentIntent, "clinic_name") ?? undefined,
    callerName: getString(appointmentIntent, "caller_name") ?? undefined,
    callerPhone: getString(appointmentIntent, "caller_phone_e164") ?? getString(appointmentIntent, "caller_phone") ?? undefined,
    callerEmail: getString(appointmentIntent, "caller_email") ?? undefined,
    amountCents: requireNumber(appointmentIntent, "deposit_amount_cents"),
    currency: requireString(appointmentIntent, "currency"),
    selectedStartAt: getString(appointmentIntent, "selected_start_at") ?? undefined,
    idempotencyKey: buildPaymentLinkIdempotencyKey(appointmentIntentId),
  });

  const updatedIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
    square_payment_link_id: paymentLink.paymentLinkId,
    square_order_id: paymentLink.orderId,
    square_payment_link_url: paymentLink.checkoutUrl,
    ...markPaymentLinkCreated(),
  });

  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "payment_link_created",
    status: "success",
    payload: {
      reason: "send_link_again",
      square_payment_link_id: paymentLink.paymentLinkId,
      square_order_id: paymentLink.orderId,
      force_new_link: false,
    },
  });

  return { ...appointmentIntent, ...updatedIntent };
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
    logWarn("appointments.send_link_again.last_error_update_failed", { message: error.message });
  }
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  const normalizedRow = normalizeWorkflowEventRow(row);
  const { error } = await supabase.from("appointment_workflow_events").insert(normalizedRow);

  if (error) {
    logWarn("appointments.send_link_again.workflow_event_insert_failed", { message: error.message });
    logWorkflowError("appointments.send_link_again.workflow_event_insert_failed", {
      operation: "send_link_again",
      step: "insert_workflow_event",
      appointment_intent_id: getString(row, "appointment_intent_id"),
      error_code: "WORKFLOW_EVENT_INSERT_FAILED",
      safe_message: error.message,
    });
    return;
  }

  logSupabaseWorkflowEvent({
    operation: "send_link_again",
    appointment_intent_id: getString(row, "appointment_intent_id"),
    step: getString(row, "event_type"),
    status: getString(normalizedRow, "event_status"),
    payload: row.payload,
  });
}

async function insertMessageEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  const { error } = await supabase.from("message_events").insert(normalizeMessageEventRow(row));

  if (error) {
    logWarn("appointments.send_link_again.message_event_insert_failed", { message: error.message });
  }
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

function getPublicAppUrl() {
  return (process.env.PUBLIC_APP_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
