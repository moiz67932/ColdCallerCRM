import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_VOICE_ANSWER_TYPES,
  evaluateProfileQuality,
  extractNormalizedClinicProfile,
  isUuid,
  parseStructuredPrices,
  sanitizeVoiceAnswerRows,
  stableSyntheticKey,
  writeNormalizedExtraction,
  type PipelinePage,
} from "@/lib/demo-agent/profile-pipeline";

function page(input: Partial<PipelinePage> & { url: string; cleanedText: string }): PipelinePage {
  return {
    canonicalUrl: input.url,
    title: input.title ?? null,
    metaDescription: null,
    html: "",
    jsonLd: input.jsonLd ?? [],
    links: [],
    httpStatus: 200,
    pageType: input.pageType ?? "unknown",
    ...input,
  };
}

function fixturePages() {
  return [
    page({
      id: "11111111-1111-4111-8111-111111111111",
      url: "https://dang.example",
      title: "Dang Aesthetics | Med Spa",
      cleanedText:
        "Dang Aesthetics\nCall (714) 555-0101\nhello@dangaesthetics.com\n123 Beauty Ave, Irvine, CA 92618\nMonday 9:00 AM - 5:00 PM\nTuesday 9:00 AM - 5:00 PM\nWednesday 9:00 AM - 5:00 PM\nThursday 9:00 AM - 5:00 PM\nFriday 9:00 AM - 5:00 PM\nServices\nHydraFacial\nBotox\nDysport\nFillers\nSculptra\nKybella\nPDO Thread Lift\nMicroneedling\nPRP/PRF\nHair Restoration\nPlasma Pen",
    }),
    page({
      id: "22222222-2222-4222-8222-222222222222",
      url: "https://dang.example/facial-treatments/hydrafacial",
      title: "HydraFacial Treatments",
      cleanedText:
        "DA Essential HydraFacial\n60-75 minutes\n$185+ / Series of 3 $495\nDA Hydra You\n75-90 minutes\n$265 / Series $695\nDA Hydra Man\n60 minutes\n$195+\nDA Luxe HydraFacial\n90 minutes\n$345\nDA Hydra Prep\n30 minutes\n$135 / Series of 3 $345\nBook Now\nCall Now",
    }),
    page({
      id: "33333333-3333-4333-8333-333333333333",
      url: "https://dang.example/products",
      title: "Products",
      cleanedText: "ZO Skin Health Products\nDaily Power Defense $185\nRetinol Skin Brightener $120",
    }),
    page({
      id: "44444444-4444-4444-8444-444444444444",
      url: "https://dang.example/faq",
      title: "FAQ",
      cleanedText: "Do you offer consultations?\nBook Now\nDo you offer financing?\nWe can review payment options with you before treatment.",
    }),
    page({
      id: "55555555-5555-4555-8555-555555555555",
      url: "https://dang.example/specials",
      title: "Specials",
      cleanedText: "July Specials\nSave $50 on select facial treatments",
    }),
  ];
}

test("parseStructuredPrices supports starting, series, split fixed/series, and ranges", () => {
  assert.deepEqual(parseStructuredPrices("$185+")[0], {
    price_label: "Starting at",
    price_type: "starting_at",
    amount_min_cents: 18500,
    amount_max_cents: null,
    amount_cents: null,
    currency: "USD",
    unit: null,
    package_quantity: null,
    raw_price_text: "$185+",
    duration_min_minutes: null,
    duration_max_minutes: null,
    confidence: 0.9,
    source_quote: "$185+",
  });

  const series = parseStructuredPrices("Series of 3 $495");
  assert.equal(series[0].price_type, "series");
  assert.equal(series[0].package_quantity, 3);
  assert.equal(series[0].amount_cents, 49500);

  const split = parseStructuredPrices("$265 / Series $695");
  assert.equal(split.length, 2);
  assert.equal(split.find((row) => row.price_type === "fixed")?.amount_cents, 26500);
  assert.equal(split.find((row) => row.price_type === "series")?.amount_cents, 69500);

  const range = parseStructuredPrices("$200-$300");
  assert.equal(range[0].price_type, "range");
  assert.equal(range[0].amount_min_cents, 20000);
  assert.equal(range[0].amount_max_cents, 30000);

  assert.equal(parseStructuredPrices("starting at $120")[0].price_type, "starting_at");
  assert.equal(parseStructuredPrices("from $120")[0].amount_min_cents, 12000);
  assert.equal(parseStructuredPrices("$12 per unit")[0].price_type, "per_unit");
  assert.equal(parseStructuredPrices("package of 3 $600")[0].price_type, "package");
  assert.equal(parseStructuredPrices("consultation $50")[0].price_type, "consultation");
  assert.equal(parseStructuredPrices("add-on $30")[0].price_type, "add_on");
});

test("JSON-LD LocalBusiness, Service, and Offer data feed deterministic extraction", () => {
  const result = extractNormalizedClinicProfile([
    page({
      id: "66666666-6666-4666-8666-666666666666",
      url: "https://clinic.example",
      title: "Clinic",
      cleanedText: "Services",
      jsonLd: [{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "HealthAndBeautyBusiness",
            name: "Glow Clinic",
            telephone: "(949) 555-0101",
            email: "hello@glow.example",
            address: {
              "@type": "PostalAddress",
              streetAddress: "10 Glow Way",
              addressLocality: "Irvine",
              addressRegion: "CA",
              postalCode: "92618",
            },
            openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: "Monday", opens: "09:00", closes: "17:00" }],
          },
          { "@type": "Service", name: "Clarifying Acne Facial", category: "Facials", offers: { "@type": "Offer", price: "120", priceCurrency: "USD" } },
        ],
      }],
    }),
  ], { websiteUrl: "https://clinic.example" });

  assert.equal(result.snapshot.clinic.name, "Glow Clinic");
  assert.equal(result.locations[0].address_line1, "10 Glow Way");
  assert.equal(result.services.some((service) => service.display_name === "Clarifying Acne Facial" && service.price_available), true);
});

test("DOM service cards and pricing rows produce grouped medspa services", () => {
  const result = extractNormalizedClinicProfile([
    page({
      id: "77777777-7777-4777-8777-777777777777",
      url: "https://clinic.example/services",
      title: "Services",
      cleanedText: "Glow Clinic\nCall (949) 555-0101\n10 Glow Way, Irvine, CA 92618\nFacials\nInjectables",
      structuredBlocks: [
        { type: "service_card", heading: "Age Defying Facial", text: "Age Defying Facial restorative facial service" },
        { type: "service_card", heading: "New Client Facial", text: "New Client Facial first visit service" },
        { type: "pricing_row", heading: "Clarifying Acne Facial", text: "Clarifying Acne Facial | 60 minutes | starting at $120" },
        { type: "service_card", heading: "Botox", text: "Botox injectable service $12 per unit" },
        { type: "section", heading: "Facials", text: "Facials" },
      ],
    }),
  ], { websiteUrl: "https://clinic.example" });

  const names = result.services.map((service) => service.display_name);
  assert.equal(names.includes("Age Defying Facial"), true);
  assert.equal(names.includes("Clarifying Acne Facial"), true);
  assert.equal(names.includes("Facials"), false);
  assert.equal(result.services.find((service) => service.display_name === "Clarifying Acne Facial")?.category, "Facials");
  assert.equal(result.services.find((service) => service.display_name === "Botox")?.category, "Injectables");
});

test("raw med spa pages extract structured services, prices, aliases, hours, and contact facts", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), {
    websiteUrl: "https://dang.example",
    businessNameHint: null,
  });

  assert.equal(result.snapshot.clinic.name, "Dang Aesthetics");
  assert.equal(result.facts.some((fact) => fact.fact_type === "phone" && fact.normalized_value === "+17145550101"), true);
  assert.equal(result.facts.some((fact) => fact.fact_type === "email" && fact.fact_value === "hello@dangaesthetics.com"), true);
  assert.equal(result.locations[0].address_line1, "123 Beauty Ave");
  assert.equal(result.hours.filter((hour) => !hour.is_closed).length >= 5, true);
  assert.equal(result.services.length >= 10, true);

  const essential = result.services.find((service) => service.display_name === "DA Essential HydraFacial");
  assert.ok(essential);
  assert.equal(essential.duration_min_minutes, 60);
  assert.equal(essential.duration_max_minutes, 75);
  assert.equal(essential.prices.some((price) => price.price_type === "starting_at" && price.amount_min_cents === 18500), true);
  assert.equal(essential.prices.some((price) => price.price_type === "series" && price.package_quantity === 3 && price.amount_cents === 49500), true);
  assert.equal(essential.aliases.some((alias) => alias.alias === "Hydra Facial"), true);

  const hydraYou = result.services.find((service) => service.display_name === "DA Hydra You");
  assert.ok(hydraYou);
  assert.equal(hydraYou.prices.some((price) => price.price_type === "fixed" && price.amount_cents === 26500), true);
  assert.equal(hydraYou.prices.some((price) => price.price_type === "series" && price.amount_cents === 69500), true);
});

test("products, CTAs, generic labels, and broken FAQs are rejected from core services", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });
  const serviceNames = result.services.map((service) => service.display_name.toLowerCase());

  assert.equal(serviceNames.includes("book now"), false);
  assert.equal(serviceNames.includes("call now"), false);
  assert.equal(serviceNames.includes("cosmetic"), false);
  assert.equal(serviceNames.includes("implant"), false);
  assert.equal(result.products.some((product) => /zo skin/i.test(product.product_name)), true);
  assert.equal(result.faqs.some((faq) => faq.answer === "Book Now"), false);
  assert.equal(result.faqs.some((faq) => /financing/i.test(faq.question)), true);
});

test("homepage and detail page services merge instead of duplicating", () => {
  const result = extractNormalizedClinicProfile([
    page({ url: "https://clinic.example", title: "Clinic", cleanedText: "HydraFacial\nBotox\n(714) 555-0101\n123 Beauty Ave, Irvine, CA 92618" }),
    page({ url: "https://clinic.example/services/hydrafacial", title: "HydraFacial", cleanedText: "HydraFacial\n60 minutes\n$199+" }),
  ], { websiteUrl: "https://clinic.example", businessNameHint: "Clinic" });

  assert.equal(result.services.filter((service) => /hydrafacial/i.test(service.display_name)).length, 1);
  assert.equal(result.services.find((service) => /hydrafacial/i.test(service.display_name))?.prices[0].amount_min_cents, 19900);
});

test("voice answers are short, source-free, and use structured prices", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });
  const servicesList = result.voiceAnswers.find((answer) => answer.answer_type === "services_list");
  const priceAnswer = result.voiceAnswers.find((answer) => answer.answer_type === "service_price" && /HydraFacial/.test(answer.answer_text));

  assert.ok(servicesList);
  assert.equal(/Source:/i.test(servicesList.answer_text), false);
  assert.ok(priceAnswer);
  assert.match(priceAnswer.answer_text, /\$185/);
  assert.equal(/Source:/i.test(priceAnswer.answer_text), false);
});

test("generated voice answer types stay aligned with the database allow-list", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });
  const allowed = new Set(ALLOWED_VOICE_ANSWER_TYPES);

  assert.equal(result.voiceAnswers.every((answer) => allowed.has(answer.answer_type)), true);
});

test("voice answer sanitizer maps known legacy or category-specific answer types", () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const result = sanitizeVoiceAnswerRows({
      leadDemoProfileId: "profile-1",
      extractionRunId: "run-1",
      rows: [
        { id: "1", answer_type: "service_categories", service_id: null, answer_text: "Categories" },
        { id: "2", answer_type: "location", service_id: null, answer_text: "Address" },
        { id: "3", answer_type: "pricing", service_id: null, answer_text: "Pricing" },
      ],
    });

    assert.deepEqual(result.rows.map((row) => row.answer_type), ["services_list", "address", "pricing_summary"]);
    assert.deepEqual(result.mappedAnswerTypes, ["location->address", "pricing->pricing_summary", "service_categories->services_list"]);
    assert.deepEqual(result.skippedAnswerTypes, []);
    assert.equal(errors[0][0], "demo_agent.invalid_voice_answer_types");
    assert.equal(warnings.length, 1);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("voice answer sanitizer skips unmapped invalid answer types and logs safely", () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const result = sanitizeVoiceAnswerRows({
      leadDemoProfileId: "profile-1",
      extractionRunId: "run-1",
      rows: [
        { id: "1", answer_type: "unknown_context_bucket", service_id: null, answer_text: "Do not log this full optional answer." },
        { id: "2", answer_type: "fallback", service_id: null, answer_text: "Fallback" },
      ],
    });

    assert.deepEqual(result.rows.map((row) => row.answer_type), ["fallback"]);
    assert.deepEqual(result.skippedAnswerTypes, ["unknown_context_bucket"]);
    assert.equal(errors[0][0], "demo_agent.invalid_voice_answer_types");
    assert.deepEqual((errors[0][1] as Record<string, unknown>).invalidAnswerTypes, ["unknown_context_bucket"]);
    assert.equal(JSON.stringify(errors).includes("Do not log this full optional answer"), false);
    assert.equal(warnings.length, 1);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("writeNormalizedExtraction does not fail the whole job when optional voice answer insert fails", async () => {
  const result = extractNormalizedClinicProfile(fixturePages(), {
    websiteUrl: "https://dang.example",
    businessNameHint: null,
  });
  const inserted: Record<string, unknown[]> = {};
  const client = {
    from(table: string) {
      return {
        update() {
          return { eq: async () => ({ error: null }) };
        },
        insert: async (rows: Record<string, unknown>[]) => {
          if (table === "lead_clinic_voice_answers") {
            return { error: { message: "violates check constraint lead_clinic_voice_answers_answer_type_check" } };
          }
          inserted[table] = rows;
          return { error: null };
        },
      };
    },
  };

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    const counts = await writeNormalizedExtraction({
      result,
      organizationId: "org-1",
      leadId: "lead-1",
      leadDemoProfileId: "profile-1",
      supabaseClient: client,
    });

    assert.equal(counts.voiceAnswers, 0);
    assert.equal(counts.voiceAnswerWarnings, 1);
    assert.equal(typeof inserted.lead_clinic_services?.length, "number");
    assert.equal(typeof inserted.lead_clinic_knowledge_chunks?.length, "number");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("Refine-like categories, facials, injectables, and pricing produce valid voice answer types", () => {
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://refine.example",
      title: "Refine Aesthetics",
      cleanedText:
        "Refine Aesthetics\nCall (949) 555-2222\n12 Beauty Lane, Newport Beach, CA 92660\nMonday 9:00 AM - 5:00 PM\nFacials\nSignature Facial $150\nHydraFacial $225\nInjectables\nBotox $14 per unit\nDermal Filler starting at $650\nPricing\nBook Online",
    }),
    page({
      url: "https://refine.example/services/facials",
      title: "Facials",
      cleanedText: "Facials\nSignature Facial is a customized facial treatment.\nHydraFacial deeply cleanses and hydrates skin.",
    }),
    page({
      url: "https://refine.example/services/injectables",
      title: "Injectables",
      cleanedText: "Injectables\nBotox softens dynamic lines.\nDermal Filler restores facial volume.",
    }),
  ], { websiteUrl: "https://refine.example", businessNameHint: "Refine Aesthetics" });
  const allowed = new Set(ALLOWED_VOICE_ANSWER_TYPES);

  assert.equal(result.voiceAnswers.every((answer) => allowed.has(answer.answer_type)), true);
  assert.equal(result.voiceAnswers.some((answer) => answer.answer_type === "services_list" && /facials|injectables/i.test(answer.answer_text)), true);
  assert.equal(result.voiceAnswers.some((answer) => answer.answer_type === "pricing_summary"), true);
});

test("specials with unclear month date create maybe_stale warning", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });
  assert.equal(result.offers.some((offer) => offer.metadata.maybe_stale), true);
  assert.equal(result.quality.warnings.some((warning) => /specials may be stale/i.test(warning)), true);
});

test("quality gate fails rich clinic pages with too few services or no facts", () => {
  const poor = evaluateProfileQuality({
    businessName: "Thin Med Spa",
    facts: [],
    locations: [],
    hours: [],
    services: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        canonical_name: "Botox",
        display_name: "Botox",
        service_slug: "botox",
        category: "Injectables",
        subcategory: null,
        description_short: null,
        description_long: null,
        is_bookable: true,
        is_product: false,
        is_membership: false,
        is_consultation: false,
        duration_min_minutes: null,
        duration_max_minutes: null,
        starting_price_cents: null,
        price_summary: null,
        price_available: false,
        currency: "USD",
        source_url: "https://clinic.example/services",
        source_page_id: null,
        source_quote: "Botox",
        extraction_method: "deterministic",
        confidence: 0.8,
        sort_order: 0,
        synthetic_key: null,
        aliases: [],
        prices: [],
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        canonical_name: "Fillers",
        display_name: "Fillers",
        service_slug: "fillers",
        category: "Injectables",
        subcategory: null,
        description_short: null,
        description_long: null,
        is_bookable: true,
        is_product: false,
        is_membership: false,
        is_consultation: false,
        duration_min_minutes: null,
        duration_max_minutes: null,
        starting_price_cents: null,
        price_summary: null,
        price_available: false,
        currency: "USD",
        source_url: "https://clinic.example/services",
        source_page_id: null,
        source_quote: "Fillers",
        extraction_method: "deterministic",
        confidence: 0.8,
        sort_order: 1,
        synthetic_key: null,
        aliases: [],
        prices: [],
      },
    ],
    faqs: [],
    offers: [],
    voiceAnswers: [],
    pages: [page({ url: "https://clinic.example/services", title: "Services", cleanedText: "Botox\nFillers\nHydraFacial\nMicroneedling\nLaser\n$185" })],
  });

  assert.equal(poor.isDemoReady, false);
  assert.equal(poor.blockers.some((blocker) => /No clinic facts/i.test(blocker)), true);
  assert.equal(poor.warnings.some((warning) => /fewer than 5/i.test(warning)), true);
});

test("warning quality above 50 is accepted as demo ready", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });

  assert.equal(result.quality.score >= 50, true);
  assert.equal(result.quality.isDemoReady, true);
  assert.notEqual(result.quality.status, "not_demo_ready");
});

test("privacy, review, cart, and broken-page text do not become services or staff", () => {
  const result = extractNormalizedClinicProfile([
    page({ url: "https://clinic.example", title: "Clinic", cleanedText: "Clinic Med Spa\nCall (714) 555-0101\n123 Beauty Ave, Irvine, CA 92618\nBotox\nHydraFacial\nMicroneedling\nLaser Hair Removal\nChemical Peel" }),
    page({ url: "https://clinic.example/privacy", title: "Privacy Policy", cleanedText: "Privacy Policy\nPersonal Data Request\nCalifornia Colorado Connecticut Delaware\nDo Not Sell My Data" }),
    page({ url: "https://clinic.example/cart", title: "Cart", cleanedText: "Shopping Cart\nYour cart is empty\nContinue Shopping\nAdd to Cart" }),
    page({ url: "https://clinic.example/services", title: "Services", cleanedText: "This Page Does Not Exist\nSorry, the page you are looking for could not be found." }),
    page({ url: "https://clinic.example/products/lip-filler", title: "Lip Filler", cleanedText: "Customer Reviews\nAnonymous Verified\n04/07/2026\nAmazing Changed my life\nLip Filler\n$249" }),
  ], { websiteUrl: "https://clinic.example", businessNameHint: "Clinic Med Spa" });

  const searchable = [...result.services.map((service) => service.display_name), ...result.staff.map((person) => person.full_name)].join(" ");
  assert.doesNotMatch(searchable, /Privacy Policy|Shopping Cart|This Page Does Not Exist|Anonymous|Changed My Life/i);
});

test("service ids are real UUIDs and synthetic keys are never UUID-compatible", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });

  assert.equal(result.services.every((service) => isUuid(service.id)), true);
  assert.equal(isUuid(stableSyntheticKey("hydrafacial")), false);
});

test("deterministic extraction is stable enough for idempotent counts", () => {
  const first = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });
  const second = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });

  assert.equal(first.services.length, second.services.length);
  assert.equal(first.services.reduce((sum, service) => sum + service.prices.length, 0), second.services.reduce((sum, service) => sum + service.prices.length, 0));
  assert.deepEqual(first.services.map((service) => service.service_slug), second.services.map((service) => service.service_slug));
});
