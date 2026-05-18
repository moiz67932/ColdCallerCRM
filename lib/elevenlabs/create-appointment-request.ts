import { z } from "zod";

import { extractedProfileSchema } from "@/lib/demo-agent/contracts";
import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

type CreateAppointmentDb = typeof prisma;
type Row = Record<string, unknown>;

export const createAppointmentRequestSchema = z.object({
  conversation_id: z.string().trim().min(1).optional(),
  lead_demo_profile_id: z.string().trim().min(1).optional(),
  lead_id: z.string().trim().min(1).optional(),
  binding_id: z.string().trim().min(1).optional(),
  caller_number: z.string().trim().min(1).optional(),
  called_number: z.string().trim().min(1).optional(),
  agent_id: z.string().trim().min(1).optional(),
  patient_name: z.string().trim().min(1),
  patient_phone: z.string().trim().min(1),
  patient_email: z.string().trim().email().optional(),
  service_name: z.string().trim().min(1),
  preferred_date: z.string().trim().min(1),
  preferred_time: z.string().trim().min(1),
  timezone: z.string().trim().min(1).optional(),
  duration_minutes: z.number().int().positive().max(480).optional(),
  new_or_returning: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  insurance_info: z.union([z.string().trim().min(1), z.record(z.string(), z.unknown())]).optional(),
});

export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

export class CreateAppointmentRequestError extends Error {
  constructor(
    readonly error: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CreateAppointmentRequestError";
  }
}

type CreateAppointmentDeps = {
  db?: CreateAppointmentDb;
  logger?: Pick<Console, "warn">;
};

function normalizeServiceText(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function isActiveAppointmentType(row: Row) {
  if (row.active === false || row.isActive === false) return false;
  if (typeof row.status === "string" && ["inactive", "archived", "deleted"].includes(row.status.toLowerCase())) return false;
  return true;
}

function maskPhone(phoneE164: string) {
  const last4 = phoneE164.replace(/\D/g, "").slice(-4);
  if (phoneE164.startsWith("+1") && last4.length === 4) return `+1******${last4}`;
  return last4 ? `******${last4}` : "";
}

function getString(row: Row | null | undefined, key: string) {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function resolveActiveDemo(input: CreateAppointmentRequest, db: CreateAppointmentDb) {
  let binding: Row | null = null;
  let profile: Row | null = null;

  if (input.binding_id) {
    binding = (await db.elevenlabsDemoBinding.findUnique({ where: { id: input.binding_id } })) as Row | null;
    if (binding) {
      profile = (await db.leadDemoProfile.findUnique({ where: { id: binding.leadDemoProfileId } })) as Row | null;
    }
  } else if (input.lead_demo_profile_id) {
    profile = (await db.leadDemoProfile.findUnique({ where: { id: input.lead_demo_profile_id } })) as Row | null;
  } else if (input.lead_id) {
    profile = (await db.leadDemoProfile.findUnique({ where: { leadId: input.lead_id } })) as Row | null;
  } else if (input.caller_number && input.called_number) {
    const callerE164 = normalizePhoneNumber(input.caller_number);
    const calledE164 = normalizePhoneNumber(input.called_number);

    if (!callerE164 || !calledE164) {
      throw new CreateAppointmentRequestError("active_demo_not_found", 404, "Active demo not found.");
    }

    binding = (await db.elevenlabsDemoBinding.findFirst({
      where: {
        callerE164,
        phoneE164: calledE164,
        status: "active",
      },
      orderBy: { createdAt: "desc" },
    })) as Row | null;

    if (binding) {
      profile = (await db.leadDemoProfile.findUnique({ where: { id: binding.leadDemoProfileId } })) as Row | null;
    }
  }

  if (!profile && binding) {
    profile = (await db.leadDemoProfile.findUnique({ where: { id: binding.leadDemoProfileId } })) as Row | null;
  }

  if (!profile && !binding) {
    throw new CreateAppointmentRequestError("active_demo_not_found", 404, "Active demo not found.");
  }

  if (!profile) {
    throw new CreateAppointmentRequestError("active_demo_not_found", 404, "Active demo profile not found.");
  }

  return { binding, profile };
}

export async function findBestAppointmentTypeForService(
  input: { organizationId: string; clinicId: string; serviceName: string },
  deps: CreateAppointmentDeps = {},
) {
  const db = deps.db ?? prisma;
  const normalizedService = normalizeServiceText(input.serviceName);
  const rows = ((await db.appointmentType.findMany({
    where: {
      organizationId: input.organizationId,
      clinicId: input.clinicId,
    },
    orderBy: { createdAt: "asc" },
  })) ?? []) as Row[];
  const activeRows = rows.filter(isActiveAppointmentType);

  const exact = activeRows.find((row) => normalizeServiceText(String(row.name ?? "")) === normalizedService);
  const fuzzy =
    exact ??
    activeRows.find((row) => {
      const normalizedName = normalizeServiceText(String(row.name ?? ""));
      return normalizedName.includes(normalizedService) || normalizedService.includes(normalizedName);
    });

  return fuzzy
    ? {
        id: String(fuzzy.id),
        durationMinutes: typeof fuzzy.durationMinutes === "number" && fuzzy.durationMinutes > 0 ? fuzzy.durationMinutes : null,
      }
    : null;
}

async function findProviderForAppointmentType(
  input: { organizationId: string; appointmentTypeId: string },
  db: CreateAppointmentDb,
) {
  const row = (await db.appointmentTypeProvider.findFirst({
    where: {
      organizationId: input.organizationId,
      appointmentTypeId: input.appointmentTypeId,
    },
    orderBy: { createdAt: "asc" },
  })) as Row | null;

  return getString(row, "providerId");
}

function parsePreferredDate(input: string) {
  const value = input.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return { year, month, day };
    }
    return null;
  }

  const natural = value.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*)?(\d{4})$/);
  if (!natural) return null;

  const monthIndex = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(natural[1].toLowerCase());
  if (monthIndex < 0) return null;

  const year = Number(natural[3]);
  const month = monthIndex + 1;
  const day = Number(natural[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function parsePreferredTime(input: string) {
  const value = input.trim().toLowerCase().replace(/\s+/g, " ");
  const twentyFour = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFour) return { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]) };

  const twelve = value.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/);
  if (!twelve) return null;

  const rawHour = Number(twelve[1]);
  if (rawHour < 1 || rawHour > 12) return null;
  const minute = twelve[2] ? Number(twelve[2]) : 0;
  const hour = twelve[3] === "am" ? rawHour % 12 : (rawHour % 12) + 12;
  return { hour, minute };
}

function formatParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function localClinicTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(new Date());
  } catch {
    return null;
  }

  const desired = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  let utcMs = desired;

  for (let index = 0; index < 4; index += 1) {
    const parts = formatParts(new Date(utcMs), input.timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = desired - actual;
    if (diff === 0) break;
    utcMs += diff;
  }

  const verified = formatParts(new Date(utcMs), input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return new Date(utcMs);
}

function parseAppointmentDateTime(input: {
  preferredDate: string;
  preferredTime: string;
  timeZone: string;
  durationMinutes: number;
}) {
  const date = parsePreferredDate(input.preferredDate);
  const time = parsePreferredTime(input.preferredTime);
  if (!date || !time) return null;

  const startTime = localClinicTimeToUtc({ ...date, ...time, timeZone: input.timeZone });
  if (!startTime) return null;

  const endTime = new Date(startTime.getTime() + input.durationMinutes * 60 * 1000);
  return { startTime, endTime };
}

function buildNotes(input: CreateAppointmentRequest) {
  return [
    input.notes,
    input.new_or_returning ? `New or returning: ${input.new_or_returning}` : null,
    "Created by ElevenLabs voice agent",
  ]
    .filter(Boolean)
    .join("\n");
}

function friendlyDateTime(startTime: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(startTime);
}

async function linkConversationToAppointment(
  input: { conversationId: string; appointmentId: string },
  db: CreateAppointmentDb,
  logger: Pick<Console, "warn">,
) {
  try {
    const conversation = (await db.elevenlabsConversation.findUnique({
      where: { conversationId: input.conversationId },
    })) as Row | null;

    if (!conversation) return;

    const metadataJson =
      conversation.metadataJson && typeof conversation.metadataJson === "object" && !Array.isArray(conversation.metadataJson)
        ? { ...(conversation.metadataJson as Row) }
        : {};

    await db.elevenlabsConversation.update({
      where: { conversationId: input.conversationId },
      data: {
        metadataJson: {
          ...metadataJson,
          appointment_id: input.appointmentId,
        },
      },
    });
  } catch (error) {
    logger.warn("Unable to link ElevenLabs conversation to appointment.", error);
  }
}

export async function createElevenLabsAppointmentRequest(
  input: CreateAppointmentRequest,
  deps: CreateAppointmentDeps = {},
) {
  const db = deps.db ?? prisma;
  const logger = deps.logger ?? console;
  const { binding, profile } = await resolveActiveDemo(input, db);
  const organizationId = getString(binding, "organizationId") ?? getString(profile, "organizationId");
  const clinicId = getString(profile, "clinicId");
  const agentId = getString(profile, "agentId") ?? null;

  if (!organizationId) {
    throw new CreateAppointmentRequestError("active_demo_not_found", 404, "Active demo organization not found.");
  }

  if (!clinicId) {
    throw new CreateAppointmentRequestError(
      "clinic_missing",
      400,
      "The active demo profile is missing clinic information.",
    );
  }

  const extractedProfile = extractedProfileSchema.parse(profile.extractedProfileJson);
  const appointmentType = await findBestAppointmentTypeForService(
    {
      organizationId,
      clinicId,
      serviceName: input.service_name,
    },
    { db },
  );
  const durationMinutes = appointmentType?.durationMinutes ?? input.duration_minutes ?? 30;
  const timeZone = input.timezone ?? extractedProfile.clinic.timezone ?? "America/New_York";
  const parsedDateTime = parseAppointmentDateTime({
    preferredDate: input.preferred_date,
    preferredTime: input.preferred_time,
    timeZone,
    durationMinutes,
  });

  if (!parsedDateTime) {
    throw new CreateAppointmentRequestError(
      "missing_or_invalid_time",
      400,
      "Please collect a clear appointment date and time before creating the request.",
    );
  }

  const patientPhone = normalizePhoneNumber(input.patient_phone);
  if (!patientPhone) {
    throw new CreateAppointmentRequestError("invalid_patient_phone", 400, "Please collect a valid patient phone number.");
  }

  const providerId = appointmentType?.id
    ? await findProviderForAppointmentType({ organizationId, appointmentTypeId: appointmentType.id }, db)
    : null;

  const appointment = (await db.appointment.create({
    data: {
      organizationId,
      clinicId,
      providerId,
      appointmentTypeId: appointmentType?.id ?? null,
      callSessionId: input.conversation_id ?? null,
      patientName: input.patient_name,
      patientPhoneMasked: maskPhone(patientPhone),
      patientEmail: input.patient_email ?? null,
      startTime: parsedDateTime.startTime,
      endTime: parsedDateTime.endTime,
      status: "scheduled",
      source: "ai",
      reason: input.service_name,
      notes: buildNotes(input),
      insuranceInfo: input.insurance_info ?? null,
      calendarProvider: "internal",
      calendarId: null,
      calendarEventId: null,
      agentId,
      callLogId: null,
      callerName: input.patient_name,
      callerPhone: patientPhone,
    },
  })) as Row;

  const appointmentId = String(appointment.id);
  if (input.conversation_id) {
    await linkConversationToAppointment({ conversationId: input.conversation_id, appointmentId }, db, logger);
  }

  return {
    ok: true,
    status: "created" as const,
    appointment_id: appointmentId,
    clinic_id: clinicId,
    organization_id: organizationId,
    start_time: parsedDateTime.startTime.toISOString(),
    end_time: parsedDateTime.endTime.toISOString(),
    service_name: input.service_name,
    patient_name: input.patient_name,
    message: `Appointment request created for ${input.patient_name} on ${friendlyDateTime(parsedDateTime.startTime, timeZone)}.`,
  };
}
