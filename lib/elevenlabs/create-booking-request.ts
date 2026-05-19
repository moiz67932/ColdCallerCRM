import { z } from "zod";

import { normalizePhoneDigits, normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";
import { parseVoiceContextCompact } from "@/lib/elevenlabs/voice-context";

type BookingDb = typeof prisma;
type Row = Record<string, unknown>;
type DemoBinding = Awaited<ReturnType<BookingDb["elevenlabsDemoBinding"]["findMany"]>>[number];

type CreateBookingDeps = {
  db?: BookingDb;
};

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().min(1).optional(),
);
const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().trim().email().optional(),
);

export const createBookingRequestSchema = z.object({
  conversation_id: z.string().trim().min(1),
  caller_number: optionalTrimmedString,
  called_number: optionalTrimmedString,
  agent_id: optionalTrimmedString,
  lead_id: optionalTrimmedString,
  lead_demo_profile_id: optionalTrimmedString,
  binding_id: optionalTrimmedString,
  client_name: z.string().trim().min(1),
  phone: optionalTrimmedString,
  email: optionalEmail,
  service_requested: z.string().trim().min(1),
  preferred_date_time: z.string().trim().min(1),
  new_or_existing: optionalTrimmedString,
  special_requests: optionalTrimmedString,
});

export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

function phoneLookupCandidates(digits: string) {
  return [...new Set([`+${digits}`, digits])];
}

function normalizeLookup(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function serviceMatchStatus(requested: string, safeServiceNames: string[]) {
  if (!safeServiceNames.length) return "not_checked";
  const requestedText = normalizeLookup(requested);
  const matched = safeServiceNames.some((service) => {
    const serviceText = normalizeLookup(service);
    return serviceText === requestedText || serviceText.includes(requestedText) || requestedText.includes(serviceText);
  });
  return matched ? "matched" : "unconfirmed_service";
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const utc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return utc - date.getTime();
}

function zonedTimeToUtc(input: { year: number; month: number; day: number; hour: number; minute: number; timeZone: string }) {
  const utcGuess = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute));
  const offset = getTimeZoneOffsetMs(utcGuess, input.timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function parsePreferredDateTime(value: string, timeZone = "America/New_York") {
  const trimmed = value.trim();
  const isoParsed = Date.parse(trimmed);
  if (Number.isFinite(isoParsed) && /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return new Date(isoParsed);

  const match = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[ t]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let hour = match[4] ? Number(match[4]) : 9;
  const minute = match[5] ? Number(match[5]) : 0;
  const meridiem = match[6]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!year || !month || !day || hour > 23 || minute > 59) return null;

  return zonedTimeToUtc({ year, month, day, hour, minute, timeZone });
}

function success(requestId: string) {
  return {
    ok: true,
    status: "saved" as const,
    request_id: requestId,
    booking_status: "pending" as const,
    message_for_agent: "Perfect, I’ve sent that request to the clinic team. They’ll follow up to confirm the appointment.",
  };
}

function error(reason: string) {
  return { ok: false, status: "error" as const, reason };
}

function findCalledMatches(bindings: DemoBinding[], calledDigits: string) {
  return bindings.filter((row) => normalizePhoneDigits(row.phoneE164) === calledDigits);
}

async function resolveBinding(input: CreateBookingRequest, db: BookingDb) {
  if (input.binding_id) {
    const binding = (await db.elevenlabsDemoBinding.findUnique({ where: { id: input.binding_id } })) as DemoBinding | null;
    if (binding && binding.status === "active") return { binding, callerMatched: true, calledMatched: true };
  }

  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);
  if (!calledDigits) return { binding: null, callerMatched: false, calledMatched: false };

  const candidates = (await db.elevenlabsDemoBinding.findMany({
    where: {
      status: "active",
      phoneE164: { in: phoneLookupCandidates(calledDigits) },
    },
    orderBy: { createdAt: "desc" },
  })) as DemoBinding[];
  const calledMatches = findCalledMatches(candidates, calledDigits);
  const callerMatch = callerDigits ? calledMatches.find((row) => normalizePhoneDigits(row.callerE164) === callerDigits) : null;
  const binding = callerMatch ?? calledMatches[0] ?? null;

  return {
    binding,
    callerMatched: Boolean(callerMatch),
    calledMatched: calledMatches.length > 0,
  };
}

export async function createElevenLabsBookingRequest(input: CreateBookingRequest, deps: CreateBookingDeps = {}) {
  const db = deps.db ?? prisma;
  const parsed = createBookingRequestSchema.safeParse(input);

  if (!parsed.success) return error("missing_required_field");

  const data = parsed.data;
  const resolved = await resolveBinding(data, db);
  const binding = resolved.binding;

  if (!binding) {
    return error("no_active_demo_binding_found");
  }

  const context = parseVoiceContextCompact(binding.voiceContextCompactJson);
  const timezone = context?.timezone || "America/New_York";
  const serviceStatus = serviceMatchStatus(data.service_requested, context?.safe_service_names ?? []);
  const phoneE164 = normalizePhoneNumber(data.phone ?? data.caller_number ?? "") ?? (data.phone ? null : binding.callerE164 ?? null);
  const callerE164 = normalizePhoneNumber(data.caller_number ?? "") ?? binding.callerE164 ?? null;
  const calledE164 = normalizePhoneNumber(data.called_number ?? "") ?? binding.phoneE164 ?? null;
  const preferredStart = parsePreferredDateTime(data.preferred_date_time, timezone);

  const existing = (await db.appointmentRequest.findFirst({
    where: {
      conversationId: data.conversation_id,
      clientName: data.client_name,
      serviceRequested: data.service_requested,
      preferredDateTimeText: data.preferred_date_time,
    },
    orderBy: { createdAt: "desc" },
  })) as Row | null;

  if (existing?.id) {
    console.info("ElevenLabs create-booking-request duplicate.", {
      request_id: existing.id,
      conversation_id: data.conversation_id,
      normalized_caller_digits: normalizePhoneDigits(data.caller_number),
      normalized_called_digits: normalizePhoneDigits(data.called_number),
      binding_id: binding.id,
      lead_id: binding.leadId,
      status: "pending",
    });
    return success(String(existing.id));
  }

  let created: Row;
  try {
    created = (await db.appointmentRequest.create({
      data: {
        organizationId: binding.organizationId ?? null,
        leadId: data.lead_id ?? binding.leadId ?? null,
        leadDemoProfileId: data.lead_demo_profile_id ?? binding.leadDemoProfileId ?? null,
        bindingId: binding.id,
        conversationId: data.conversation_id,
        agentId: data.agent_id ?? null,
        callerE164,
        calledE164,
        clientName: data.client_name,
        phoneE164,
        email: data.email ?? null,
        serviceRequested: data.service_requested,
        preferredDateTimeText: data.preferred_date_time,
        preferredDateTimeStart: preferredStart,
        timezone,
        newOrExisting: data.new_or_existing ?? null,
        specialRequests: data.special_requests ?? null,
        status: "pending",
        source: "elevenlabs_voice",
        provider: "manual",
        providerBookingId: null,
        rawPayload: {
          service_match_status: serviceStatus,
          date_parse_status: preferredStart ? "parsed" : "unparsed",
          caller_matched: resolved.callerMatched,
          called_number_matched: resolved.calledMatched,
        },
      },
    })) as Row;
  } catch (createError) {
    const duplicate = (await db.appointmentRequest.findFirst({
      where: {
        conversationId: data.conversation_id,
        clientName: data.client_name,
        serviceRequested: data.service_requested,
        preferredDateTimeText: data.preferred_date_time,
      },
      orderBy: { createdAt: "desc" },
    })) as Row | null;
    if (duplicate?.id) return success(String(duplicate.id));
    throw createError;
  }

  console.info("ElevenLabs create-booking-request saved.", {
    request_id: created.id,
    conversation_id: data.conversation_id,
    normalized_caller_digits: normalizePhoneDigits(data.caller_number),
    normalized_called_digits: normalizePhoneDigits(data.called_number),
    binding_id: binding.id,
    lead_id: binding.leadId,
    status: "pending",
  });

  return success(String(created.id));
}
