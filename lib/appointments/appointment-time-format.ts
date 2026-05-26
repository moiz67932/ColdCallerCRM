import "server-only";

import { logWorkflowInfo } from "@/lib/logging/workflow-logger";

type AppointmentTimeFormatInput = {
  selectedStartAt?: string | null;
  selectedTimeDisplay?: string | null;
  timeZone?: string | null;
  appointmentIntentId?: string | null;
  operation?: string;
  step?: string;
};

type AppointmentTimeFormatResult = {
  formatted: string;
  originalUtc: string | null;
  timeZone: string;
  timeZoneFallbackUsed: boolean;
  displayFallbackUsed: boolean;
};

const DEFAULT_TIME_ZONE = "UTC";
const FALLBACK_DISPLAY = "the selected appointment time";

export function formatAppointmentDateTimeForMessage(input: AppointmentTimeFormatInput): string {
  return formatAppointmentDateTime(input).formatted;
}

export function formatAppointmentDateTime(input: AppointmentTimeFormatInput): AppointmentTimeFormatResult {
  const resolvedTimeZone = resolveTimeZone(input.timeZone);
  const date = parseDate(input.selectedStartAt);
  let formatted: string;
  let displayFallbackUsed = false;

  if (date) {
    formatted = formatDateInTimeZone(date, resolvedTimeZone.timeZone);
  } else {
    const display = input.selectedTimeDisplay?.trim();
    formatted = display && !looksLikeIsoDateTime(display) ? display : FALLBACK_DISPLAY;
    displayFallbackUsed = true;
  }

  logWorkflowInfo("appointment.datetime_formatted", {
    operation: input.operation ?? "appointment_message",
    step: input.step ?? "format_appointment_datetime",
    appointment_intent_id: input.appointmentIntentId,
    original_utc_time: input.selectedStartAt ?? null,
    clinic_timezone: resolvedTimeZone.timeZone,
    formatted_output: formatted,
    timezone_fallback_used: resolvedTimeZone.fallbackUsed,
    display_fallback_used: displayFallbackUsed,
  });

  return {
    formatted,
    originalUtc: input.selectedStartAt ?? null,
    timeZone: resolvedTimeZone.timeZone,
    timeZoneFallbackUsed: resolvedTimeZone.fallbackUsed,
    displayFallbackUsed,
  };
}

export function getAppointmentTimeZone(row: Record<string, unknown>) {
  return (
    getString(row, "selected_timezone") ??
    getString(row, "clinic_timezone") ??
    getString(row, "business_timezone") ??
    getString(row, "timezone") ??
    getString(row, "square_timezone") ??
    DEFAULT_TIME_ZONE
  );
}

function formatDateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  const dayPeriod = value("dayPeriod");
  const timeZoneName = value("timeZoneName");

  return `${weekday}, ${month} ${day} at ${hour}:${minute} ${dayPeriod} ${timeZoneName}`.replace(/\s+/g, " ").trim();
}

function resolveTimeZone(timeZone: string | null | undefined) {
  const candidate = timeZone?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return { timeZone: candidate, fallbackUsed: !timeZone?.trim() };
  } catch {
    return { timeZone: DEFAULT_TIME_ZONE, fallbackUsed: true };
  }
}

function parseDate(value: string | null | undefined) {
  if (!value?.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function looksLikeIsoDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function getString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
