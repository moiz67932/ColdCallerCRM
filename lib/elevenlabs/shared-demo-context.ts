import { env } from "@/lib/env";
import type { VoiceContextCompact } from "@/lib/elevenlabs/voice-context";

const SHARED_DEMO_CLINIC_NAME = "Demo Clinic";

export function getSharedDemoVoiceContext(): VoiceContextCompact {
  const phone = env.ELEVENLABS_PHONE_E164 ?? env.DEMO_TELNYX_PHONE_E164 ?? "";

  return {
    clinic_name: SHARED_DEMO_CLINIC_NAME,
    lead_id: "",
    binding_id: null,
    phone_e164: phone,
    service_categories_short: "consultations, facials, injectables, laser services, and skin treatments",
    service_menu_short: "The menu includes consultations, facials, injectables, laser services, and skin treatments.",
    safe_service_names: [
      "consultations",
      "custom facials",
      "Botox and Dysport",
      "dermal fillers",
      "laser hair removal",
      "chemical peels",
      "microneedling",
    ],
    safe_service_names_text: "consultations, custom facials, Botox and Dysport, dermal fillers, laser hair removal, chemical peels, microneedling",
    category_lists: {
      facials_list_text: "custom facials, acne facials, and hydrating facials",
      injectables_list_text: "Botox and Dysport, dermal fillers, and lip filler services",
      laser_list_text: "laser hair removal and IPL treatments",
      skin_list_text: "chemical peels and microneedling",
    },
    facials_list_text: "custom facials, acne facials, and hydrating facials",
    injectables_list_text: "Botox and Dysport, dermal fillers, and lip filler services",
    laser_list_text: "laser hair removal and IPL treatments",
    skin_list_text: "chemical peels and microneedling",
    waxing_brows_list_text: "",
    lashes_list_text: "",
    pricing_lookup_text: "Consultation pricing and treatment pricing can be confirmed with the clinic team.",
    voice_quality_score: 100,
    voice_context_warnings: "",
    booking_cta: "Would you like to book a consultation?",
    clinic_phone: phone,
    location_short: "Local demo clinic",
    hours_short: "Ask the clinic for current hours.",
  };
}
