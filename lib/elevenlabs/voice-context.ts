import { extractedProfileSchema, weekdayOrder, type ExtractedProfile } from "@/lib/demo-agent/contracts";

export type VoiceContextCompact = {
  clinic_name: string;
  lead_id: string;
  binding_id: string | null;
  phone_e164: string;
  service_categories_short: string;
  service_menu_short: string;
  service_menu_spoken_short: string;
  services_by_category_text: string;
  safe_service_names: string[];
  safe_service_names_text: string;
  category_lists: Record<string, string>;
  facials_list_text: string;
  facials_list_spoken_short: string;
  injectables_list_text: string;
  injectables_list_spoken_short: string;
  laser_list_text: string;
  laser_list_spoken_short: string;
  skin_list_text: string;
  skin_list_spoken_short: string;
  wellness_list_text: string;
  wellness_list_spoken_short: string;
  body_list_text: string;
  body_list_spoken_short: string;
  waxing_brows_list_text: string;
  lashes_list_text: string;
  pricing_lookup_text: string;
  services_with_pricing_and_deposits_text: string;
  bookable_services_with_deposits_text: string;
  exact_service_pricing_text: string;
  deposit_policy_text: string;
  voice_quality_score: number;
  voice_context_warnings: string;
  booking_cta: string;
  clinic_phone: string;
  location_short: string;
  hours_short: string;
  timezone?: string;
};

const MAX_SPOKEN_SERVICES = 8;
const bannedVoiceMenuPattern = /\b(get in touch|contact|book now|gift card|customize gift card|buy gift card|address|staff|team|prices|pricing|all services|menu of services|learn more|read more|home|about)\b/i;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function canonicalServiceName(name: string) {
  const normalized = cleanText(name).toLowerCase().replace(/&/g, "and");
  if (!normalized) return null;
  if (bannedVoiceMenuPattern.test(normalized)) return null;
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(cleanText(name)) && !/\b(facial|botox|filler|laser|peel|wax|lash|brow|dental|cleaning|hydra|micro|procell)\b/i.test(name)) return null;
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
  if (/wax|brow/.test(lower)) return "Waxing and brows";
  if (/lash/.test(lower)) return "Lashes";
  if (/microchannel|microneedl|peel|resurfac|plasma/.test(lower)) return "Skin resurfacing";
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
  if (/wax|brow/.test(lower)) return "waxing_brows";
  if (/lash/.test(lower)) return "lashes";
  return lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isVoiceApprovedService(service: ExtractedProfile["services"][number], childCategories: Set<string>) {
  const name = cleanText(service.voice_label || service.name);
  const kind = service.service_kind ?? "service";
  if (!name || service.rejected || bannedVoiceMenuPattern.test(name)) return false;
  if (kind === "staff" || kind === "navigation" || kind === "product" || kind === "unknown") return false;
  if (kind !== "service" && kind !== "consultation" && kind !== "package" && kind !== "membership") {
    return !childCategories.has(cleanText(service.voice_category ?? service.category));
  }
  if ((service.confidence ?? 0) < 0.75) return false;
  if (/^\d{1,2}\s*h|\$[0-9]|^\d{1,3}\s*min/i.test(name)) return false;
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(name) && !/\b(facial|botox|filler|laser|peel|wax|lash|brow|dental|cleaning|hydra|micro|procell)\b/i.test(name)) return false;
  return true;
}

function shortenServiceLabel(name: string) {
  const clean = cleanText(name)
    .replace(/^customized existing client facial$/i, "Customized Facial")
    .replace(/^clarifying acne facial$/i, "acne facial");
  return clean;
}

function stripServiceDetail(label: string) {
  return cleanText(label).replace(/\s*\([^)]*\)/g, "").replace(/,\s*(total price|[0-9]+ minutes).*$/i, "");
}

function spokenShortList(text: string) {
  const names = text
    .split(/;|,/)
    .map(stripServiceDetail)
    .filter(Boolean);

  return formatServiceList([...new Set(names)].slice(0, 5));
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
  const warnings: string[] = [];
  const childCategories = new Set(profile.services
    .filter((service) => (service.service_kind ?? "service") === "service")
    .map((service) => cleanText(service.voice_category ?? service.category))
    .filter(Boolean));

  const voiceServices = profile.services.filter((service) => isVoiceApprovedService(service, childCategories));

  for (const service of voiceServices) {
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
  let serviceMenuShort = serviceCategoriesShort
    ? `${serviceCategoriesShort}.`
    : formatServiceList(safeServiceNames.slice(0, MAX_SPOKEN_SERVICES).map(shortenServiceLabel));
  if (serviceMenuShort.length > 220) serviceMenuShort = serviceMenuShort.slice(0, 220).replace(/\s+\S*$/, "").replace(/[,.]$/, "");
  if (bannedVoiceMenuPattern.test(serviceMenuShort)) warnings.push("voice menu contained banned terms and was filtered");
  const voiceQualityScore = Math.max(0, Math.min(100, 100 - (warnings.length * 15) - (voiceServices.length < 3 ? 15 : 0) - (!serviceMenuShort ? 25 : 0)));

  return {
    clinic_name: clinicName,
    lead_id: input.leadId,
    binding_id: input.bindingId ?? null,
    phone_e164: input.phoneE164,
    service_categories_short: serviceCategoriesShort,
    service_menu_short: serviceMenuShort,
    service_menu_spoken_short: serviceMenuShort,
    services_by_category_text: "",
    safe_service_names: safeServiceNames,
    safe_service_names_text: safeServiceNames.join(", "),
    category_lists: {},
    facials_list_text: categoryLists.facials_list_text ?? "",
    facials_list_spoken_short: spokenShortList(categoryLists.facials_list_text ?? ""),
    injectables_list_text: categoryLists.injectables_list_text ?? "",
    injectables_list_spoken_short: spokenShortList(categoryLists.injectables_list_text ?? ""),
    laser_list_text: categoryLists.laser_list_text ?? "",
    laser_list_spoken_short: spokenShortList(categoryLists.laser_list_text ?? ""),
    skin_list_text: categoryLists.skin_list_text ?? "",
    skin_list_spoken_short: spokenShortList(categoryLists.skin_list_text ?? ""),
    wellness_list_text: categoryLists.wellness_list_text ?? "",
    wellness_list_spoken_short: spokenShortList(categoryLists.wellness_list_text ?? ""),
    body_list_text: categoryLists.body_list_text ?? "",
    body_list_spoken_short: spokenShortList(categoryLists.body_list_text ?? ""),
    waxing_brows_list_text: categoryLists.waxing_brows_list_text ?? "",
    lashes_list_text: categoryLists.lashes_list_text ?? "",
    pricing_lookup_text: pricing.join("; ").slice(0, 600),
    services_with_pricing_and_deposits_text: "",
    bookable_services_with_deposits_text: "",
    exact_service_pricing_text: "",
    deposit_policy_text: "",
    voice_quality_score: voiceQualityScore,
    voice_context_warnings: warnings.join("; "),
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
    `Broad services: ${context.service_menu_spoken_short || context.service_categories_short || context.service_menu_short || "Ask the clinic about available services."}`,
    context.facials_list_spoken_short ? `Facials: ${context.facials_list_spoken_short}` : "",
    context.injectables_list_spoken_short ? `Injectables: ${context.injectables_list_spoken_short}` : "",
    context.laser_list_spoken_short ? `Laser: ${context.laser_list_spoken_short}` : "",
    context.skin_list_spoken_short ? `Skin: ${context.skin_list_spoken_short}` : "",
    context.wellness_list_spoken_short ? `Wellness: ${context.wellness_list_spoken_short}` : "",
    context.body_list_spoken_short ? `Body: ${context.body_list_spoken_short}` : "",
    context.waxing_brows_list_text ? `Waxing and brows: ${context.waxing_brows_list_text}.` : "",
    context.lashes_list_text ? `Lashes: ${context.lashes_list_text}.` : "",
    context.exact_service_pricing_text || context.services_with_pricing_and_deposits_text
      ? `Specific pricing only: ${context.exact_service_pricing_text || context.services_with_pricing_and_deposits_text}.`
      : "",
    context.deposit_policy_text ? `Deposit policy: ${context.deposit_policy_text}` : "",
    "Safety: list services only; route clinical details to a licensed provider.",
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
    service_menu_spoken_short: cleanText(record.service_menu_spoken_short) || serviceMenuShort,
    services_by_category_text: cleanText(record.services_by_category_text),
    safe_service_names: safeServiceNames,
    safe_service_names_text: cleanText(record.safe_service_names_text) || safeServiceNames.join(", "),
    category_lists: categoryLists,
    facials_list_text: cleanText(record.facials_list_text) || categoryLists.facials_list_text || "",
    facials_list_spoken_short: cleanText(record.facials_list_spoken_short) || spokenShortList(cleanText(record.facials_list_text) || categoryLists.facials_list_text || ""),
    injectables_list_text: cleanText(record.injectables_list_text) || categoryLists.injectables_list_text || "",
    injectables_list_spoken_short: cleanText(record.injectables_list_spoken_short) || spokenShortList(cleanText(record.injectables_list_text) || categoryLists.injectables_list_text || ""),
    laser_list_text: cleanText(record.laser_list_text) || categoryLists.laser_list_text || "",
    laser_list_spoken_short: cleanText(record.laser_list_spoken_short) || spokenShortList(cleanText(record.laser_list_text) || categoryLists.laser_list_text || ""),
    skin_list_text: cleanText(record.skin_list_text) || categoryLists.skin_list_text || "",
    skin_list_spoken_short: cleanText(record.skin_list_spoken_short) || spokenShortList(cleanText(record.skin_list_text) || categoryLists.skin_list_text || ""),
    wellness_list_text: cleanText(record.wellness_list_text) || categoryLists.wellness_list_text || "",
    wellness_list_spoken_short: cleanText(record.wellness_list_spoken_short) || spokenShortList(cleanText(record.wellness_list_text) || categoryLists.wellness_list_text || ""),
    body_list_text: cleanText(record.body_list_text) || categoryLists.body_list_text || "",
    body_list_spoken_short: cleanText(record.body_list_spoken_short) || spokenShortList(cleanText(record.body_list_text) || categoryLists.body_list_text || ""),
    waxing_brows_list_text: cleanText(record.waxing_brows_list_text) || categoryLists.waxing_brows_list_text || "",
    lashes_list_text: cleanText(record.lashes_list_text) || categoryLists.lashes_list_text || "",
    pricing_lookup_text: cleanText(record.pricing_lookup_text),
    services_with_pricing_and_deposits_text: cleanText(record.services_with_pricing_and_deposits_text),
    bookable_services_with_deposits_text: cleanText(record.bookable_services_with_deposits_text) || cleanText(record.services_with_pricing_and_deposits_text),
    exact_service_pricing_text: cleanText(record.exact_service_pricing_text) || cleanText(record.services_with_pricing_and_deposits_text),
    deposit_policy_text: cleanText(record.deposit_policy_text),
    voice_quality_score: typeof record.voice_quality_score === "number" ? record.voice_quality_score : Number(record.voice_quality_score ?? 0) || 0,
    voice_context_warnings: cleanText(record.voice_context_warnings),
    booking_cta: cleanText(record.booking_cta) || "Would you like to book a consultation?",
    clinic_phone: cleanText(record.clinic_phone),
    location_short: cleanText(record.location_short),
    hours_short: cleanText(record.hours_short),
    timezone: cleanText(record.timezone) || undefined,
  };
}
