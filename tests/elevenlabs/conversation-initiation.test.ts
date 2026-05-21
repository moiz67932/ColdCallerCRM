import test from "node:test";
import assert from "node:assert/strict";

import { buildElevenLabsConversationInitiationClientData } from "@/lib/elevenlabs/conversation-initiation";
import { hasValidElevenLabsToolBearerAuth } from "@/lib/elevenlabs/tool-auth";

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

function compactContext(overrides: Row = {}) {
  return {
    clinic_name: "SG Essentials Med Spa",
    lead_id: "lead-1",
    binding_id: "binding-1",
    phone_e164: "+13103318914",
    service_categories_short: "injectables and facials",
    service_menu_short: "Botox and Dysport, fillers, Kybella",
    safe_service_names: ["Botox and Dysport", "fillers", "Kybella"],
    safe_service_names_text: "Botox and Dysport, fillers, Kybella",
    facials_list_text: "New Client Facial and Clarifying Acne Facial",
    injectables_list_text: "Botox and Dysport, fillers, and Kybella",
    pricing_lookup_text: "Clarifying Acne Facial: starts at $120",
    booking_cta: "Would you like to book a consultation?",
    clinic_phone: "+13103318914",
    location_short: "Los Angeles, CA",
    hours_short: "Mon 09:00-17:00",
    context_text: "raw context must not leak",
    services: [{ name: "Raw Service", description: "scraped description must not leak" }],
    faqs: [{ question: "Raw FAQ", answer: "must not leak" }],
    ...overrides,
  };
}

function makeDb(overrides: { binding?: Row; extraBindings?: Row[]; profiles?: Row[] } = {}) {
  const binding = {
    id: "binding-1",
    organizationId: "org-1",
    leadId: "lead-1",
    leadDemoProfileId: "profile-1",
    elevenlabsAgentId: "agent_6401kreh55f0fpnaxj1q5s9p4w01",
    callerE164: "+923351897839",
    phoneE164: "+13103318914",
    status: "active",
    createdAt: new Date("2026-05-10T00:00:00Z"),
    voiceContextCompactJson: compactContext(),
    ...overrides.binding,
  };
  const state = {
    bindings: [binding, ...(overrides.extraBindings ?? [])] as Row[],
    profiles: overrides.profiles ?? [] as Row[],
  };

  const db = {
    elevenlabsDemoBinding: {
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

function body(overrides: Row = {}) {
  return {
    conversation_id: "precall_test_1",
    caller_number: "923351897839",
    called_number: "13103318914",
    agent_id: "agent_6401kreh55f0fpnaxj1q5s9p4w01",
    ...overrides,
  };
}

function dynamicVariables(result: Awaited<ReturnType<typeof buildElevenLabsConversationInitiationClientData>>) {
  assert.equal(result.type, "conversation_initiation_client_data");
  return result.dynamic_variables;
}

test("conversation initiation resolves valid caller_number with plus and called_number with plus", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(
    await buildElevenLabsConversationInitiationClientData(body({ caller_number: "+923351897839", called_number: "+13103318914" }), { db: db as never }),
  );

  assert.equal(variables.active_context_resolved, true);
  assert.equal(variables.clinic_name, "SG Essentials Med Spa");
  assert.equal(variables.binding_id, "binding-1");
  assert.equal(variables.precall_match_type, "caller_and_called");
});

test("conversation initiation resolves valid caller_number without plus and called_number without plus", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body(), { db: db as never }));

  assert.equal(variables.active_context_resolved, true);
  assert.equal(variables.lead_id, "lead-1");
  assert.equal(variables.service_menu_short, "Botox and Dysport, fillers, Kybella");
  assert.equal(variables.service_categories_short, "injectables and facials");
  assert.equal(variables.facials_list_text, "New Client Facial and Clarifying Acne Facial");
  assert.equal(variables.pricing_lookup_text, "Clarifying Acne Facial: starts at $120");
});

test("conversation initiation falls back by called_number only", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body({ caller_number: "+19495550101" }), { db: db as never }));

  assert.equal(variables.active_context_resolved, true);
  assert.equal(variables.precall_match_type, "called_number_fallback");
});

test("conversation initiation no binding found returns unresolved 200 payload", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body({ called_number: "15555550123" }), { db: db as never }));

  assert.equal(variables.active_context_resolved, false);
  assert.equal(variables.context_error, "no_active_demo_binding_found");
  assert.equal(variables.precall_match_type, "none");
});

test("conversation initiation auth rejects missing bearer token", () => {
  const headers = new Headers();

  assert.equal(hasValidElevenLabsToolBearerAuth(headers, "test-secret"), false);
});

test("conversation initiation auth rejects invalid bearer token", () => {
  const headers = new Headers({ authorization: "Bearer wrong-secret" });

  assert.equal(hasValidElevenLabsToolBearerAuth(headers, "test-secret"), false);
});

test("conversation initiation missing compact context returns unresolved payload", async () => {
  const { db } = makeDb({ binding: { voiceContextCompactJson: {} } });

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body(), { db: db as never }));

  assert.equal(variables.active_context_resolved, false);
  assert.equal(variables.context_error, "missing_compact_context");
});

test("conversation initiation dynamic_variables contains only primitive values", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body(), { db: db as never }));

  for (const value of Object.values(variables)) {
    assert.ok(["string", "number", "boolean"].includes(typeof value));
  }
});

test("conversation initiation converts safe_service_names array to safe_service_names_text string", async () => {
  const { db } = makeDb();

  const variables = dynamicVariables(await buildElevenLabsConversationInitiationClientData(body(), { db: db as never }));

  assert.equal(variables.safe_service_names_text, "Botox and Dysport, fillers, Kybella");
});

test("conversation initiation does not return raw context, service arrays, FAQs, or scraped descriptions", async () => {
  const { db } = makeDb();

  const result = await buildElevenLabsConversationInitiationClientData(body(), { db: db as never });
  const serialized = JSON.stringify(result);

  assert.equal("context_text" in result.dynamic_variables, false);
  assert.equal("services" in result.dynamic_variables, false);
  assert.equal("faqs" in result.dynamic_variables, false);
  assert.doesNotMatch(serialized, /raw context|Raw Service|Raw FAQ|scraped description/i);
});
