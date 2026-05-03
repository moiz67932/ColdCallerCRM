import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile } from "@/lib/demo-agent/contracts";
import {
  classifyPage,
  dedupeServices,
  extractProfileFromPages,
  normalizeWebsiteUrl,
  parseHours,
  parsePriceText,
  summarizeExtractedProfile,
} from "@/lib/demo-agent/extraction";

test("normalizeWebsiteUrl adds https and trims trailing slash", () => {
  assert.equal(normalizeWebsiteUrl("example.com/"), "https://example.com");
});

test("classifyPage prioritizes pricing and service paths", () => {
  assert.equal(classifyPage("https://clinic.com/pricing", "Pricing"), "pricing");
  assert.equal(classifyPage("https://clinic.com/services/whitening", "Whitening"), "services");
});

test("parsePriceText captures min cents and leaves missing pricing null", () => {
  assert.deepEqual(parsePriceText("Teeth whitening starts at $299"), {
    priceText: "Teeth whitening starts at $299",
    priceMinCents: 29900,
  });
  assert.deepEqual(parsePriceText("Call for pricing"), {
    priceText: null,
    priceMinCents: null,
  });
});

test("parseHours normalizes office hours into 24-hour time", () => {
  const hours = parseHours("Monday 9:00 AM - 5:00 PM Tuesday 10:00 AM - 6:00 PM Saturday Closed");

  assert.deepEqual(hours.monday, { open: true, start: "09:00", end: "17:00" });
  assert.deepEqual(hours.tuesday, { open: true, start: "10:00", end: "18:00" });
  assert.deepEqual(hours.saturday, { open: false, start: null, end: null });
});

test("dedupeServices keeps the highest-confidence service and merges sparse facts", () => {
  const services = dedupeServices([
    {
      name: "teeth whitening",
      aliases: ["Whitening"],
      description: "Basic description",
      duration_minutes: null,
      price_text: null,
      price_min_cents: null,
      bookable: true,
      source_url: "https://clinic.com/services",
      confidence: 0.6,
    },
    {
      name: "Teeth Whitening",
      aliases: [],
      description: "Professional whitening treatment",
      duration_minutes: 60,
      price_text: "Starts at $299",
      price_min_cents: 29900,
      bookable: true,
      source_url: "https://clinic.com/pricing",
      confidence: 0.9,
    },
  ]);

  assert.equal(services.length, 1);
  assert.equal(services[0].name, "Teeth Whitening");
  assert.equal(services[0].duration_minutes, 60);
  assert.equal(services[0].price_min_cents, 29900);
});

test("extractProfileFromPages normalizes mocked page output into the clinic profile contract", () => {
  const pages = [
    {
      url: "https://clinic.com",
      canonicalUrl: "https://clinic.com",
      title: "Bright Smile Dental | Austin Dentist",
      metaDescription: "Family dental care in Austin",
      cleanedText:
        "Bright Smile Dental\nCall us at (310) 555-0123\n123 Main St, Austin, TX 78701\nMonday 9:00 AM - 5:00 PM\nTuesday 9:00 AM - 5:00 PM\nWe offer dental cleaning and teeth whitening.",
      html: "<h1>Bright Smile Dental</h1>",
      jsonLd: [{ "@type": "Dentist", name: "Bright Smile Dental", telephone: "+13105550123" }],
      links: ["https://clinic.com/services", "https://clinic.com/faq"],
      httpStatus: 200,
      pageType: "general",
    },
    {
      url: "https://clinic.com/services",
      canonicalUrl: "https://clinic.com/services",
      title: "Services",
      metaDescription: null,
      cleanedText:
        "Teeth whitening starts at $299 and takes 60 minutes.\nDental cleaning keeps your smile healthy.\nInvisalign consultations available.",
      html: "<h1>Services</h1>",
      jsonLd: [],
      links: [],
      httpStatus: 200,
      pageType: "services",
    },
    {
      url: "https://clinic.com/faq",
      canonicalUrl: "https://clinic.com/faq",
      title: "FAQ",
      metaDescription: null,
      cleanedText: "Do you accept insurance?\nWe accept most PPO plans.",
      html: "<h1>FAQ</h1>",
      jsonLd: [],
      links: [],
      httpStatus: 200,
      pageType: "faq",
    },
  ];

  const profile = extractProfileFromPages(pages, "https://clinic.com");
  const summary = summarizeExtractedProfile(profile);

  assert.equal(profile.clinic.name, "Bright Smile Dental");
  assert.equal(profile.clinic.phone, "+13105550123");
  assert.equal(profile.services.length >= 2, true);
  assert.equal(profile.faqs[0].question, "Do you accept insurance?");
  assert.equal(summary.hasHours, true);
  assert.equal(summary.hasPricing, true);
});

test("missing pricing never invents a price", () => {
  const emptyProfile = createEmptyExtractedProfile("https://clinic.com");
  emptyProfile.clinic.name = "Plain Dental";
  emptyProfile.services = [
    {
      name: "Dental Cleaning",
      aliases: [],
      description: "Routine preventive cleaning",
      duration_minutes: 60,
      price_text: null,
      price_min_cents: null,
      bookable: true,
      source_url: "https://clinic.com/services",
      confidence: 0.8,
    },
  ];

  assert.equal(emptyProfile.services[0].price_text, null);
  assert.equal(emptyProfile.services[0].price_min_cents, null);
});
