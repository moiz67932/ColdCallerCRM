import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile } from "@/lib/demo-agent/contracts";
import { buildVoiceContextCompact, voiceContextText } from "@/lib/elevenlabs/voice-context";

function service(name: string, description: string) {
  return {
    name,
    aliases: [],
    description,
    duration_minutes: 30,
    price_text: null,
    price_min_cents: null,
    bookable: true,
    source_url: "https://clinic.example/services",
    confidence: 0.9,
  };
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
  assert.ok(serialized.length < 1500);
  assert.doesNotMatch(serialized, /reduce fat|lasts? 3 to 4 months|enhance shape|improve body contour|treatment outcome|restore volume/i);
});
