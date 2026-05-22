import { env } from "@/lib/env";
import type { VoiceContextCompact } from "@/lib/elevenlabs/voice-context";

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

export const PORTIVE_CLINIC_NAME = "Portive Clinic";
export const PORTIVE_LOCATION = "Newport Beach, CA";
export const PORTIVE_HOURS = "Mon-Fri 9:00 AM-6:00 PM, Sat 10:00 AM-3:00 PM, Sun closed";
export const PORTIVE_BOOKING_CTA = "Would you like to book a consultation at Portive Clinic?";

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
    answer: "Portive Clinic may request a booking deposit for longer appointments. The team can confirm the deposit amount when scheduling.",
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

function serviceDetail(service: PortiveService) {
  return `${service.name} (${service.duration}, ${service.price})`;
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
  return "Booking deposits may be requested for longer appointments. Please give at least 24 hours notice to reschedule or cancel. The phone agent must not provide medical advice and should route clinical questions to a licensed provider.";
}

export function getSharedDemoVoiceContext(): VoiceContextCompact {
  const phone = env.ELEVENLABS_PHONE_E164 ?? env.DEMO_TELNYX_PHONE_E164 ?? "";
  const categories = [...new Set(PORTIVE_SERVICES.map((service) => service.category))];
  const pricing = PORTIVE_SERVICES.map((service) => `${service.name}: ${service.price}`).join("; ");
  const detailsByCategory = Object.fromEntries(categories.map((category) => [category, servicesByCategory(category).map(serviceDetail)]));

  return {
    clinic_name: PORTIVE_CLINIC_NAME,
    lead_id: "",
    binding_id: null,
    phone_e164: phone,
    service_categories_short: listForSpeech(categories),
    service_menu_short: `The menu includes ${portiveCategoryDetailsText()}.`,
    safe_service_names: PORTIVE_SERVICES.map((service) => service.name),
    safe_service_names_text: PORTIVE_SERVICES.map((service) => service.name).join(", "),
    category_lists: {
      facials_list_text: (detailsByCategory.Facials ?? []).join("; "),
      injectables_list_text: (detailsByCategory.Injectables ?? []).join("; "),
      laser_list_text: (detailsByCategory["Laser Services"] ?? []).join("; "),
      skin_list_text: (detailsByCategory["Skin Treatments"] ?? []).join("; "),
      wellness_list_text: (detailsByCategory.Wellness ?? []).join("; "),
      body_list_text: (detailsByCategory["Body Treatments"] ?? []).join("; "),
    },
    facials_list_text: (detailsByCategory.Facials ?? []).join("; "),
    injectables_list_text: (detailsByCategory.Injectables ?? []).join("; "),
    laser_list_text: (detailsByCategory["Laser Services"] ?? []).join("; "),
    skin_list_text: (detailsByCategory["Skin Treatments"] ?? []).join("; "),
    waxing_brows_list_text: "",
    lashes_list_text: "",
    pricing_lookup_text: pricing,
    voice_quality_score: 100,
    voice_context_warnings: "",
    booking_cta: PORTIVE_BOOKING_CTA,
    clinic_phone: phone,
    location_short: PORTIVE_LOCATION,
    hours_short: PORTIVE_HOURS,
    timezone: "America/Los_Angeles",
  };
}
