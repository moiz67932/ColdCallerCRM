import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/api-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { logError } from "@/lib/logger";
import { AppointmentIdParamSchema } from "@/lib/validation/paid-appointment";
import { failJson, okJson, validationFailJson } from "@/lib/api/paid-appointment-response";

type SupabaseRow = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN = /(access_token|api_key|authorization|bearer|card|cvv|cvc|pan|secret|signature_key|token)/i;

function routeError(errorCode: string, step: string, message: string, status = 400) {
  return failJson({ errorCode, step, message }, { status });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authError = await requireApiAuth(request);

  if (authError) {
    return authError;
  }

  const parsedParams = AppointmentIdParamSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    return validationFailJson({
      step: "validate_id",
      message: "Appointment intent id must be a valid UUID.",
      error: parsedParams.error,
    });
  }
  const appointmentIntentId = parsedParams.data.id;

  const supabase = getSupabaseAdmin();
  let appointmentIntent: SupabaseRow | null;

  try {
    appointmentIntent = await loadSingleRow(supabase, "appointment_intents", "id", appointmentIntentId);
  } catch (error) {
    return handleLoadError(error, "load_appointment_intent");
  }

  if (!appointmentIntent) {
    return routeError(
      "APPOINTMENT_NOT_FOUND",
      "load_appointment_intent",
      "No appointment intent found for this id.",
      404,
    );
  }

  let relatedRows: Awaited<ReturnType<typeof loadAppointmentDebugRows>>;

  try {
    relatedRows = await loadAppointmentDebugRows(supabase, appointmentIntent, appointmentIntentId);
  } catch (error) {
    return handleLoadError(error, "load_related_appointment_state");
  }

  return okJson(
    {
      appointment_intent: sanitizeForDebug(appointmentIntent),
      appointment_payments: sanitizeForDebug(relatedRows.appointmentPayments),
      message_events: sanitizeForDebug(relatedRows.messageEvents),
      workflow_events: sanitizeForDebug(relatedRows.workflowEvents),
      appointment_request: sanitizeForDebug(relatedRows.appointmentRequest),
      appointment: sanitizeForDebug(relatedRows.appointment),
    },
    { step: "appointment_debug_loaded", message: "Appointment debug state loaded.", appointmentIntentId },
  );
}

async function loadAppointmentDebugRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  appointmentIntent: SupabaseRow,
  appointmentIntentId: string,
) {
  const [appointmentPayments, messageEvents, workflowEvents, appointmentRequest, appointment] = await Promise.all([
    loadRelatedRows(supabase, "appointment_payments", "appointment_intent_id", appointmentIntentId),
    loadRelatedRows(supabase, "message_events", "appointment_intent_id", appointmentIntentId),
    loadRelatedRows(supabase, "appointment_workflow_events", "appointment_intent_id", appointmentIntentId),
    loadOptionalLinkedRow(supabase, "appointment_requests", getString(appointmentIntent, "appointment_request_id")),
    loadOptionalLinkedRow(supabase, "appointments", getString(appointmentIntent, "appointment_id")),
  ]);

  return {
    appointmentPayments,
    messageEvents,
    workflowEvents,
    appointmentRequest,
    appointment,
  };
}

async function loadSingleRow(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  column: string,
  value: string,
) {
  const { data, error } = await supabase.from(table).select("*").eq(column, value).maybeSingle();

  if (error) {
    throw new Error(`Failed to load ${table}: ${error.message}`);
  }

  return data as SupabaseRow | null;
}

async function loadRelatedRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  column: string,
  value: string,
) {
  const { data, error } = await supabase.from(table).select("*").eq(column, value).order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load ${table}: ${error.message}`);
  }

  return (data ?? []) as SupabaseRow[];
}

async function loadOptionalLinkedRow(supabase: ReturnType<typeof getSupabaseAdmin>, table: string, id: string | null) {
  if (!id) {
    return null;
  }

  return loadSingleRow(supabase, table, "id", id);
}

function sanitizeForDebug(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForDebug);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as SupabaseRow).map(([key, nestedValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeForDebug(nestedValue),
    ]),
  );
}

function getString(row: SupabaseRow, key: string) {
  const value = row[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function handleLoadError(error: unknown, step: string) {
  logError("appointments.debug_detail.load_failed", {
    step,
    message: error instanceof Error ? error.message : "Unknown error",
  });

  return routeError("APPOINTMENT_DEBUG_LOAD_FAILED", step, "Unable to load appointment debug details.", 500);
}
