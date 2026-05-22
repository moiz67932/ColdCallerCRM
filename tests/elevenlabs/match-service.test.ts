import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile, createExtractedService } from "@/lib/demo-agent/contracts";

type Row = Record<string, unknown>;

process.env.ELEVENLABS_TOOL_SECRET = "test-secret";

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makeDb() {
  const profile = createEmptyExtractedProfile("https://clinic.example");
  profile.clinic.name = "Glow Clinic";
  profile.services = [
    createExtractedService({
      name: "Hydrafacial",
      aliases: ["Hydra Facial", "Hydro Facial"],
      description: "Hydrating facial treatment.",
      duration_minutes: 45,
      price_text: "Starts at $199",
      price_min_cents: 19900,
      bookable: true,
      source_url: "https://clinic.example/services",
      confidence: 0.92,
    }),
    createExtractedService({
      name: "Botox",
      aliases: ["Tox"],
      description: "Wrinkle relaxer.",
      duration_minutes: 30,
      price_text: null,
      price_min_cents: null,
      bookable: true,
      source_url: "https://clinic.example/botox",
      confidence: 0.88,
    }),
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
        leadId: "lead-1",
        extractedProfileJson: profile,
      },
    ] as Row[],
  };

  const db = {
    elevenlabsDemoBinding: {
      findUnique: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
      findFirst: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
    },
    leadDemoProfile: {
      findUnique: async ({ where }: { where: Row }) => state.profiles.find((row) => matchesWhere(row, where)) ?? null,
    },
  };

  return { db, state };
}

async function importRoute() {
  return import("@/app/api/elevenlabs/tools/match-service/route");
}

async function importMatcher() {
  return import("@/lib/elevenlabs/match-service");
}

function routeRequest(token?: string) {
  return new Request("http://localhost/api/elevenlabs/tools/match-service", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      lead_demo_profile_id: "profile-1",
      spoken_service: "Hydrafacial",
    }),
  }) as never;
}

test("match-service route returns 401 for missing or wrong auth", async () => {
  const { POST } = await importRoute();

  const missing = await POST(routeRequest());
  const wrong = await POST(routeRequest("wrong-secret"));

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
});

test("matchElevenLabsService exact service match works", async () => {
  const { db } = makeDb();
  const { matchElevenLabsService } = await importMatcher();
  const result = await matchElevenLabsService(
    {
      lead_demo_profile_id: "profile-1",
      spoken_service: "Hydrafacial",
    },
    { db: db as never },
  );

  assert.equal(result.matched, true);
  assert.equal(result.service_name, "Hydrafacial");
  assert.equal(result.match_type, "exact");
  assert.equal(result.confidence, 1);
});

test("matchElevenLabsService alias service match works", async () => {
  const { db } = makeDb();
  const { matchElevenLabsService } = await importMatcher();
  const result = await matchElevenLabsService(
    {
      lead_demo_profile_id: "profile-1",
      spoken_service: "Hydro Facial",
    },
    { db: db as never },
  );

  assert.equal(result.matched, true);
  assert.equal(result.service_name, "Hydrafacial");
  assert.equal(result.match_type, "alias");
  assert.equal(result.confidence, 1);
});

test("matchElevenLabsService fuzzy matches hydrofacem to Hydrafacial", async () => {
  const { db } = makeDb();
  const { matchElevenLabsService } = await importMatcher();
  const result = await matchElevenLabsService(
    {
      lead_demo_profile_id: "profile-1",
      spoken_service: "hydrofacem",
    },
    { db: db as never },
  );

  assert.equal(result.matched, true);
  assert.equal(result.service_name, "Hydrafacial");
  assert.equal(result.match_type, "fuzzy");
  assert.equal(result.confidence >= 0.82, true);
});

test("matchElevenLabsService low-confidence unknown service returns unmatched with candidates", async () => {
  const { db } = makeDb();
  const { matchElevenLabsService } = await importMatcher();
  const result = await matchElevenLabsService(
    {
      lead_demo_profile_id: "profile-1",
      spoken_service: "oil change",
    },
    { db: db as never },
  );

  assert.equal(result.matched, false);
  assert.equal(result.message, "No confident service match found.");
  assert.equal(result.candidates.length > 0, true);
});

test("matchElevenLabsService resolves profile through active caller and called number binding", async () => {
  const { db } = makeDb();
  const { matchElevenLabsService } = await importMatcher();
  const result = await matchElevenLabsService(
    {
      caller_number: "(714) 555-0101",
      called_number: "+1 (310) 555-0123",
      spoken_service: "hydrofacem",
    },
    { db: db as never },
  );

  assert.equal(result.matched, true);
  assert.equal(result.service_name, "Hydrafacial");
});
