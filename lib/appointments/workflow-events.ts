import "server-only";

import type { getSupabaseAdmin } from "@/lib/supabase-admin";
import { normalizeWorkflowEventRow, type SupabaseRow } from "@/lib/category7-db";
import { logWarn } from "@/lib/logger";
import {
  logSupabaseWorkflowEvent,
  logWorkflowError,
  logWorkflowInfo,
} from "@/lib/logging/workflow-logger";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdmin>;

export type InsertAppointmentWorkflowEventOptions = {
  operation: string;
  failureEventName: string;
  appointmentIntent?: SupabaseRow | null;
};

export async function insertAppointmentWorkflowEvent(
  supabase: SupabaseAdminClient,
  row: SupabaseRow,
  options: InsertAppointmentWorkflowEventOptions,
) {
  const normalizedRow = await withResolvedOrganizationId(supabase, normalizeWorkflowEventRow(row), options);
  const appointmentIntentId = getString(normalizedRow, "appointment_intent_id");
  const organizationId = getString(normalizedRow, "organization_id");

  logWorkflowInfo("appointment.workflow_event.insert_attempt", {
    operation: options.operation,
    step: "insert_workflow_event",
    appointment_intent_id: appointmentIntentId,
    organization_id: organizationId,
    workflow_event_type: getString(normalizedRow, "event_type"),
    workflow_event_status: getString(normalizedRow, "event_status"),
    payload: { workflow_event: normalizedRow },
  });

  if (!organizationId) {
    logWorkflowError(options.failureEventName, {
      operation: options.operation,
      step: "insert_workflow_event",
      appointment_intent_id: appointmentIntentId,
      error_code: "WORKFLOW_EVENT_ORGANIZATION_MISSING",
      safe_message: "Skipping appointment_workflow_events insert because organization_id could not be resolved.",
      payload: { workflow_event: normalizedRow },
    });
    return;
  }

  const { error } = await supabase.from("appointment_workflow_events").insert(normalizedRow);

  if (error) {
    logWarn(options.failureEventName, { message: error.message });
    logWorkflowError(options.failureEventName, {
      operation: options.operation,
      step: "insert_workflow_event",
      appointment_intent_id: appointmentIntentId,
      organization_id: organizationId,
      error_code: "WORKFLOW_EVENT_INSERT_FAILED",
      safe_message: error.message,
      payload: { workflow_event: normalizedRow },
    });
    return;
  }

  logSupabaseWorkflowEvent({
    operation: options.operation,
    appointment_intent_id: appointmentIntentId,
    step: getString(normalizedRow, "event_type"),
    status: getString(normalizedRow, "event_status"),
    payload: normalizedRow.payload,
  });
}

async function withResolvedOrganizationId(
  supabase: SupabaseAdminClient,
  row: SupabaseRow,
  options: InsertAppointmentWorkflowEventOptions,
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
  options: InsertAppointmentWorkflowEventOptions,
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
    logWorkflowError("appointment.workflow_event.organization_lookup_failed", {
      operation: options.operation,
      step: "resolve_workflow_event_organization",
      appointment_intent_id: appointmentIntentId,
      error_code: "WORKFLOW_EVENT_ORGANIZATION_LOOKUP_FAILED",
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

function isRecord(value: unknown): value is SupabaseRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
