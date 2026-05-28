import { env } from "@/lib/env";
import type { VoiceContextCompact } from "@/lib/elevenlabs/voice-context";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  DEFAULT_DEPOSIT_PERCENT_BPS,
  buildDepositPolicyText,
  buildDepositPricingDetails,
  calculateDepositAmountCents,
} from "@/lib/payments/deposit-pricing";

export type PortiveService = {
  name: string;
  category: string;
  duration: string;
  price: string;
  summary: string;
  aliases: string[];
};

export type PortiveFaq = {
  question: string;
  answer: string;
  category: string;
};

type DemoServicePricing = {
  name: string;
  category?: string;
  durationMinutes: number | null;
  servicePriceCents: number | null;
  depositPercentBps: number;
  depositAmountCents: number | null;
  currency: string;
};

type ClinicServicesSquareMapPricingRow = {
  internal_service_name?: string | null;
  display_service_name?: string | null;
  square_location_id?: string | null;
  square_team_member_id?: string | null;
  square_service_variation_id?: string | null;
  duration_minutes?: number | string | null;
  service_price_cents?: number | string | null;
  deposit_percent_bps?: number | string | null;
  deposit_amount_cents?: number | string | null;
  currency?: string | null;
};

export const PORTIVE_CLINIC_NAME = "Portive Clinic";
export const PORTIVE_LOCATION = "Newport Beach, CA";
export const PORTIVE_HOURS = "Mon-Fri 9:00 AM-6:00 PM, Sat 10:00 AM-3:00 PM, Sun closed";
export const PORTIVE_BOOKING_CTA = "Would you like to book a consultation at Portive Clinic?";
export const PORTIVE_DEMO_PAID_SERVICES: DemoServicePricing[] = [
  {
    name: "Botox Consultation",
    category: "Injectables",
    durationMinutes: 30,
    servicePriceCents: 25000,
    depositPercentBps: DEFAULT_DEPOSIT_PERCENT_BPS,
    depositAmountCents: 5000,
    currency: "USD",
  },
];

const BOOKABLE_CATEGORY_ORDER = ["Injectables", "Facials", "Laser", "Skin Treatments", "Wellness", "Body Treatments"];
const BOOKABLE_SERVICE_ORDER = [
  "Botox Consultation",
  "Hydrafacial",
  "Custom Medical Facial",
  "Laser Hair Removal Consultation",
  "Chemical Peel Consultation",
  "Microneedling Consultation",
  "PRP Consultation",
  "IV Therapy Consultation",
];

export const PORTIVE_SERVICES: PortiveService[] = [
  {
    name: "Botox and Dysport",
    category: "Injectables",
    duration: "30 minutes",
    price: "$13-$15 per unit",
    summary: "Wrinkle relaxer appointments for forehead lines, frown lines, and crow's feet.",
    aliases: ["Botox", "Dysport", "wrinkle relaxer", "tox"],
  },
  {
    name: "Dermal Fillers",
    category: "Injectables",
    duration: "45-60 minutes",
    price: "$650-$850 per syringe",
    summary: "Hyaluronic acid filler appointments for lips, cheeks, chin, jawline, and smile lines.",
    aliases: ["filler", "cheek filler", "jawline filler", "chin filler"],
  },
  {
    name: "Lip Filler",
    category: "Injectables",
    duration: "45 minutes",
    price: "from $650",
    summary: "Lip enhancement appointments focused on shape, balance, and volume.",
    aliases: ["lip enhancement", "lip injections", "lip augmentation"],
  },
  {
    name: "Kybella",
    category: "Injectables",
    duration: "30 minutes",
    price: "from $600 per vial",
    summary: "Consultation-based injectable appointments for submental fullness under the chin.",
    aliases: ["double chin treatment", "submental fullness"],
  },
  {
    name: "Hydrafacial",
    category: "Facials",
    duration: "45 minutes",
    price: "$199-$275",
    summary: "A cleansing, exfoliating, extraction, and hydration facial.",
    aliases: ["hydra facial", "hydrating facial"],
  },
  {
    name: "Custom Medical Facial",
    category: "Facials",
    duration: "60 minutes",
    price: "$165-$225",
    summary: "A customized facial selected around skin goals and provider assessment.",
    aliases: ["custom facial", "medical facial", "signature facial"],
  },
  {
    name: "Chemical Peel",
    category: "Skin Treatments",
    duration: "30-45 minutes",
    price: "$175-$350",
    summary: "Provider-selected peel appointments for tone, texture, and congestion concerns.",
    aliases: ["peel", "skin peel"],
  },
  {
    name: "Microneedling",
    category: "Skin Treatments",
    duration: "60 minutes",
    price: "$399-$499",
    summary: "Collagen induction treatment appointments for texture and overall skin quality.",
    aliases: ["collagen induction", "micro needling"],
  },
  {
    name: "PRP Microneedling",
    category: "Skin Treatments",
    duration: "75 minutes",
    price: "$650-$800",
    summary: "Microneedling appointments paired with platelet-rich plasma.",
    aliases: ["PRP facial", "vampire facial"],
  },
  {
    name: "Laser Hair Removal",
    category: "Laser Services",
    duration: "15-60 minutes",
    price: "$95-$450 by area",
    summary: "Laser hair reduction appointments priced by treatment area.",
    aliases: ["hair removal laser", "laser hair"],
  },
  {
    name: "IPL Photofacial",
    category: "Laser Services",
    duration: "45 minutes",
    price: "$350-$500",
    summary: "Light-based appointments for visible redness, pigment, and sun damage concerns.",
    aliases: ["IPL", "photo facial", "photofacial"],
  },
  {
    name: "RF Skin Tightening",
    category: "Laser Services",
    duration: "45-60 minutes",
    price: "$450-$650",
    summary: "Radiofrequency skin tightening appointments for face, neck, or body areas.",
    aliases: ["radiofrequency tightening", "skin tightening"],
  },
  {
    name: "Body Contouring",
    category: "Body Treatments",
    duration: "45 minutes",
    price: "$250-$400 per area",
    summary: "Non-surgical body contouring appointments priced by treatment area.",
    aliases: ["body sculpting", "contouring"],
  },
  {
    name: "Wellness Shot",
    category: "Wellness",
    duration: "15 minutes",
    price: "$35-$60",
    summary: "Quick wellness injection appointments such as B12 or vitamin blends.",
    aliases: ["B12 shot", "vitamin shot", "wellness injection"],
  },
  {
    name: "GLP-1 Weight Wellness Consultation",
    category: "Wellness",
    duration: "30 minutes",
    price: "$99 consultation",
    summary: "Consultation appointment for weight wellness options and eligibility discussion.",
    aliases: ["weight loss consultation", "semaglutide consult", "tirzepatide consult"],
  },
];

export const PORTIVE_FAQS: PortiveFaq[] = [
  {
    question: "Do I need a consultation before treatment?",
    answer: "For injectables, lasers, body treatments, and weight wellness, Portive Clinic starts with a consultation or provider assessment to confirm the right plan.",
    category: "Booking",
  },
  {
    question: "Can prices change after the consultation?",
    answer: "Yes. Published pricing is a starting estimate. Final pricing depends on the treatment plan, area, product amount, and provider assessment.",
    category: "Pricing",
  },
  {
    question: "Do you take deposits?",
    answer: "Appointments use a 20% deposit. The appointment is confirmed after the deposit is paid and the booking is created.",
    category: "Booking",
  },
  {
    question: "What is the cancellation policy?",
    answer: "Please give at least 24 hours notice to reschedule or cancel. Late cancellations or no-shows may be subject to a fee.",
    category: "Policy",
  },
  {
    question: "Can I book if I am pregnant or nursing?",
    answer: "Some treatments may not be appropriate during pregnancy or nursing. A licensed provider can review options during consultation.",
    category: "Safety",
  },
  {
    question: "Do you provide medical advice over the phone?",
    answer: "The phone agent can share general service and booking information only. Clinical questions are handled by a licensed provider during consultation.",
    category: "Safety",
  },
];

function listForSpeech(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function servicesByCategory(category: string) {
  return PORTIVE_SERVICES.filter((service) => service.category === category);
}

function categoryForPricedService(serviceName: string) {
  const normalizedName = serviceName.toLowerCase();
  const exactStaticService = PORTIVE_SERVICES.find((service) => service.name.toLowerCase() === normalizedName);

  if (/laser/i.test(exactStaticService?.category ?? "")) return "Laser";
  if (exactStaticService) return exactStaticService.category;
  if (/\b(botox|dysport|filler|kybella|inject)\b/i.test(serviceName)) return "Injectables";
  if (/\b(hydra\s*facial|facial)\b/i.test(serviceName)) return "Facials";
  if (/\b(laser|ipl|rf|radiofrequency)\b/i.test(serviceName)) return "Laser";
  if (/\b(peel|microneedl|skin)\b/i.test(serviceName)) return "Skin Treatments";
  if (/\b(iv|glp|weight|wellness|b12|vitamin)\b/i.test(serviceName)) return "Wellness";
  if (/\b(body|contour)\b/i.test(serviceName)) return "Body Treatments";
  return "Consultations";
}

function serviceDetail(service: PortiveService) {
  return `${service.name} (${service.duration})`;
}

function categoryDetail(category: string) {
  const services = servicesByCategory(category).map(serviceDetail);
  return services.length ? `${category}: ${services.join("; ")}` : "";
}

export function portiveCategoryDetailsText() {
  return [...new Set(PORTIVE_SERVICES.map((service) => service.category))]
    .map(categoryDetail)
    .filter(Boolean)
    .join(". ");
}

export function portiveFaqText() {
  return PORTIVE_FAQS.map((faq) => `${faq.question} ${faq.answer}`).join(" ");
}

export function portivePolicyText() {
  return `${buildDepositPolicyText()} Please give at least 24 hours notice to reschedule or cancel. The phone agent must not provide medical advice and should route clinical questions to a licensed provider.`;
}

export function servicesWithPricingAndDepositsText(services: DemoServicePricing[]) {
  return services.filter(isCanonicalBookablePricedService).map((service) => {
    const pricing = buildDepositPricingDetails({
      serviceName: service.name,
      servicePriceCents: service.servicePriceCents,
      depositPercentBps: service.depositPercentBps,
      depositAmountCents: service.depositAmountCents,
      currency: service.currency,
    });
    const durationText = service.durationMinutes ? `${service.durationMinutes} minutes` : "duration not configured";

    if (pricing.service_price_text && pricing.deposit_amount_text) {
      return `${service.name}: ${durationText}, total price ${pricing.service_price_text}, ${pricing.deposit_percent_text} deposit ${pricing.deposit_amount_text}`;
    }

    if (pricing.deposit_amount_text) {
      return `${service.name}: ${durationText}, total price not configured, ${pricing.deposit_percent_text} deposit ${pricing.deposit_amount_text}; pricing incomplete`;
    }

    return `${service.name}: ${durationText}, pricing incomplete`;
  }).join(". ");
}

function isCanonicalBookablePricedService(service: DemoServicePricing) {
  return service.servicePriceCents !== null && service.depositAmountCents !== null;
}

function pricedServiceDetail(service: DemoServicePricing) {
  return service.name;
}

function pricedServicesByCategoryMap(services: DemoServicePricing[]) {
  const grouped = new Map<string, string[]>();

  for (const service of services) {
    const category = service.category || categoryForPricedService(service.name);
    const existing = grouped.get(category) ?? [];
    existing.push(pricedServiceDetail(service));
    grouped.set(category, existing);
  }

  return grouped;
}

function mergedServicesByCategoryText(services: DemoServicePricing[]) {
  const pricedByCategory = pricedServicesByCategoryMap(services);

  return BOOKABLE_CATEGORY_ORDER
    .map((category) => [category, pricedByCategory.get(category) ?? []] as const)
    .filter(([, details]) => details.length > 0)
    .map(([category, details]) => `${category}: ${details.join(", ")}`)
    .join(". ");
}

function listTextForPricedCategory(services: DemoServicePricing[], category: string) {
  return sortBookableServices(services)
    .filter((service) => (service.category || categoryForPricedService(service.name)) === category)
    .map((service) => service.name)
    .join(", ");
}

function spokenListForPricedCategory(services: DemoServicePricing[], category: string) {
  const names = sortBookableServices(services).filter((service) => (service.category || categoryForPricedService(service.name)) === category).map((service) => service.name);
  return names.length ? `${listForSpeech(names)}.` : "";
}

function categoriesForBookableServices(services: DemoServicePricing[]) {
  const categories = new Set(services.map((service) => service.category || categoryForPricedService(service.name)).filter(Boolean));
  return BOOKABLE_CATEGORY_ORDER.filter((category) => categories.has(category));
}

function removedUnbookableServices(services: DemoServicePricing[]) {
  const names = new Set(services.map((service) => service.name.toLowerCase()));
  return PORTIVE_SERVICES.map((service) => service.name).filter((name) => !names.has(name.toLowerCase()));
}

function sortBookableServices(services: DemoServicePricing[]) {
  return [...services].sort((left, right) => {
    const leftCategory = BOOKABLE_CATEGORY_ORDER.indexOf(left.category || categoryForPricedService(left.name));
    const rightCategory = BOOKABLE_CATEGORY_ORDER.indexOf(right.category || categoryForPricedService(right.name));
    const categoryCompare = normalizeSortIndex(leftCategory) - normalizeSortIndex(rightCategory);
    if (categoryCompare !== 0) return categoryCompare;

    const leftService = BOOKABLE_SERVICE_ORDER.indexOf(left.name);
    const rightService = BOOKABLE_SERVICE_ORDER.indexOf(right.name);
    const serviceCompare = normalizeSortIndex(leftService) - normalizeSortIndex(rightService);
    if (serviceCompare !== 0) return serviceCompare;

    return left.name.localeCompare(right.name);
  });
}

function normalizeSortIndex(index: number) {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export async function getSharedDemoVoiceContextWithBackendPricing(): Promise<VoiceContextCompact> {
  const backendPricing = await loadDemoServicePricingFromBackend();
  const services = backendPricing.length ? backendPricing : PORTIVE_DEMO_PAID_SERVICES;
  console.info("ElevenLabs bookable service context built.", {
    bookable_service_count: services.length,
    bookable_service_names: services.map((service) => service.name),
    source_used: backendPricing.length ? "clinic_services_square_map" : "clinic_services_square_map_fallback",
    removed_unbookable_services: removedUnbookableServices(services),
  });

  return getSharedDemoVoiceContext(services);
}

export function getSharedDemoVoiceContext(servicePricing: DemoServicePricing[] = PORTIVE_DEMO_PAID_SERVICES): VoiceContextCompact {
  const phone = env.ELEVENLABS_PHONE_E164 ?? env.DEMO_TELNYX_PHONE_E164 ?? "";
  const sortedServicePricing = sortBookableServices(servicePricing);
  const categories = categoriesForBookableServices(sortedServicePricing);
  const servicesWithPricingText = servicesWithPricingAndDepositsText(sortedServicePricing);
  const servicesByCategoryText = mergedServicesByCategoryText(sortedServicePricing);
  const depositPolicyText = buildDepositPolicyText();
  const safeServiceNames = [...new Set(sortedServicePricing.map((service) => service.name))];
  const facialsListText = listTextForPricedCategory(sortedServicePricing, "Facials");
  const injectablesListText = listTextForPricedCategory(sortedServicePricing, "Injectables");
  const laserListText = listTextForPricedCategory(sortedServicePricing, "Laser");
  const skinListText = listTextForPricedCategory(sortedServicePricing, "Skin Treatments");
  const wellnessListText = listTextForPricedCategory(sortedServicePricing, "Wellness");
  const bodyListText = listTextForPricedCategory(sortedServicePricing, "Body Treatments");
  const serviceMenuShort = categories.length ? `${listForSpeech(categories.map((category) => category.toLowerCase()))}.` : "";

  return {
    clinic_name: PORTIVE_CLINIC_NAME,
    lead_id: "",
    binding_id: null,
    phone_e164: phone,
    service_categories_short: listForSpeech(categories),
    service_menu_short: serviceMenuShort,
    service_menu_spoken_short: serviceMenuShort,
    services_by_category_text: servicesByCategoryText,
    safe_service_names: safeServiceNames,
    safe_service_names_text: safeServiceNames.join(", "),
    bookable_service_names_text: safeServiceNames.join(", "),
    category_lists: {
      facials_list_text: facialsListText,
      injectables_list_text: injectablesListText,
      laser_list_text: laserListText,
      skin_list_text: skinListText,
      wellness_list_text: wellnessListText,
      body_list_text: bodyListText,
    },
    facials_list_text: facialsListText,
    facials_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Facials"),
    injectables_list_text: injectablesListText,
    injectables_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Injectables"),
    laser_list_text: laserListText,
    laser_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Laser"),
    skin_list_text: skinListText,
    skin_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Skin Treatments"),
    wellness_list_text: wellnessListText,
    wellness_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Wellness"),
    body_list_text: bodyListText,
    body_list_spoken_short: spokenListForPricedCategory(sortedServicePricing, "Body Treatments"),
    waxing_brows_list_text: "",
    lashes_list_text: "",
    pricing_lookup_text: servicesWithPricingText,
    services_with_pricing_and_deposits_text: servicesWithPricingText,
    bookable_services_with_deposits_text: servicesWithPricingText,
    exact_service_pricing_text: servicesWithPricingText,
    deposit_policy_text: depositPolicyText,
    voice_quality_score: 100,
    voice_context_warnings: "",
    booking_cta: PORTIVE_BOOKING_CTA,
    clinic_phone: phone,
    location_short: PORTIVE_LOCATION,
    hours_short: PORTIVE_HOURS,
    timezone: "America/Los_Angeles",
  };
}

async function loadDemoServicePricingFromBackend(): Promise<DemoServicePricing[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return [];
  }

  try {
    let query = getSupabaseAdmin()
      .from("clinic_services_square_map")
      .select(
        [
          "internal_service_name",
          "display_service_name",
          "square_location_id",
          "square_team_member_id",
          "square_service_variation_id",
          "duration_minutes",
          "service_price_cents",
          "deposit_percent_bps",
          "deposit_amount_cents",
          "currency",
        ].join(","),
      )
      .eq("is_active", true)
      .eq("square_environment", env.SQUARE_ENV)
      .not("square_location_id", "is", null)
      .not("square_team_member_id", "is", null)
      .not("square_service_variation_id", "is", null)
      .order("internal_service_name", { ascending: true })
      .limit(20);

    if (env.DEMO_RUNTIME_ORGANIZATION_ID?.trim()) {
      query = query.eq("organization_id", env.DEMO_RUNTIME_ORGANIZATION_ID.trim());
    }

    const { data, error } = await query;

    if (error) {
      console.warn("Shared demo pricing context lookup failed.", { message: error.message });
      return [];
    }

    return ((data ?? []) as ClinicServicesSquareMapPricingRow[]).map(normalizeDemoServicePricingRow).filter((row): row is DemoServicePricing => Boolean(row));
  } catch (error) {
    console.warn("Shared demo pricing context lookup failed.", {
      message: error instanceof Error ? error.message : "Unknown pricing lookup error.",
    });
    return [];
  }
}

function normalizeDemoServicePricingRow(row: ClinicServicesSquareMapPricingRow): DemoServicePricing | null {
  const name = cleanString(row.internal_service_name);

  if (!name || !cleanString(row.square_location_id) || !cleanString(row.square_team_member_id) || !cleanString(row.square_service_variation_id)) {
    return null;
  }

  const servicePriceCents = numberOrNull(row.service_price_cents);
  const depositPercentBps = positiveNumberOrDefault(row.deposit_percent_bps, DEFAULT_DEPOSIT_PERCENT_BPS);
  const storedDepositAmountCents = numberOrNull(row.deposit_amount_cents);
  const calculatedDepositAmountCents = calculateDepositAmountCents(servicePriceCents, depositPercentBps);

  return {
    name,
    category: categoryForPricedService(name),
    durationMinutes: numberOrNull(row.duration_minutes),
    servicePriceCents,
    depositPercentBps,
    depositAmountCents: calculatedDepositAmountCents ?? storedDepositAmountCents,
    currency: cleanString(row.currency) ?? "USD",
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function positiveNumberOrDefault(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}
