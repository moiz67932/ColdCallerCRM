import "server-only";

import type { getSupabaseAdmin } from "@/lib/supabase-admin";
import { normalizeMessageEventRow, type SupabaseRow } from "@/lib/category7-db";
import { logWarn } from "@/lib/logger";
import {
  logWorkflowError,
  logWorkflowInfo,
  sanitizeForWorkflowLog,
} from "@/lib/logging/workflow-logger";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdmin>;

export type InsertMessageEventOptions = {
  operation: string;
  failureEventName: string;
  appointmentIntent?: SupabaseRow | null;
};

export type InsertTelnyxMessageEventInput = {
  organizationId?: string | null;
  clinicId?: string | null;
  appointmentIntentId: string;
  appointmentIntent?: SupabaseRow | null;
  leadId?: string | null;
  leadDemoProfileId?: string | null;
  conversationId?: string | null;
  toPhoneE164?: string | null;
  messageType: string;
  providerMessageId?: string | null;
  status: "sent" | "failed";
  payload?: unknown;
  error?: unknown;
  now?: Date;
};

export async function insertTelnyxMessageEvent(
  supabase: SupabaseAdminClient,
  input: InsertTelnyxMessageEventInput,
  options: InsertMessageEventOptions,
) {
  const now = input.now ?? new Date();
  const providerError = input.status === "failed" ? toSafeProviderError(input.error) : null;
  const payload = input.status === "failed"
    ? compact({
        provider_error: providerError,
        payload: sanitizeForWorkflowLog(input.payload),
      })
    : input.payload ?? {};

  return insertMessageEvent(
    supabase,
    {
      organization_id: input.organizationId,
      clinic_id: input.clinicId,
      appointment_intent_id: input.appointmentIntentId,
      lead_id: input.leadId,
      lead_demo_profile_id: input.leadDemoProfileId,
      conversation_id: input.conversationId,
      provider: "telnyx",
      channel: "whatsapp",
      direction: "outbound",
      message_type: input.messageType,
      to_phone_e164: input.toPhoneE164,
      provider_message_id: input.providerMessageId,
      provider_status: input.status,
      status: input.status,
      sent_at: input.status === "sent" ? now.toISOString() : undefined,
      failed_at: input.status === "failed" ? now.toISOString() : undefined,
      error_message: providerError?.message,
      payload,
    },
    {
      ...options,
      appointmentIntent: input.appointmentIntent ?? options.appointmentIntent,
    },
  );
}

export async function insertMessageEvent(
  supabase: SupabaseAdminClient,
  row: SupabaseRow,
  options: InsertMessageEventOptions,
) {
  const normalizedRow = await withResolvedOrganizationId(supabase, normalizeMessageEventRow(row), options);
  const appointmentIntentId = getString(normalizedRow, "appointment_intent_id");
  const organizationId = getString(normalizedRow, "organization_id");

  logWorkflowInfo("appointment.message_event.insert_attempt", {
    operation: options.operation,
    step: "insert_message_event",
    appointment_intent_id: appointmentIntentId,
    organization_id: organizationId,
    message_type: getString(normalizedRow, "message_type"),
    provider: getString(normalizedRow, "provider"),
    channel: getString(normalizedRow, "channel"),
    status: getString(normalizedRow, "status"),
    telnyx_message_id: getString(normalizedRow, "provider_message_id"),
    payload: { message_event: normalizedRow },
  });

  if (!organizationId) {
    logWorkflowError(options.failureEventName, {
      operation: options.operation,
      step: "insert_message_event",
      appointment_intent_id: appointmentIntentId,
      error_code: "MESSAGE_EVENT_ORGANIZATION_MISSING",
      safe_message: "Skipping message_events insert because organization_id could not be resolved.",
      payload: { message_event: normalizedRow },
    });
    return false;
  }

  const { error } = await supabase.from("message_events").insert(normalizedRow);

  if (error) {
    logWarn(options.failureEventName, { message: error.message });
    logWorkflowError(options.failureEventName, {
      operation: options.operation,
      step: "insert_message_event",
      appointment_intent_id: appointmentIntentId,
      organization_id: organizationId,
      error_code: "MESSAGE_EVENT_INSERT_FAILED",
      safe_message: error.message,
      payload: { message_event: normalizedRow },
    });
    return false;
  }

  logWorkflowInfo("appointment.message_event.inserted", {
    operation: options.operation,
    step: "insert_message_event",
    appointment_intent_id: appointmentIntentId,
    organization_id: organizationId,
    message_type: getString(normalizedRow, "message_type"),
    provider: getString(normalizedRow, "provider"),
    channel: getString(normalizedRow, "channel"),
    status: getString(normalizedRow, "status"),
    telnyx_message_id: getString(normalizedRow, "provider_message_id"),
  });

  return true;
}

function toSafeProviderError(error: unknown) {
  if (!error) {
    return { message: "Unknown provider error." };
  }

  if (error instanceof Error) {
    const record: SupabaseRow = isRecord(error) ? error : {};

    return compact({
      name: error.name,
      message: error.message,
      status: getNumber(record, "status"),
      error_body: sanitizeForWorkflowLog(record["errorBody"] ?? record["error_body"]),
    });
  }

  if (typeof error === "string") {
    return { message: truncate(error) };
  }

  return compact({
    message: "Unknown provider error.",
    error_body: sanitizeForWorkflowLog(error),
  });
}

async function withResolvedOrganizationId(
  supabase: SupabaseAdminClient,
  row: SupabaseRow,
  options: InsertMessageEventOptions,
) {
  if (getString(row, "organization_id")) {
    return row;
  }

  const organizationId =
    getString(options.appointmentIntent, "organization_id") ||
    getNestedString(row, "appointment_intent", "organization_id") ||
    getNestedString(row, "appointmentIntent", "organization_id") ||
    (await findAppointmentIntentOrganizationId(supabase, getString(row, "appointment_intent_id"), options));

  return organizationId ? { ...row, organization_id: organizationId } : row;
}

async function findAppointmentIntentOrganizationId(
  supabase: SupabaseAdminClient,
  appointmentIntentId: string | null,
  options: InsertMessageEventOptions,
) {
  if (!appointmentIntentId) {
    return null;
  }

  const { data, error } = await supabase
    .from("appointment_intents")
    .select("organization_id")
    .eq("id", appointmentIntentId)
    .maybeSingle();

  if (error) {
    logWorkflowError("appointment.message_event.organization_lookup_failed", {
      operation: options.operation,
      step: "resolve_message_event_organization",
      appointment_intent_id: appointmentIntentId,
      error_code: "MESSAGE_EVENT_ORGANIZATION_LOOKUP_FAILED",
      safe_message: error.message,
    });
    return null;
  }

  return getString((data ?? {}) as SupabaseRow, "organization_id");
}

function getNestedString(row: SupabaseRow, objectKey: string, valueKey: string) {
  const value = row[objectKey];

  if (!isRecord(value)) {
    return null;
  }

  return getString(value, valueKey);
}

function getString(row: SupabaseRow | null | undefined, key: string) {
  const value = row?.[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(row: SupabaseRow, key: string) {
  const value = Number(row[key]);

  return Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is SupabaseRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)) as Partial<T>;
}

function truncate(value: string) {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}
