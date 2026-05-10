import test from "node:test";
import assert from "node:assert/strict";

import { activateElevenLabsLeadDemoAgent } from "@/lib/elevenlabs/runtime";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makeDb(input: { phoneNumber?: string | null; clinicId?: string | null; agentId?: string | null }) {
  const state = {
    leads: [
      {
        id: "lead-1",
        phoneNumber: input.phoneNumber ?? "(714) 555-0101",
      },
    ],
    profiles: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        leadId: "lead-1",
        status: "ready",
        isDemoReady: true,
        demoReadyBlockers: [],
        clinicId: Object.hasOwn(input, "clinicId") ? input.clinicId : "22222222-2222-4222-8222-222222222222",
        agentId: Object.hasOwn(input, "agentId") ? input.agentId : "33333333-3333-4333-8333-333333333333",
        lastActivatedAt: null,
      },
    ] as Row[],
    bindings: [] as Row[],
    activations: [] as Row[],
  };

  const db = {
    lead: {
      findUnique: async ({ where }: { where: Row }) => state.leads.find((row) => matchesWhere(row, where)) ?? null,
    },
    leadDemoProfile: {
      findUnique: async ({ where }: { where: Row }) => state.profiles.find((row) => matchesWhere(row, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const profile = state.profiles.find((row) => matchesWhere(row, where));
        if (!profile) throw new Error("Record not found");
        Object.assign(profile, data);
        return profile;
      },
    },
    elevenlabsDemoBinding: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = state.bindings.filter((row) => matchesWhere(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return rows;
      },
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: `binding-${state.bindings.length + 1}`,
          ...data,
        };
        state.bindings.push(row);
        return row;
      },
    },
    leadDemoActivation: {
      create: async ({ data }: { data: Row }) => {
        state.activations.push(data);
        return data;
      },
    },
  };

  return { db, state };
}

const config = {
  organizationId: "44444444-4444-4444-8444-444444444444",
  elevenlabsAgentId: "elevenlabs-agent-1",
  phoneE164: "+13105550123",
};

test("activateElevenLabsLeadDemoAgent creates an active binding and marks profile active", async () => {
  const { db, state } = makeDb({});

  const result = await activateElevenLabsLeadDemoAgent("lead-1", {
    db: db as never,
    config,
  });

  assert.equal(result.provider, "elevenlabs");
  assert.equal(result.callerE164, "+17145550101");
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].status, "active");
  assert.equal(state.bindings[0].leadDemoProfileId, "11111111-1111-4111-8111-111111111111");
  assert.equal(state.bindings[0].metadataJson && typeof state.bindings[0].metadataJson === "object", true);
  assert.equal(state.profiles[0].status, "active");
  assert.ok(state.profiles[0].lastActivatedAt);
  assert.equal(state.activations.length, 1);
});

test("activateElevenLabsLeadDemoAgent replaces previous active binding on repeated activation", async () => {
  const { db, state } = makeDb({});

  await activateElevenLabsLeadDemoAgent("lead-1", {
    db: db as never,
    config,
  });
  await activateElevenLabsLeadDemoAgent("lead-1", {
    db: db as never,
    config,
  });

  assert.equal(state.bindings.length, 2);
  assert.equal(state.bindings.filter((row) => row.status === "active").length, 1);
  assert.equal(state.bindings.filter((row) => row.status === "replaced").length, 1);
});

test("activateElevenLabsLeadDemoAgent allows null caller routing when phone normalization fails", async () => {
  const { db, state } = makeDb({ phoneNumber: "not-a-phone", clinicId: null });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (() => {
    throw new Error("ElevenLabs activation should not call deployed runtime refresh");
  }) as typeof fetch;

  try {
    const result = await activateElevenLabsLeadDemoAgent("lead-1", {
      db: db as never,
      config,
    });

    assert.equal(result.callerE164, null);
    assert.match(result.warning ?? "", /Could not normalize lead phone number/);
    assert.equal(state.bindings[0].callerE164, null);
    assert.equal(state.activations.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
