import test from "node:test";
import assert from "node:assert/strict";

import { createElevenLabsBookingRequest } from "@/lib/elevenlabs/create-booking-request";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "in" in value) {
      return Array.isArray(value.in) && value.in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function makeDb() {
  const state = {
    bindings: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "44444444-4444-4444-8444-444444444444",
        leadId: "lead-1",
        leadDemoProfileId: "22222222-2222-4222-8222-222222222222",
        callerE164: "+923351897839",
        phoneE164: "+13103318914",
        status: "active",
        createdAt: new Date("2026-05-10T00:00:00Z"),
        voiceContextCompactJson: {
          clinic_name: "SG Essentials Med Spa",
          lead_id: "lead-1",
          binding_id: "11111111-1111-4111-8111-111111111111",
          phone_e164: "+13103318914",
          service_menu_short: "Botox and Dysport, fillers, Kybella",
          safe_service_names: ["Botox and Dysport", "fillers", "Kybella"],
          booking_cta: "Would you like to book a consultation?",
          clinic_phone: "+13103318914",
          location_short: "Los Angeles, CA",
          hours_short: "Mon 09:00-17:00",
          timezone: "America/Los_Angeles",
        },
      },
    ] as Row[],
    requests: [] as Row[],
  };

  const db = {
    elevenlabsDemoBinding: {
      findUnique: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) => (where ? state.bindings.filter((row) => matchesWhere(row, where)) : state.bindings),
    },
    appointmentRequest: {
      findFirst: async ({ where }: { where?: Row } = {}) => state.requests.find((row) => (where ? matchesWhere(row, where) : true)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `request-${state.requests.length + 1}`, createdAt: new Date(), ...data };
        state.requests.push(row);
        return row;
      },
    },
  };

  return { db, state };
}

function validInput(overrides: Row = {}) {
  return {
    conversation_id: "conversation-1",
    caller_number: "923351897839",
    called_number: "13103318914",
    agent_id: "agent_6401kreh55f0fpnaxj1q5s9p4w01",
    client_name: "Avery Lee",
    service_requested: "Botox",
    preferred_date_time: "2026-06-01 3:00 PM",
    new_or_existing: "new",
    special_requests: "Prefers afternoon.",
    ...overrides,
  };
}

test("createElevenLabsBookingRequest saves valid booking with caller_number without plus", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsBookingRequest(validInput(), { db: db as never });

  assert.equal(result.ok, true);
  assert.equal(result.status, "saved");
  assert.equal(result.request_id, "request-1");
  assert.equal(state.requests[0].status, "pending");
  assert.equal(state.requests[0].callerE164, "+923351897839");
  assert.equal(state.requests[0].phoneE164, "+923351897839");
  assert.equal((state.requests[0].rawPayload as Row).service_match_status, "matched");
});

test("createElevenLabsBookingRequest saves valid booking with caller_number with plus", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsBookingRequest(validInput({ caller_number: "+923351897839" }), { db: db as never });

  assert.equal(result.ok, true);
  assert.equal(result.request_id, "request-1");
  assert.equal(state.requests[0].callerE164, "+923351897839");
});

test("createElevenLabsBookingRequest resolves missing binding_id by caller and called number", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsBookingRequest(validInput({ binding_id: undefined }), { db: db as never });

  assert.equal(result.ok, true);
  assert.equal(state.requests[0].bindingId, "11111111-1111-4111-8111-111111111111");
});

test("createElevenLabsBookingRequest duplicate request returns same request_id", async () => {
  const { db } = makeDb();

  const first = await createElevenLabsBookingRequest(validInput(), { db: db as never });
  const second = await createElevenLabsBookingRequest(validInput(), { db: db as never });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.request_id, first.request_id);
});

test("createElevenLabsBookingRequest missing required field returns ok false", async () => {
  const { db } = makeDb();
  const input = validInput();
  delete input.client_name;

  const result = await createElevenLabsBookingRequest(input as never, { db: db as never });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.reason, "missing_required_field");
});

test("createElevenLabsBookingRequest date parsing failure still saves pending request", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsBookingRequest(validInput({ preferred_date_time: "sometime next week after lunch" }), { db: db as never });

  assert.equal(result.ok, true);
  assert.equal(state.requests[0].status, "pending");
  assert.equal(state.requests[0].preferredDateTimeStart, null);
  assert.equal((state.requests[0].rawPayload as Row).date_parse_status, "unparsed");
});

test("createElevenLabsBookingRequest unconfirmed service still saves pending request", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsBookingRequest(validInput({ service_requested: "Laser hair removal" }), { db: db as never });

  assert.equal(result.ok, true);
  assert.equal((state.requests[0].rawPayload as Row).service_match_status, "unconfirmed_service");
});
