import { extractedProfileSchema, weekdayOrder, type ExtractedProfile } from "@/lib/demo-agent/contracts";

export type VoiceContextCompact = {
  clinic_name: string;
  lead_id: string;
  binding_id: string | null;
  phone_e164: string;
  service_categories_short: string;
  service_menu_short: string;
  safe_service_names: string[];
  safe_service_names_text: string;
  category_lists: Record<string, string>;
  facials_list_text: string;
  injectables_list_text: string;
  pricing_lookup_text: string;
  booking_cta: string;
  clinic_phone: string;
  location_short: string;
  hours_short: string;
  timezone?: string;
};

const MAX_SPOKEN_SERVICES = 8;

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

function serviceVoiceCategory(service: ExtractedProfile["services"][number]) {
  const explicit = cleanText(service.voice_category ?? service.category);
  if (explicit) return explicit;
  const lower = cleanText(service.name).toLowerCase();
  if (/botox|dysport|filler|kybella|sculptra|pdo|thread/.test(lower)) return "Injectables";
  if (/facial|hydra|acne/.test(lower)) return "Facials";
  if (/microchannel|microneedl|peel|resurfac|plasma/.test(lower)) return "Advanced skin services";
  if (/laser|ipl|radiofrequency|rf/.test(lower)) return "Laser services";
  if (/consult/.test(lower)) return "Consultations";
  if (/cleaning|exam|filling|root canal|emergency/.test(lower)) return "Dental general";
  if (/whitening|veneer|invisalign/.test(lower)) return "Dental cosmetic";
  return "";
}

function compactCategoryLabel(category: string) {
  const lower = cleanText(category).toLowerCase();
  if (lower === "skin resurfacing") return "advanced skin services";
  if (lower === "laser and energy") return "laser services";
  if (lower === "body and wellness") return "body and wellness";
  return lower;
}

function categoryKey(category: string) {
  const lower = cleanText(category).toLowerCase();
  if (/facial/.test(lower)) return "facials";
  if (/inject/.test(lower)) return "injectables";
  if (/laser|energy/.test(lower)) return "laser";
  if (/skin|microchannel|resurfacing/.test(lower)) return "skin";
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function shortenServiceLabel(name: string) {
  const clean = cleanText(name)
    .replace(/^customized existing client facial$/i, "Customized Facial")
    .replace(/^clarifying acne facial$/i, "acne facial");
  return clean;
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
  const safeServices = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  const pricing: string[] = [];

  for (const service of profile.services) {
    const canonical = canonicalServiceName(service.name);
    if (canonical && !safeServices.has(canonical.key)) safeServices.set(canonical.key, canonical.label);
    const category = serviceVoiceCategory(service);
    if (category) {
      const list = grouped.get(category) ?? [];
      list.push(cleanText(service.voice_label) || cleanText(service.name));
      grouped.set(category, list);
    }
    const price = cleanText(service.price_summary ?? service.price_text);
    if ((service.price_available || price) && price && pricing.length < 8) {
      pricing.push(`${cleanText(service.name)}: ${price}`);
    }
  }

  const safeServiceNames = [...safeServices.values()];
  const clinicName = cleanText(profile.clinic.name) || "this clinic";
  const categoryEntries = [...grouped.entries()].sort((left, right) => right[1].length - left[1].length);
  const categoryLabels = categoryEntries.map(([category]) => compactCategoryLabel(category));
  const serviceCategoriesShort = formatServiceList([...new Set(categoryLabels)].slice(0, 5));
  const categoryLists = Object.fromEntries(
    categoryEntries.map(([category, names]) => [
      `${categoryKey(category)}_list_text`,
      formatServiceList([...new Set(names.map(shortenServiceLabel))].slice(0, 8)),
    ]),
  );
  const spokenServices = safeServiceNames
    .filter((name) => !/^(services|facials|facial|skin|injectables|wellness)$/i.test(name))
    .slice(0, MAX_SPOKEN_SERVICES)
    .map(shortenServiceLabel);

  return {
    clinic_name: clinicName,
    lead_id: input.leadId,
    binding_id: input.bindingId ?? null,
    phone_e164: input.phoneE164,
    service_categories_short: serviceCategoriesShort,
    service_menu_short: formatServiceList(spokenServices).slice(0, 220),
    safe_service_names: safeServiceNames,
    safe_service_names_text: safeServiceNames.join(", "),
    category_lists: categoryLists,
    facials_list_text: categoryLists.facials_list_text ?? "",
    injectables_list_text: categoryLists.injectables_list_text ?? "",
    pricing_lookup_text: pricing.join("; ").slice(0, 600),
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
    `Service categories: ${context.service_categories_short || context.service_menu_short || "Ask the clinic about available services."}.`,
    context.facials_list_text ? `Facials: ${context.facials_list_text}.` : "",
    context.injectables_list_text ? `Injectables: ${context.injectables_list_text}.` : "",
    context.pricing_lookup_text ? `Known pricing: ${context.pricing_lookup_text}.` : "",
    "Use this safely: list service names only. Do not explain medical benefits, outcomes, risks, or suitability. For details, say a licensed provider can explain during consultation.",
    `Booking CTA: ${context.booking_cta}`,
  ].filter(Boolean).join("\n");
}

export function parseVoiceContextCompact(value: unknown): VoiceContextCompact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const safeServiceNames = Array.isArray(record.safe_service_names) ? record.safe_service_names.map(cleanText).filter(Boolean) : [];
  const clinicName = cleanText(record.clinic_name);
  const serviceMenuShort = cleanText(record.service_menu_short);
  const rawCategoryLists = record.category_lists && typeof record.category_lists === "object" && !Array.isArray(record.category_lists) ? record.category_lists as Record<string, unknown> : {};
  const categoryLists = Object.fromEntries(Object.entries(rawCategoryLists).map(([key, value]) => [key, cleanText(value)]).filter(([, value]) => Boolean(value)));

  if (!clinicName && !safeServiceNames.length && !serviceMenuShort) return null;

  return {
    clinic_name: clinicName,
    lead_id: cleanText(record.lead_id),
    binding_id: cleanText(record.binding_id) || null,
    phone_e164: cleanText(record.phone_e164),
    service_categories_short: cleanText(record.service_categories_short),
    service_menu_short: serviceMenuShort,
    safe_service_names: safeServiceNames,
    safe_service_names_text: cleanText(record.safe_service_names_text) || safeServiceNames.join(", "),
    category_lists: categoryLists,
    facials_list_text: cleanText(record.facials_list_text) || categoryLists.facials_list_text || "",
    injectables_list_text: cleanText(record.injectables_list_text) || categoryLists.injectables_list_text || "",
    pricing_lookup_text: cleanText(record.pricing_lookup_text),
    booking_cta: cleanText(record.booking_cta) || "Would you like to book a consultation?",
    clinic_phone: cleanText(record.clinic_phone),
    location_short: cleanText(record.location_short),
    hours_short: cleanText(record.hours_short),
    timezone: cleanText(record.timezone) || undefined,
  };
}
