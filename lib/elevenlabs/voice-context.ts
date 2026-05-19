import { extractedProfileSchema, weekdayOrder, type ExtractedProfile } from "@/lib/demo-agent/contracts";

export type VoiceContextCompact = {
  clinic_name: string;
  lead_id: string;
  binding_id: string | null;
  phone_e164: string;
  service_menu_short: string;
  safe_service_names: string[];
  booking_cta: string;
  clinic_phone: string;
  location_short: string;
  hours_short: string;
  timezone?: string;
};

const MAX_SERVICES = 12;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function canonicalServiceName(name: string) {
  const normalized = cleanText(name).toLowerCase().replace(/&/g, "and");
  if (!normalized) return null;
  if (/\b(botox|dysport)\b/.test(normalized)) return { key: "botox-dysport", label: "Botox and Dysport" };
  if (/\brussian lip\b/.test(normalized) || (/\blip\b/.test(normalized) && /\bfiller/.test(normalized))) {
    return { key: "lip-filler", label: "lip filler services" };
  }
  if (/\b(dermal\s*)?fillers?\b/.test(normalized)) return { key: "fillers", label: "fillers" };
  return { key: normalized.replace(/[^a-z0-9]+/g, " ").trim(), label: cleanText(name) };
}

function formatServiceList(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function summarizeHours(profile: ExtractedProfile) {
  const openDays = weekdayOrder
    .map((day) => ({ day, hours: profile.hours[day] }))
    .filter(({ hours }) => hours.open && hours.start && hours.end)
    .slice(0, 4)
    .map(({ day, hours }) => `${day.slice(0, 3)} ${hours.start}-${hours.end}`);
  return openDays.length ? openDays.join(", ") : "Ask the clinic for current hours.";
}

function summarizeLocation(profile: ExtractedProfile) {
  const address = profile.clinic.address;
  return [address.city, address.state].map(cleanText).filter(Boolean).join(", ") || cleanText(address.line1) || "";
}

export function buildVoiceContextCompact(input: {
  extractedProfileJson: unknown;
  leadId: string;
  bindingId?: string | null;
  phoneE164: string;
}): VoiceContextCompact {
  const profile = extractedProfileSchema.parse(input.extractedProfileJson);
  const services = new Map<string, string>();

  for (const service of profile.services) {
    const canonical = canonicalServiceName(service.name);
    if (canonical && !services.has(canonical.key)) services.set(canonical.key, canonical.label);
    if (services.size >= MAX_SERVICES) break;
  }

  const safeServiceNames = [...services.values()];
  const clinicName = cleanText(profile.clinic.name) || "this clinic";

  return {
    clinic_name: clinicName,
    lead_id: input.leadId,
    binding_id: input.bindingId ?? null,
    phone_e164: input.phoneE164,
    service_menu_short: formatServiceList(safeServiceNames),
    safe_service_names: safeServiceNames,
    booking_cta: "Would you like to book a consultation?",
    clinic_phone: cleanText(profile.clinic.phone),
    location_short: summarizeLocation(profile),
    hours_short: summarizeHours(profile),
    timezone: cleanText(profile.clinic.timezone) || undefined,
  };
}

export function voiceContextText(context: VoiceContextCompact) {
  return [
    `Clinic: ${context.clinic_name}.`,
    `Services: ${context.service_menu_short || "Ask the clinic about available services."}.`,
    "Use this safely: list service names only. Do not explain medical benefits, outcomes, risks, or suitability. For details, say a licensed provider can explain during consultation.",
    `Booking CTA: ${context.booking_cta}`,
  ].join("\n");
}

export function parseVoiceContextCompact(value: unknown): VoiceContextCompact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const safeServiceNames = Array.isArray(record.safe_service_names) ? record.safe_service_names.map(cleanText).filter(Boolean) : [];
  const clinicName = cleanText(record.clinic_name);
  const serviceMenuShort = cleanText(record.service_menu_short);

  if (!clinicName && !safeServiceNames.length && !serviceMenuShort) return null;

  return {
    clinic_name: clinicName,
    lead_id: cleanText(record.lead_id),
    binding_id: cleanText(record.binding_id) || null,
    phone_e164: cleanText(record.phone_e164),
    service_menu_short: serviceMenuShort,
    safe_service_names: safeServiceNames,
    booking_cta: cleanText(record.booking_cta) || "Would you like to book a consultation?",
    clinic_phone: cleanText(record.clinic_phone),
    location_short: cleanText(record.location_short),
    hours_short: cleanText(record.hours_short),
    timezone: cleanText(record.timezone) || undefined,
  };
}
