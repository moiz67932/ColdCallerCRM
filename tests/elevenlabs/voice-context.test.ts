import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile, createExtractedService } from "@/lib/demo-agent/contracts";
import { buildVoiceContextCompact, voiceContextText } from "@/lib/elevenlabs/voice-context";

function service(name: string, description: string, category?: string | null, price?: string | null) {
  return createExtractedService({
    name,
    category: category ?? null,
    subcategory: null,
    voice_label: name,
    voice_category: category ?? null,
    description,
    duration_minutes: 30,
    price_text: price ?? null,
    price_min_cents: null,
    price_summary: price ?? null,
    price_available: Boolean(price),
    bookable: true,
    source_url: "https://clinic.example/services",
    source_quote: name,
    extraction_method: "test",
    service_kind: "service" as const,
    confidence: 0.9,
  });
}

test("buildVoiceContextCompact deduplicates service names and excludes medical claims", () => {
  const profile = createEmptyExtractedProfile("https://sg.example");
  profile.clinic.name = "SG Essentials Med Spa";
  profile.clinic.phone = "+13103318914";
  profile.clinic.address.city = "Los Angeles";
  profile.clinic.address.state = "CA";
  profile.hours.monday = { open: true, start: "09:00", end: "17:00" };
  profile.services = [
    service("Botox", "Can last 3 to 4 months."),
    service("Dysport", "Can reduce wrinkles."),
    service("Botox/dysport", "Treatment outcome details."),
    service("Basic Lip Fillers", "Can enhance shape."),
    service("Basic Lip Filler", "Can improve appearance."),
    service("Russian Lip Technique", "Can enhance shape."),
    service("Fillers", "Dermal filler details."),
    service("Filler chin jawline cheek", "Can improve body contour."),
    service("Dermal Fillers", "Can restore volume."),
    service("Kybella", "Can reduce fat."),
  ];
  profile.faqs = [
    {
      question: "What does Kybella do?",
      answer: "It can reduce fat and improve body contour.",
      category: "FAQ",
      source_url: "https://sg.example/faq",
      confidence: 0.9,
    },
  ];

  const compact = buildVoiceContextCompact({
    extractedProfileJson: profile,
    leadId: "lead-1",
    bindingId: "binding-1",
    phoneE164: "+13103318914",
  });
  const serialized = JSON.stringify({ context_text: voiceContextText(compact), context: compact });

  assert.deepEqual(compact.safe_service_names, ["Botox and Dysport", "lip filler services", "fillers", "Kybella"]);
  assert.ok(serialized.length < 1800);
  assert.doesNotMatch(serialized, /reduce fat|lasts? 3 to 4 months|enhance shape|improve body contour|treatment outcome|restore volume/i);
});

test("buildVoiceContextCompact groups services by category and keeps full safe names", () => {
  const profile = createEmptyExtractedProfile("https://clinic.example");
  profile.clinic.name = "Clinic Med Spa";
  profile.services = [
    service("Procell Microchanneling", "", "Skin resurfacing"),
    service("Age Defying Facial", "", "Facials"),
    service("New Client Facial", "", "Facials"),
    service("Customized Existing Client Facial", "", "Facials"),
    service("Clarifying Acne Facial", "", "Facials", "Pricing starts at $120."),
    service("Hydradermabrasion", "", "Facials"),
    service("Radiofrequency Facial", "", "Facials"),
    service("Swich Facial", "", "Facials"),
    service("Teen Facial", "", "Facials"),
  ];

  const compact = buildVoiceContextCompact({
    extractedProfileJson: profile,
    leadId: "lead-1",
    bindingId: "binding-1",
    phoneE164: "+13103318914",
  });

  assert.match(compact.service_categories_short, /facials/);
  assert.ok(compact.service_menu_short.length <= 220);
  assert.equal(compact.safe_service_names.length, 9);
  assert.match(compact.facials_list_text, /Age Defying Facial/);
  assert.match(compact.pricing_lookup_text, /Clarifying Acne Facial/);
});

test("Live Lovely-style polluted services are filtered into voice-safe categories", () => {
  const profile = createEmptyExtractedProfile("https://livelovely.example");
  profile.clinic.name = "Live Lovely";
  profile.services = [
    { ...service("Jenny Patton", "", null), service_kind: "staff", confidence: 0.95 },
    { ...service("Get In Touch", "", null), service_kind: "navigation", confidence: 0.95 },
    { ...service("Add-ons", "", "Add-ons"), service_kind: "add_on", confidence: 0.9 },
    { ...service("Peels", "", "Skin resurfacing"), service_kind: "category", confidence: 0.9 },
    { ...service("Waxing & Brows", "", "Waxing and brows"), service_kind: "category", confidence: 0.9 },
    service("Age Defying Facial", "", "Facials"),
    service("Lash Lift", "", "Lashes"),
    service("Procell Microchanneling", "", "Skin resurfacing", "$350"),
  ];

  const compact = buildVoiceContextCompact({
    extractedProfileJson: profile,
    leadId: "lead-1",
    phoneE164: "+13103318914",
  });

  assert.doesNotMatch(compact.service_menu_short, /Jenny Patton|Get In Touch|Book Now|Gift Card/i);
  assert.match(compact.service_menu_short, /facials|skin resurfacing|waxing and brows|lashes/i);
  assert.match(compact.safe_service_names_text, /Procell Microchanneling/);
  assert.match(compact.pricing_lookup_text, /Procell Microchanneling: \$350/);
  assert.ok(compact.service_menu_short.length <= 220);
});
