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
  toLeadClinicServiceRow,
  toRejectedCandidateRow,
  writeNormalizedExtraction,
  type NormalizedService,
  type PipelinePage,
  type RejectedServiceCandidate,
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
  assert.equal(parseStructuredPrices("$60 deposit required $125").find((price) => price.price_type === "deposit")?.amount_cents, 6000);
});

test("GlossGenius deposit and full price stay separated", () => {
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://gloss.example/book",
      title: "Booking",
      pageType: "booking",
      cleanedText: "Dermaplane Facial\n$60 deposit required\n$125\nBook now",
      structuredBlocks: [{
        kind: "booking_service_card",
        heading: "Dermaplane Facial",
        text: "Dermaplane Facial $60 deposit required $125",
        price_text: "$60 $125",
        source_url: "https://gloss.example/book",
        dom_hint: "booking_card",
        confidence: 0.92,
      }],
    }),
  ], { websiteUrl: "https://gloss.example", businessNameHint: "Gloss Spa" });

  const service = result.services.find((entry) => entry.display_name === "Dermaplane Facial");
  assert.ok(service);
  assert.equal(service.price_summary, "$125");
  assert.equal(service.starting_price_cents, 12500);
  assert.equal(service.prices.some((price) => price.price_type === "deposit" && price.amount_cents === 6000), true);
});

test("lead_clinic_services mapper includes voice-safe columns and excludes internal fields", () => {
  const service: NormalizedService & Record<string, unknown> = {
    id: "11111111-1111-4111-8111-111111111111",
    canonical_name: "Dermaplane Facial",
    display_name: "Dermaplane Facial",
    service_slug: "dermaplane-facial",
    category: "Facials",
    subcategory: null,
    description_short: "Dermaplane facial",
    description_long: null,
    is_bookable: true,
    is_product: false,
    is_membership: false,
    is_consultation: false,
    duration_min_minutes: 45,
    duration_max_minutes: null,
    starting_price_cents: 12500,
    price_summary: "$125",
    price_available: true,
    currency: "USD",
    source_url: "https://clinic.example/book",
    source_page_id: null,
    source_quote: "Dermaplane Facial $125",
    extraction_method: "dom_service_card",
    confidence: 0.92,
    sort_order: 1,
    synthetic_key: null,
    service_kind: "service",
    rejected: false,
    rejection_reason: null,
    aliases: [{ alias: "Dermaplane", alias_type: "test", confidence: 0.8 }],
    prices: [{
      price_label: "Standard",
      price_type: "fixed",
      amount_min_cents: null,
      amount_max_cents: null,
      amount_cents: 12500,
      currency: "USD",
      unit: null,
      package_quantity: null,
      raw_price_text: "$125",
      duration_min_minutes: null,
      duration_max_minutes: null,
      confidence: 0.9,
      source_quote: "Dermaplane Facial $125",
    }],
    candidate_scores: { bad: true },
    raw_html: "<div>bad</div>",
    internal_debug: true,
  };
  const row = toLeadClinicServiceRow(service, {
    organization_id: "org-1",
    lead_id: "lead-1",
    lead_demo_profile_id: "profile-1",
    extraction_run_id: "run-1",
    clinic_id: null,
  });

  assert.equal(row.service_kind, "service");
  assert.equal(row.rejected, false);
  assert.equal(row.rejection_reason, null);
  assert.deepEqual(row.price_details, [{
    price_label: "Standard",
    price_type: "fixed",
    amount_min_cents: null,
    amount_max_cents: null,
    amount_cents: 12500,
    currency: "USD",
    unit: null,
    package_quantity: null,
    raw_price_text: "$125",
    confidence: 0.9,
  }]);
  assert.equal(row.voice_label, "Dermaplane Facial");
  assert.equal(row.voice_category, "Facials");
  assert.equal("aliases" in row, false);
  assert.equal("candidate_scores" in row, false);
  assert.equal("raw_html" in row, false);
  assert.equal("internal_debug" in row, false);
});

test("rejected candidate mapper writes debug rows separately", () => {
  const candidate: RejectedServiceCandidate = {
    raw_name: "Get In Touch",
    normalized_name: "Get In Touch",
    candidate_kind: "navigation",
    rejection_reason: "navigation_or_contact_label",
    source_url: "https://clinic.example/contact",
    source_page_id: null,
    source_quote: "Get In Touch",
    extraction_method: "legacy_line_candidate",
    confidence: 0.52,
    metadata: { source: "test" },
  };

  const row = toRejectedCandidateRow(candidate, {
    organization_id: "org-1",
    lead_id: "lead-1",
    lead_demo_profile_id: "profile-1",
    extraction_run_id: "run-1",
    clinic_id: null,
  });

  assert.equal(row.raw_name, "Get In Touch");
  assert.equal(row.rejection_reason, "navigation_or_contact_label");
  assert.equal(row.candidate_kind, "navigation");
  assert.deepEqual(row.metadata, { source: "test" });
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
        { kind: "service_card", type: "service_card", heading: "Age Defying Facial", text: "Age Defying Facial restorative facial service" },
        { kind: "service_card", type: "service_card", heading: "New Client Facial", text: "New Client Facial first visit service" },
        { kind: "pricing_table_row", type: "pricing_row", heading: "Clarifying Acne Facial", text: "Clarifying Acne Facial | 60 minutes | starting at $120" },
        { kind: "service_card", type: "service_card", heading: "Botox", text: "Botox injectable service $12 per unit" },
        { kind: "heading_section", type: "section", heading: "Facials", text: "Facials" },
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
        service_kind: "service",
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
        service_kind: "service",
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

test("warning quality above 50 requires review instead of demo-ready auto activation", () => {
  const result = extractNormalizedClinicProfile(fixturePages(), { websiteUrl: "https://dang.example" });

  assert.equal(result.quality.score >= 50, true);
  if (result.quality.status !== "demo_ready") assert.equal(result.quality.isDemoReady, false);
  assert.notEqual(result.quality.status, "not_demo_ready");
});

test("polluted voice menu is not demo ready", () => {
  const quality = evaluateProfileQuality({
    businessName: "Live Lovely",
    facts: [{ id: "fact", fact_type: "phone", fact_key: "primary", fact_value: "(555) 123-1212", normalized_value: null, confidence: 0.9, source_url: "https://live.example", source_page_id: null, source_quote: null, extraction_method: "deterministic" }],
    locations: [],
    hours: [],
    services: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        canonical_name: "Get In Touch",
        display_name: "Get In Touch",
        service_slug: "get-in-touch",
        category: null,
        subcategory: null,
        description_short: null,
        description_long: null,
        is_bookable: false,
        is_product: false,
        is_membership: false,
        is_consultation: false,
        duration_min_minutes: null,
        duration_max_minutes: null,
        starting_price_cents: null,
        price_summary: null,
        price_available: false,
        currency: "USD",
        source_url: "https://live.example",
        source_page_id: null,
        source_quote: "Get In Touch",
        extraction_method: "deterministic",
        confidence: 0.9,
        sort_order: 0,
        synthetic_key: null,
        service_kind: "navigation",
        aliases: [],
        prices: [],
      },
    ],
    faqs: [],
    offers: [],
    voiceAnswers: [],
    pages: [page({ url: "https://live.example/services", title: "Services", cleanedText: "Get In Touch\nJenny Patton\nFacials\nBotox" })],
  });

  assert.equal(quality.isDemoReady, false);
});

test("polluted extraction candidates populate rejection stats", () => {
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://live.example/services",
      title: "Services",
      cleanedText: "Live Lovely\nJenny Patton\nGet In Touch\nBook Now\nCustomize Gift Card\n1 H 15 Min\nAll Services\nAge Defying Facial\nProcell Microchanneling",
    }),
  ], { websiteUrl: "https://live.example", businessNameHint: "Live Lovely" });

  assert.equal(result.rejectedCandidates.length > 0, true);
  assert.equal(result.rejectedCandidates.some((candidate) => candidate.rejection_reason === "person_name"), true);
  assert.equal(result.rejectedCandidates.some((candidate) => candidate.rejection_reason === "navigation_or_contact_label" || candidate.rejection_reason === "banned_label"), true);
});

test("over-extracted small local profiles are blocked", () => {
  const services: NormalizedService[] = Array.from({ length: 36 }, (_, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    canonical_name: `Service ${index}`,
    display_name: `Service ${index}`,
    service_slug: `service-${index}`,
    category: "Facials",
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
    source_quote: `Service ${index}`,
    extraction_method: "deterministic",
    confidence: 0.9,
    sort_order: index,
    synthetic_key: null,
    service_kind: "service",
    aliases: [],
    prices: [],
  }));
  const quality = evaluateProfileQuality({
    businessName: "Glowing Skin Med Spa",
    facts: [{ id: "fact", fact_type: "phone", fact_key: "primary", fact_value: "(555) 123-1212", normalized_value: null, confidence: 0.9, source_url: "https://clinic.example", source_page_id: null, source_quote: null, extraction_method: "deterministic" }],
    locations: [],
    hours: [],
    services,
    faqs: [],
    offers: [],
    voiceAnswers: [{ id: "answer", answer_type: "services_list", service_id: null, question_pattern: null, answer_text: "Services.", source_urls: null, confidence: 0.9, max_age_days: null }],
    pages: [page({ url: "https://clinic.example/services", title: "Services", cleanedText: "Services" })],
  });

  assert.equal(quality.isDemoReady, false);
  assert.equal(quality.blockers.some((blocker) => /More than 35 services/i.test(blocker)), true);
});

test("Glowing Skin-style noisy extraction compresses to a compact demo profile", () => {
  const noisyBlogQuestions = Array.from({ length: 90 }, (_, index) => `What is noisy article heading ${index}?`).join("\nHelpful education article.");
  const noisyServiceHeadings = [
    "What is HydraFacial?",
    "How does IV Therapy work?",
    "Benefits of Testosterone Therapy",
    "Cost of GLP-1 Weight Loss",
    "Who can benefit from Body Contouring",
    "Aftercare",
    "Side Effects",
    "Ingredients",
    "Symptoms",
    "Conditions",
    "MOTS-c",
    "GHK-Cu",
    "BPC-157",
    "Epithalon",
  ].join("\nInformational section.\n");
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://glowingskin.example",
      title: "Glowing Skin Med Spa",
      cleanedText:
        "Glowing Skin Med Spa\nCall (555) 123-1212\n101 Glow Ave, Austin, TX 78701\nServices\nHydraFacial\nIV Therapy\nTestosterone Therapy\nGLP-1 Weight Loss\nBody Contouring\nPeptide Therapy\nMicroneedling\nChemical Peel\nFree Consultation\nBook Online",
    }),
    page({
      url: "https://glowingskin.example/services",
      title: "Services",
      cleanedText:
        "HydraFacial\nBook this facial treatment\nIV Therapy\nBook IV wellness therapy\nTestosterone Therapy\nOffered by the clinic\nGLP-1 Weight Loss\nBook a consultation\nBody Contouring\nOffered body service\nPeptide Therapy\nPeptide therapy options\nMicroneedling\nBook microneedling treatment\nChemical Peel\nBook chemical peel treatment\nFree Consultation\nFree consultation available\n" +
        noisyServiceHeadings,
    }),
    page({
      url: "https://glowingskin.example/blog/hydrafacial-faq",
      title: "HydraFacial FAQ",
      cleanedText: "Is HydraFacial right for me?\nThe office can discuss HydraFacial options during a consultation.",
    }),
    page({
      url: "https://glowingskin.example/blog/noisy-encyclopedia",
      title: "Noisy Blog",
      cleanedText: `${noisyBlogQuestions}\nWhat is a random skincare trend?\nThis blog-only FAQ should not drive services.`,
    }),
  ], { websiteUrl: "https://glowingskin.example", businessNameHint: "Glowing Skin Med Spa" });

  const serviceNames = result.services.map((service) => service.display_name);
  assert.equal(result.services.length >= 8 && result.services.length <= 20, true);
  assert.equal(serviceNames.some((name) => /What is|How does|Benefits of|Cost of|Aftercare|Side Effects/i.test(name)), false);
  assert.equal(serviceNames.includes("MOTS-c"), false);
  assert.equal(serviceNames.includes("GHK-Cu"), false);
  assert.equal(serviceNames.includes("BPC-157"), false);
  assert.equal(serviceNames.includes("Epithalon"), false);
  assert.equal(serviceNames.includes("Peptide Therapy"), true);
  assert.equal(result.faqs.every((faq) => !/random skincare trend/i.test(`${faq.question} ${faq.answer}`)), true);
  assert.equal(result.faqs.length <= 20, true);
  assert.equal(result.quality.blockers.some((blocker) => /More than 80/i.test(blocker)), false);
});

test("missing hours do not fail strict demo readiness", () => {
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://hours-missing.example",
      title: "Hours Missing Med Spa",
      cleanedText:
        "Hours Missing Med Spa\nCall (555) 123-1212\n101 Glow Ave, Austin, TX 78701\nServices\nHydraFacial\nBook HydraFacial\nBotox\nBook Botox\nIV Therapy\nBook IV Therapy\nMicroneedling\nBook Microneedling\nChemical Peel\nBook Chemical Peel",
    }),
  ], { websiteUrl: "https://hours-missing.example", businessNameHint: "Hours Missing Med Spa" });

  assert.equal(result.hours.length, 0);
  assert.equal(result.snapshot.hours_status, "not_listed");
  assert.equal(result.quality.blockers.some((blocker) => /hours/i.test(blocker)), false);
  assert.equal(result.quality.isDemoReady, true);
});

test("strict demo pricing accepts exact free consultation and marks partial pricing", () => {
  const result = extractNormalizedClinicProfile([
    page({
      url: "https://pricing.example/services",
      title: "Services",
      cleanedText:
        "Pricing Med Spa\nCall (555) 123-1212\n101 Glow Ave, Austin, TX 78701\nServices\nFree Consultation\nFree consultation available. Book this consultation.\nHydraFacial\nBook HydraFacial\nBotox\nBook Botox",
    }),
  ], { websiteUrl: "https://pricing.example", businessNameHint: "Pricing Med Spa" });
  const consultation = result.services.find((service) => service.display_name === "Free Consultation");

  assert.ok(consultation);
  assert.equal(consultation.price_available, true);
  assert.equal(consultation.price_summary, "$0");
  assert.equal(result.snapshot.pricing_status, "partial");
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
