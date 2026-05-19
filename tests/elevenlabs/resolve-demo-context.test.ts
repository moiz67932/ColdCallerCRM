import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile } from "@/lib/demo-agent/contracts";
import { resolveElevenLabsDemoContext } from "@/lib/elevenlabs/resolve-demo-context";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "in" in value) {
      return Array.isArray(value.in) && value.in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function sortRows(rows: Row[], orderBy?: Row) {
  if (!orderBy) return rows;
  const [[key, direction]] = Object.entries(orderBy);
  return [...rows].sort((left, right) => {
    const leftValue = left[key];
    const rightValue = right[key];

    if (leftValue instanceof Date && rightValue instanceof Date) {
      const leftTime = leftValue.getTime();
      const rightTime = rightValue.getTime();
      return direction === "desc" ? rightTime - leftTime : leftTime - rightTime;
    }

    const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
    return direction === "desc" ? -comparison : comparison;
  });
}

function makeDb() {
  const profile = createEmptyExtractedProfile("https://clinic.example");
  profile.clinic.name = "Bright Smile Dental";
  profile.services = [
    {
      name: "Teeth Whitening",
      aliases: ["Whitening"],
      description: "Professional whitening.",
      duration_minutes: 60,
      price_text: "Starts at $299",
      price_min_cents: 29900,
      bookable: true,
      source_url: "https://clinic.example/services",
      confidence: 0.9,
    },
  ];
  profile.hours.monday = { open: true, start: "09:00", end: "17:00" };
  profile.faqs = [
    {
      question: "Do you accept insurance?",
      answer: "Yes, most PPO plans.",
      category: "Insurance",
      source_url: "https://clinic.example/faq",
      confidence: 0.8,
    },
  ];

  const state = {
    bindings: [
      {
        id: "binding-1",
        leadId: "lead-1",
        leadDemoProfileId: "profile-1",
        callerE164: "+923351897839",
        phoneE164: "+13103318914",
        status: "active",
        createdAt: new Date("2026-05-10T00:00:00Z"),
        voiceContextCompactJson: {
          clinic_name: "SG Essentials Med Spa",
          lead_id: "lead-1",
          binding_id: "binding-1",
          phone_e164: "+13103318914",
          service_menu_short: "Botox and Dysport, fillers, Kybella, microblading, facials, QWO, IV infusion, and lip filler services",
          safe_service_names: ["Botox and Dysport", "fillers", "Kybella", "microblading", "facials", "QWO", "IV infusion", "lip filler services"],
          booking_cta: "Would you like to book a consultation?",
          clinic_phone: "+13103318914",
          location_short: "Los Angeles, CA",
          hours_short: "Mon 09:00-17:00",
        },
      },
    ] as Row[],
    profiles: [
      {
        id: "profile-1",
        extractedProfileJson: profile,
      },
    ] as Row[],
  };

  const db = {
    elevenlabsDemoBinding: {
      findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => sortRows(state.bindings.filter((row) => matchesWhere(row, where)), orderBy)[0] ?? null,
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
        const rows = where ? state.bindings.filter((row) => matchesWhere(row, where)) : state.bindings;
        return sortRows(rows, orderBy);
      },
    },
    leadDemoProfile: {
      findUnique: async ({ where }: { where: Row }) => state.profiles.find((row) => matchesWhere(row, where)) ?? null,
    },
  };

  return { db, state };
}

test("resolveElevenLabsDemoContext returns clinic services hours and FAQs for active caller/called binding", async () => {
  const { db } = makeDb();

  const result = await resolveElevenLabsDemoContext(
    {
      conversation_id: "conversation-1",
      caller_number: "+923351897839",
      called_number: "+13103318914",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolved, true);
  assert.equal(result.caller_e164, "+923351897839");
  assert.equal(result.phone_e164, "+13103318914");
  assert.equal(result.lead_id, "lead-1");
  assert.match(result.context_text, /SG Essentials Med Spa/);
  assert.match(result.context_text, /Botox and Dysport/);
  assert.equal(result.context.clinic_name, "SG Essentials Med Spa");
  assert.deepEqual(result.context.safe_service_names.slice(0, 3), ["Botox and Dysport", "fillers", "Kybella"]);
  assert.equal(result.context.binding_id, "binding-1");
});

test("resolveElevenLabsDemoContext compact response is short and contains no medical claims", async () => {
  const { db } = makeDb();

  const result = await resolveElevenLabsDemoContext(
    {
      conversation_id: "conversation-1",
      caller_number: "923351897839",
      called_number: "13103318914",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, true);
  if (result.status !== "resolved") assert.fail("Expected resolve_demo_context to resolve.");
  assert.ok(JSON.stringify({ context_text: result.context_text, context: result.context }).length < 1500);
  assert.doesNotMatch(JSON.stringify(result), /reduce fat|lasts? 3 to 4 months|enhance shape|improve body contour|treatment outcome|benefits include/i);
  assert.equal("description" in result.context, false);
  assert.equal("faqs" in result.context, false);
});

test("resolveElevenLabsDemoContext resolves the same binding with plus and digit-only phone inputs", async () => {
  const { db } = makeDb();
  const cases = [
    { caller_number: "+923351897839", called_number: "+13103318914" },
    { caller_number: "+923351897839", called_number: "13103318914" },
    { caller_number: "923351897839", called_number: "13103318914" },
  ];

  for (const phoneInput of cases) {
    const result = await resolveElevenLabsDemoContext(
      {
        conversation_id: "conversation-1",
        agent_id: "elevenlabs-agent-1",
        ...phoneInput,
      },
      { db: db as never },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "resolved");
    assert.equal(result.resolved, true);
    assert.equal(result.binding_id, "binding-1");
    assert.equal(result.lead_id, "lead-1");
    assert.equal(result.lead_demo_profile_id, "profile-1");
  }
});

test("resolveElevenLabsDemoContext falls back to active called-number binding when caller does not match", async () => {
  const { db } = makeDb();

  const result = await resolveElevenLabsDemoContext(
    {
      conversation_id: "conversation-1",
      caller_number: "(949) 555-0101",
      called_number: "+1 (310) 331-8914",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.binding_id, "binding-1");
  assert.equal(result.match_type, "called_number_fallback");
  assert.equal(result.caller_matched, false);
});

test("resolveElevenLabsDemoContext returns not_found when no active called binding matches", async () => {
  const { db } = makeDb();

  const result = await resolveElevenLabsDemoContext(
    {
      conversation_id: "conversation-1",
      caller_number: "923351897839",
      called_number: "15555550123",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_active_demo_binding_found");
  assert.equal(result.normalized_caller_digits, "923351897839");
  assert.equal(result.normalized_called_digits, "15555550123");
  assert.equal(result.caller_matched, false);
  assert.equal(result.called_number_matched, false);
});

test("resolveElevenLabsDemoContext rejects invalid phone input", async () => {
  const { db } = makeDb();

  await assert.rejects(
    resolveElevenLabsDemoContext(
      {
        conversation_id: "conversation-1",
        caller_number: "not-a-phone",
        called_number: "+1 (310) 331-8914",
        agent_id: "elevenlabs-agent-1",
      },
      { db: db as never },
    ),
    /Invalid caller_number/,
  );
});
