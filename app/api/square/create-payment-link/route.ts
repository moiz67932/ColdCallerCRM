import { NextRequest } from "next/server";
import { ZodError } from "zod";

import { createAppointmentPaymentLink } from "@/lib/square/payments";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { buildPaymentLinkIdempotencyKey } from "@/lib/appointments/idempotency";
import { insertAppointmentWorkflowEvent } from "@/lib/appointments/workflow-events";
import { insertTelnyxMessageEvent } from "@/lib/appointments/message-events";
import { failJson, okJson, validationFailJson } from "@/lib/api/paid-appointment-response";
import {
  createDebugId,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";
import { markPaymentLinkCreated, markPaymentLinkSent } from "@/lib/appointments/status-machine";
import { requireApiAuth } from "@/lib/api-auth";
import { sendPaymentLinkWhatsApp } from "@/lib/messaging/send-whatsapp";
import { createPayToken } from "@/lib/payments/pay-token";
import { buildDepositPricingDetails } from "@/lib/payments/deposit-pricing";
import {
  CreatePaymentLinkSchema,
  type CreatePaymentLinkInput,
} from "@/lib/validation/paid-appointment";
import {
  normalizeAppointmentPaymentRow,
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
    message: "Missing or invalid request body.",
  });
}

export async function POST(request: NextRequest) {
  const debugId = createDebugId("create_payment_link");

  logWorkflowInfo("square.manual_payment_link.request_start", {
    debug_id: debugId,
    operation: "create_payment_link",
    step: "request_start",
  });

  const authError = await requireApiAuth(request, { mutation: true });

  if (authError) {
    logWorkflowError("square.manual_payment_link.unauthorized", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "authorize",
      status: 401,
      error_code: "UNAUTHORIZED",
    });
    return authError;
  }

  let parsed: CreatePaymentLinkInput;
  try {
    parsed = CreatePaymentLinkSchema.parse(await request.json());
  } catch (error) {
    logWorkflowError("square.manual_payment_link.invalid_request", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "validate_request",
      status: 400,
      error_code: "INVALID_REQUEST",
    });
    return validationError("validate_request", error);
  }

  const supabase = getSupabaseAdmin();
  let appointmentIntent: SupabaseRow | null;

  try {
    appointmentIntent = await loadAppointmentIntent(supabase, parsed.appointment_intent_id);
  } catch (error) {
    logError("square.manual_payment_link.load_failed", {
      appointmentIntentId: parsed.appointment_intent_id,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    logWorkflowError("square.manual_payment_link.load_failed", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "load_appointment_intent",
      appointment_intent_id: parsed.appointment_intent_id,
      error_code: "APPOINTMENT_INTENT_LOAD_FAILED",
      safe_message: error instanceof Error ? error.message : "Unable to load appointment intent.",
    });

    return routeError(
      "APPOINTMENT_INTENT_LOAD_FAILED",
      "load_appointment_intent",
      "Unable to load appointment intent.",
      500,
    );
  }

  if (!appointmentIntent) {
    logWorkflowError("square.manual_payment_link.not_found", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "load_appointment_intent",
      appointment_intent_id: parsed.appointment_intent_id,
      status: 404,
      error_code: "APPOINTMENT_INTENT_NOT_FOUND",
    });
    return routeError(
      "APPOINTMENT_INTENT_NOT_FOUND",
      "load_appointment_intent",
      "Appointment intent was not found.",
      404,
    );
  }

  const appointmentIntentId = requireString(appointmentIntent, "id");
  const paymentStatus = getString(appointmentIntent, "payment_status");
  const existingCheckoutUrl = getString(appointmentIntent, "square_payment_link_url");

  if (paymentStatus === "completed") {
    logWorkflowInfo("square.manual_payment_link.payment_completed", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "validate_payment_status",
      appointment_intent_id: appointmentIntentId,
      status: 200,
      safe_message: "Payment already completed; no new payment link created.",
    });
    return okJson(buildResponse(appointmentIntent, false, undefined, "ignored"), {
      step: "payment_already_completed",
      message: "Payment already completed; payment link was not created.",
      debugId,
      appointmentIntentId,
    });
  }

  if (existingCheckoutUrl && !parsed.send_message) {
    logWorkflowInfo("square.manual_payment_link.existing_link_returned", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "return_existing_link",
      appointment_intent_id: appointmentIntentId,
      square_order_id: getString(appointmentIntent, "square_order_id"),
      status: 200,
    });
    return okJson(buildResponse(appointmentIntent, false, undefined, "reused"), {
      step: "payment_link_reused",
      message: "Existing payment link returned.",
      debugId,
      appointmentIntentId,
    });
  }

  try {
    const linkedIntent = existingCheckoutUrl
      ? appointmentIntent
      : await createAndPersistPaymentLink(supabase, appointmentIntent, appointmentIntentId);

    if (!parsed.send_message) {
      logWorkflowInfo("square.manual_payment_link.request_complete", {
        debug_id: debugId,
        operation: "create_payment_link",
        step: "request_complete",
        appointment_intent_id: appointmentIntentId,
        square_order_id: getString(linkedIntent, "square_order_id"),
        status: 200,
        safe_message: "Manual Square payment link request completed without sending WhatsApp.",
      });
      return okJson(buildResponse(linkedIntent, false, undefined, "created"), {
        step: "payment_link_created",
        message: "Payment link created.",
        debugId,
        appointmentIntentId,
      });
    }

    const messageResult = await trySendPaymentLinkMessage(supabase, linkedIntent, appointmentIntentId);

    logWorkflowInfo("square.manual_payment_link.request_complete", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "request_complete",
      appointment_intent_id: appointmentIntentId,
      square_order_id: getString(messageResult.appointmentIntent, "square_order_id"),
      status: 200,
      safe_message: "Manual Square payment link request completed.",
    });

    return okJson(
      buildResponse(
        messageResult.appointmentIntent,
        messageResult.paymentLinkSent,
        messageResult.error,
        existingCheckoutUrl ? "reused" : "created",
      ),
      {
        step: messageResult.paymentLinkSent ? "payment_link_sent" : "payment_link_created",
        message: messageResult.paymentLinkSent ? "Payment link sent." : "Payment link created but message was not sent.",
        debugId,
        appointmentIntentId,
      },
    );
  } catch (error) {
    logError("square.manual_payment_link.failed", {
      appointmentIntentId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    await safeUpdateLastError(
      supabase,
      appointmentIntentId,
      error instanceof Error ? error.message : "Unable to create Square payment link.",
    );
    await insertWorkflowEvent(supabase, {
      organization_id: appointmentIntent ? getString(appointmentIntent, "organization_id") : undefined,
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "create_payment_link_failed", message: error instanceof Error ? error.message : "Unknown error" },
    });
    logWorkflowError("square.manual_payment_link.failed", {
      debug_id: debugId,
      operation: "create_payment_link",
      step: "create_payment_link",
      appointment_intent_id: appointmentIntentId,
      status: 500,
      error_code: "CREATE_PAYMENT_LINK_FAILED",
      safe_message: error instanceof Error ? error.message : "Unable to create Square payment link.",
    });

    return routeError(
      "CREATE_PAYMENT_LINK_FAILED",
      "create_payment_link",
      "Unable to create the Square payment link.",
      500,
    );
  }
}

async function loadAppointmentIntent(supabase: ReturnType<typeof getSupabaseAdmin>, appointmentIntentId: string) {
  const { data, error } = await supabase.from("appointment_intents").select("*").eq("id", appointmentIntentId).maybeSingle();

  if (error) {
    throw new Error(`Failed to load appointment intent: ${error.message}`);
  }

  return data as SupabaseRow | null;
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
    depositPercentText: buildDepositPricingDetailsFromIntent(appointmentIntent).deposit_percent_text,
    selectedStartAt: getString(appointmentIntent, "selected_start_at") ?? undefined,
    idempotencyKey: buildPaymentLinkIdempotencyKey(appointmentIntentId),
  });
  const patch = {
    square_payment_link_id: paymentLink.paymentLinkId,
    square_order_id: paymentLink.orderId,
    square_payment_link_url: paymentLink.checkoutUrl,
    ...markPaymentLinkCreated(),
  };
  const updatedIntent = await updateAppointmentIntent(supabase, appointmentIntentId, patch);

  await upsertAppointmentPayment(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    clinic_id: getString(appointmentIntent, "clinic_id"),
    appointment_intent_id: appointmentIntentId,
    provider: "square",
    square_order_id: paymentLink.orderId,
    square_payment_link_id: paymentLink.paymentLinkId,
    square_payment_link_url: paymentLink.checkoutUrl,
    amount_cents: requireNumber(appointmentIntent, "deposit_amount_cents"),
    currency: requireString(appointmentIntent, "currency"),
    payment_status: "pending",
    raw: paymentLink.raw,
  });
  await insertWorkflowEvent(supabase, {
    organization_id: getString(appointmentIntent, "organization_id"),
    appointment_intent_id: appointmentIntentId,
    event_type: "payment_link_created",
    status: "success",
    payload: { square_payment_link_id: paymentLink.paymentLinkId, square_order_id: paymentLink.orderId },
  });

  logInfo("square.manual_payment_link.created", {
    appointmentIntentId,
    squarePaymentLinkId: paymentLink.paymentLinkId,
  });
  logWorkflowInfo("square.manual_payment_link.created", {
    operation: "create_payment_link",
    step: "payment_link_created",
    appointment_intent_id: appointmentIntentId,
    square_order_id: paymentLink.orderId,
    safe_message: "Square payment link created.",
  });

  return { ...appointmentIntent, ...updatedIntent };
}

async function trySendPaymentLinkMessage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  try {
    const payToken = createPayToken({ appointmentIntentId, expiresInMinutes: 60 * 24 * 14 });
    const brandedPayUrl = `${getPublicAppUrl()}/pay/${payToken}`;
    const message = await sendPaymentLinkWhatsApp({
      appointmentIntentId,
      toPhoneE164: requireString(appointmentIntent, "caller_phone_e164"),
      patientName: requireString(appointmentIntent, "caller_name"),
      serviceName: requireString(appointmentIntent, "service_name"),
      clinicName: getString(appointmentIntent, "clinic_name") ?? "the clinic",
      paymentLinkUrl: brandedPayUrl,
      paymentButtonToken: payToken,
      selectedTimeDisplay: getString(appointmentIntent, "selected_time_display") ?? undefined,
    });

    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164"),
        messageType: "payment_link",
        providerMessageId: message.providerMessageId,
        status: "sent",
        payload: {
          provider_response: message.raw,
          telnyx_status: message.status,
        },
      },
      {
        operation: "create_payment_link",
        failureEventName: "square.manual_payment_link.message_event_insert_failed",
      },
    );

    const updatedIntent = await updateAppointmentIntent(supabase, appointmentIntentId, {
      ...markPaymentLinkSent(),
      payment_link_sent_at: new Date().toISOString(),
    });
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "payment_link_sent",
      status: "success",
      payload: { provider: "telnyx", provider_message_id: message.providerMessageId },
    });
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "whatsapp_sent",
      status: "success",
      payload: { message_type: "payment_link", provider: "telnyx", provider_message_id: message.providerMessageId },
    });

    return {
      appointmentIntent: { ...appointmentIntent, ...updatedIntent },
      paymentLinkSent: true,
    };
  } catch (error) {
    const safeError = error instanceof Error ? error.message : "Unknown WhatsApp send error.";

    await insertTelnyxMessageEvent(
      supabase,
      {
        organizationId: getString(appointmentIntent, "organization_id"),
        appointmentIntentId,
        appointmentIntent,
        toPhoneE164: getString(appointmentIntent, "caller_phone_e164"),
        messageType: "payment_link",
        status: "failed",
        error,
      },
      {
        operation: "create_payment_link",
        failureEventName: "square.manual_payment_link.message_event_insert_failed",
      },
    );
    await insertWorkflowEvent(supabase, {
      organization_id: getString(appointmentIntent, "organization_id"),
      appointment_intent_id: appointmentIntentId,
      event_type: "failed",
      status: "failed",
      payload: { reason: "message_send_failed", message: safeError },
    });
    await safeUpdateLastError(supabase, appointmentIntentId, safeError);
    logWarn("square.manual_payment_link.message_send_failed", {
      appointmentIntentId,
      message: safeError,
    });

    return {
      appointmentIntent,
      paymentLinkSent: false,
      error: safeError,
    };
  }
}

async function updateAppointmentIntent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntentId: string,
  patch: SupabaseRow,
) {
  const { data, error } = await supabase
    .from("appointment_intents")
    .update(patch)
    .eq("id", appointmentIntentId)
    .select("*")
    .single();

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
    logWarn("square.manual_payment_link.last_error_update_failed", { message: error.message });
  }
}

async function upsertAppointmentPayment(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  const normalizedRow = normalizeAppointmentPaymentRow(row);
  const paymentId = getString(normalizedRow, "square_payment_id");
  const paymentLinkId = getString(normalizedRow, "square_payment_link_id");
  const appointmentIntentId = getString(normalizedRow, "appointment_intent_id");

  if (paymentId) {
    const { data: existing, error: lookupError } = await supabase
      .from("appointment_payments")
      .select("id")
      .eq("square_payment_id", paymentId)
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      logWarn("square.manual_payment_link.payment_lookup_failed", { message: lookupError.message });
      return;
    }

    const existingId = getString(existing, "id");

    if (existingId) {
      const { error } = await supabase.from("appointment_payments").update(normalizedRow).eq("id", existingId);

      if (error) {
        logWarn("square.manual_payment_link.payment_update_failed", { message: error.message });
      }

      return;
    }

    const { error } = await supabase.from("appointment_payments").insert(normalizedRow);

    if (error) {
      if (isUniqueViolation(error)) {
        const { error: updateError } = await supabase.from("appointment_payments").update(normalizedRow).eq("square_payment_id", paymentId);

        if (updateError) {
          logWarn("square.manual_payment_link.payment_update_after_conflict_failed", { message: updateError.message });
        }

        return;
      }

      logWarn("square.manual_payment_link.payment_insert_failed", { message: error.message });
    }

    return;
  }

  if (appointmentIntentId && paymentLinkId) {
    const { data: existing, error: lookupError } = await supabase
      .from("appointment_payments")
      .select("id")
      .eq("appointment_intent_id", appointmentIntentId)
      .eq("square_payment_link_id", paymentLinkId)
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      logWarn("square.manual_payment_link.payment_lookup_failed", { message: lookupError.message });
      return;
    }

    if (existing?.id) {
      const { error } = await supabase.from("appointment_payments").update(normalizedRow).eq("id", existing.id);

      if (error) {
        logWarn("square.manual_payment_link.payment_update_failed", { message: error.message });
      }

      return;
    }
  }

  const { error } = await supabase.from("appointment_payments").insert(normalizedRow);

  if (error) {
    logWarn("square.manual_payment_link.payment_insert_failed", { message: error.message });
  }
}

function isUniqueViolation(error: { code?: string | null; message?: string | null }) {
  return error.code === "23505" || /duplicate key/i.test(error.message ?? "");
}

async function insertWorkflowEvent(supabase: ReturnType<typeof getSupabaseAdmin>, row: SupabaseRow) {
  await insertAppointmentWorkflowEvent(supabase, row, {
    operation: "create_payment_link",
    failureEventName: "square.manual_payment_link.workflow_event_insert_failed",
  });
}

function buildResponse(
  appointmentIntent: SupabaseRow,
  paymentLinkSent: boolean,
  messageError?: string,
  paymentLinkAction: "created" | "reused" | "ignored" = "reused",
) {
  const pricingDetails = buildDepositPricingDetailsFromIntent(appointmentIntent);

  return {
    payment_link_action: paymentLinkAction,
    created: paymentLinkAction === "created",
    reused: paymentLinkAction === "reused",
    ignored: paymentLinkAction === "ignored",
    appointment_intent_id: requireString(appointmentIntent, "id"),
    payment_status: getString(appointmentIntent, "payment_status") ?? "pending",
    appointment_status: getString(appointmentIntent, "appointment_status") ?? "payment_link_created",
    square_order_id: getString(appointmentIntent, "square_order_id"),
    square_payment_link_id: getString(appointmentIntent, "square_payment_link_id"),
    checkout_url: getString(appointmentIntent, "square_payment_link_url"),
    brandedPayUrl: getBrandedPayUrl(getString(appointmentIntent, "id")),
    service_price_cents: pricingDetails.service_price_cents,
    deposit_percent: pricingDetails.deposit_percent,
    deposit_percent_bps: pricingDetails.deposit_percent_bps,
    deposit_amount_cents: pricingDetails.deposit_amount_cents,
    currency: pricingDetails.currency,
    service_price_text: pricingDetails.service_price_text,
    deposit_amount_text: pricingDetails.deposit_amount_text,
    deposit_policy_text: pricingDetails.deposit_policy_text,
    human_deposit_sentence: pricingDetails.human_deposit_sentence,
    payment_link_sent: paymentLinkSent,
    message_error: messageError,
  };
}

function buildDepositPricingDetailsFromIntent(appointmentIntent: SupabaseRow) {
  return buildDepositPricingDetails({
    serviceName: getString(appointmentIntent, "service_name") ?? "Appointment",
    servicePriceCents: getNumberOrNull(appointmentIntent, "service_price_cents"),
    depositPercentBps: getNumberOrNull(appointmentIntent, "deposit_percent_bps"),
    depositAmountCents: getNumberOrNull(appointmentIntent, "deposit_amount_cents"),
    currency: getString(appointmentIntent, "currency") ?? "USD",
  });
}

function getBrandedPayUrl(appointmentIntentId: string | null) {
  if (!appointmentIntentId) {
    return null;
  }

  const token = createPayToken({ appointmentIntentId, expiresInMinutes: 60 * 24 * 14 });
  return `${getPublicAppUrl()}/pay/${token}`;
}

function getPublicAppUrl() {
  return (process.env.PUBLIC_APP_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function requireString(row: SupabaseRow, key: string) {
  const value = getString(row, key);

  if (!value) {
    throw new Error(`appointment_intents.${key} is required.`);
  }

  return value;
}

function getString(row: unknown, key: string) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }

  const record = row as SupabaseRow;
  const value = record[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireNumber(row: SupabaseRow, key: string) {
  const value = Number(row[key]);

  if (!Number.isFinite(value)) {
    throw new Error(`appointment_intents.${key} must be numeric.`);
  }

  return value;
}

function getNumberOrNull(row: SupabaseRow, key: string) {
  if (row[key] === undefined || row[key] === null || row[key] === "") {
    return null;
  }

  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}
