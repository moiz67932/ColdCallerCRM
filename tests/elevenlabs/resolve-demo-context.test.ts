import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile } from "@/lib/demo-agent/contracts";
import { resolveElevenLabsDemoContext } from "@/lib/elevenlabs/resolve-demo-context";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
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
        callerE164: "+17145550101",
        phoneE164: "+13105550123",
        status: "active",
        createdAt: new Date("2026-05-10T00:00:00Z"),
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
      findFirst: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
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
      caller_number: "(714) 555-0101",
      called_number: "+1 (310) 555-0123",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolved, true);
  assert.equal(result.caller_e164, "+17145550101");
  assert.equal(result.phone_e164, "+13105550123");
  assert.equal(result.lead_id, "lead-1");
  assert.match(result.context_text, /Bright Smile Dental/);
  assert.match(result.context_text, /Teeth Whitening/);
  assert.equal(result.context.clinic.name, "Bright Smile Dental");
  assert.equal(result.context.services[0].name, "Teeth Whitening");
  assert.equal(result.context.hours.monday.open, true);
  assert.equal(result.context.faqs[0].question, "Do you accept insurance?");
});

test("resolveElevenLabsDemoContext returns not_found when no active exact caller/called binding matches", async () => {
  const { db } = makeDb();

  const result = await resolveElevenLabsDemoContext(
    {
      conversation_id: "conversation-1",
      caller_number: "(949) 555-0101",
      called_number: "+1 (310) 555-0123",
      agent_id: "elevenlabs-agent-1",
    },
    { db: db as never },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
});

test("resolveElevenLabsDemoContext rejects invalid phone input", async () => {
  const { db } = makeDb();

  await assert.rejects(
    resolveElevenLabsDemoContext(
      {
        conversation_id: "conversation-1",
        caller_number: "not-a-phone",
        called_number: "+1 (310) 555-0123",
        agent_id: "elevenlabs-agent-1",
      },
      { db: db as never },
    ),
    /Invalid caller_number/,
  );
});
