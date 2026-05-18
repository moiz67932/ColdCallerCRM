import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyExtractedProfile } from "@/lib/demo-agent/contracts";
import { createElevenLabsAppointmentRequest } from "@/lib/elevenlabs/create-appointment-request";

type Row = Record<string, unknown>;

process.env.ELEVENLABS_TOOL_SECRET = "test-secret";

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makeDb(options: { conversationUpdateThrows?: boolean; appointmentTypes?: Row[] } = {}) {
  const extractedProfile = createEmptyExtractedProfile("https://clinic.example");
  extractedProfile.clinic.name = "Glow Clinic";
  extractedProfile.clinic.timezone = "America/New_York";

  const state = {
    bindings: [
      {
        id: "binding-1",
        leadId: "lead-1",
        leadDemoProfileId: "profile-1",
        organizationId: "org-1",
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
        organizationId: "org-1",
        clinicId: "clinic-1",
        agentId: "agent-db-1",
        extractedProfileJson: extractedProfile,
      },
    ] as Row[],
    appointmentTypes: (options.appointmentTypes ?? []) as Row[],
    appointmentTypeProviders: [
      {
        id: "atp-1",
        organizationId: "org-1",
        appointmentTypeId: "type-1",
        providerId: "provider-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ] as Row[],
    appointments: [] as Row[],
    conversations: [
      {
        id: "conversation-row-1",
        conversationId: "conversation-1",
        metadataJson: { existing: true },
      },
    ] as Row[],
    conversationUpdateAttempts: 0,
    warnings: [] as unknown[][],
  };

  const db = {
    elevenlabsDemoBinding: {
      findUnique: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
      findFirst: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
    },
    leadDemoProfile: {
      findUnique: async ({ where }: { where: Row }) => state.profiles.find((row) => matchesWhere(row, where)) ?? null,
    },
    appointmentType: {
      findMany: async ({ where }: { where: Row }) => state.appointmentTypes.filter((row) => matchesWhere(row, where)),
    },
    appointmentTypeProvider: {
      findFirst: async ({ where }: { where: Row }) =>
        state.appointmentTypeProviders.find((row) => matchesWhere(row, where)) ?? null,
    },
    appointment: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `appointment-${state.appointments.length + 1}`, ...data };
        state.appointments.push(row);
        return row;
      },
    },
    elevenlabsConversation: {
      findUnique: async ({ where }: { where: Row }) => state.conversations.find((row) => matchesWhere(row, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        state.conversationUpdateAttempts += 1;
        if (options.conversationUpdateThrows) throw new Error("conversation update unavailable");
        const row = state.conversations.find((entry) => matchesWhere(entry, where));
        if (!row) throw new Error("conversation not found");
        Object.assign(row, data);
        return row;
      },
    },
  };

  return {
    db,
    state,
    logger: {
      warn: (...args: unknown[]) => state.warnings.push(args),
    },
  };
}

function validInput(overrides: Row = {}) {
  return {
    conversation_id: "conversation-1",
    caller_number: "(714) 555-0101",
    called_number: "+1 (310) 555-0123",
    patient_name: "Avery Lee",
    patient_phone: "(714) 555-9999",
    patient_email: "avery@example.com",
    service_name: "Hydrafacial",
    preferred_date: "2026-06-01",
    preferred_time: "3:00 PM",
    notes: "Prefers afternoon.",
    insurance_info: { carrier: "Aetna" },
    ...overrides,
  };
}

async function importRoute() {
  return import("@/app/api/elevenlabs/tools/create-appointment-request/route");
}

function routeRequest(body: Row, token?: string) {
  return new Request("http://localhost/api/elevenlabs/tools/create-appointment-request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }) as never;
}

test("create-appointment-request route returns 401 for missing or wrong auth", async () => {
  const { POST } = await importRoute();

  const missing = await POST(routeRequest(validInput()));
  const wrong = await POST(routeRequest(validInput(), "wrong-secret"));

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
});

test("create-appointment-request route returns 400 when patient_name is missing", async () => {
  const { POST } = await importRoute();
  const body: Row = validInput();
  delete body.patient_name;

  const response = await POST(routeRequest(body, "test-secret"));
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error, "invalid_request");
});

test("createElevenLabsAppointmentRequest returns 400 for invalid date/time", async () => {
  const { db } = makeDb();

  await assert.rejects(
    createElevenLabsAppointmentRequest(validInput({ preferred_date: "sometime soon" }), { db: db as never }),
    { name: "CreateAppointmentRequestError", error: "missing_or_invalid_time", status: 400 },
  );
});

test("active caller/called binding creates scheduled ai appointment", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsAppointmentRequest(validInput(), { db: db as never });
  const appointment = state.appointments[0];

  assert.equal(result.ok, true);
  assert.equal(result.status, "created");
  assert.equal(appointment.source, "ai");
  assert.equal(appointment.status, "scheduled");
  assert.equal(appointment.callSessionId, "conversation-1");
  assert.equal(appointment.patientPhoneMasked, "+1******9999");
  assert.equal(appointment.callerPhone, "+17145559999");
  assert.equal((appointment.startTime as Date).toISOString(), "2026-06-01T19:00:00.000Z");
  assert.equal((appointment.endTime as Date).toISOString(), "2026-06-01T19:30:00.000Z");
});

test("appointment type exact match sets appointment_type_id and duration", async () => {
  const { db, state } = makeDb({
    appointmentTypes: [
      {
        id: "type-1",
        organizationId: "org-1",
        clinicId: "clinic-1",
        name: "Hydrafacial",
        durationMinutes: 45,
        active: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
  });

  await createElevenLabsAppointmentRequest(validInput(), { db: db as never });
  const appointment = state.appointments[0];

  assert.equal(appointment.appointmentTypeId, "type-1");
  assert.equal(appointment.providerId, "provider-1");
  assert.equal((appointment.endTime as Date).toISOString(), "2026-06-01T19:45:00.000Z");
});

test("missing appointment type still creates appointment with default duration", async () => {
  const { db, state } = makeDb();

  await createElevenLabsAppointmentRequest(validInput(), { db: db as never });
  const appointment = state.appointments[0];

  assert.equal(appointment.appointmentTypeId, null);
  assert.equal(appointment.providerId, null);
  assert.equal((appointment.endTime as Date).toISOString(), "2026-06-01T19:30:00.000Z");
});

test("created appointment includes clinic_id and organization_id", async () => {
  const { db, state } = makeDb();

  const result = await createElevenLabsAppointmentRequest(validInput(), { db: db as never });
  const appointment = state.appointments[0];

  assert.equal(result.clinic_id, "clinic-1");
  assert.equal(result.organization_id, "org-1");
  assert.equal(appointment.clinicId, "clinic-1");
  assert.equal(appointment.organizationId, "org-1");
});

test("conversation metadata update failure does not break creation", async () => {
  const { db, state, logger } = makeDb({ conversationUpdateThrows: true });

  const result = await createElevenLabsAppointmentRequest(validInput(), { db: db as never, logger });

  assert.equal(result.ok, true);
  assert.equal(state.appointments.length, 1);
  assert.equal(state.conversationUpdateAttempts, 1);
  assert.equal(state.warnings.length, 1);
});
