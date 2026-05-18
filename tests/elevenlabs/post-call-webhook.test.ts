import test from "node:test";
import assert from "node:assert/strict";

import {
  extractElevenLabsConversationFields,
  handleElevenLabsPostCallWebhook,
  verifyElevenLabsWebhookRequest,
} from "@/lib/elevenlabs/post-call-webhook";

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Row) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makeDb() {
  const state = {
    bindings: [
      {
        id: "binding-1",
        organizationId: "11111111-1111-1111-1111-111111111111",
        leadId: "lead-1",
        leadDemoProfileId: "22222222-2222-2222-2222-222222222222",
        callerE164: "+17145550101",
        phoneE164: "+13105550123",
        status: "active",
        createdAt: new Date("2026-05-10T00:00:00Z"),
      },
    ] as Row[],
    conversations: [] as Row[],
  };

  const db = {
    elevenlabsDemoBinding: {
      findFirst: async ({ where }: { where: Row }) => state.bindings.find((row) => matchesWhere(row, where)) ?? null,
    },
    elevenlabsConversation: {
      findUnique: async ({ where }: { where: Row }) => state.conversations.find((row) => matchesWhere(row, where)) ?? null,
      findFirst: async ({ where }: { where: Row }) => state.conversations.find((row) => matchesWhere(row, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `conversation-row-${state.conversations.length + 1}`, ...data };
        state.conversations.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const index = state.conversations.findIndex((row) => matchesWhere(row, where));
        if (index === -1) throw new Error("Record not found");
        state.conversations[index] = { ...state.conversations[index], ...data };
        return state.conversations[index];
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const row = state.conversations.find((entry) => matchesWhere(entry, where));
        if (!row) {
          const created = { id: `conversation-row-${state.conversations.length + 1}`, ...create };
          state.conversations.push(created);
          return created;
        }
        Object.assign(row, update);
        return row;
      },
    },
  };

  return { db, state };
}

test("handleElevenLabsPostCallWebhook stores a valid minimal payload with conversation_id", async () => {
  const { db, state } = makeDb();

  const result = await handleElevenLabsPostCallWebhook(
    {
      conversation_id: "conv-1",
      type: "post_call",
    },
    { db: db as never, now: new Date("2026-05-14T00:00:00Z") },
  );

  assert.equal(result.stored, true);
  assert.equal(result.conversation_id, "conv-1");
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].conversationId, "conv-1");
  assert.deepEqual(state.conversations[0].rawPayloadJson, { conversation_id: "conv-1", type: "post_call" });
});

test("handleElevenLabsPostCallWebhook links caller and called numbers to active binding", async () => {
  const { db, state } = makeDb();

  const result = await handleElevenLabsPostCallWebhook(
    {
      data: { conversation_id: "conv-linked" },
      caller_number: "(714) 555-0101",
      called_number: "+1 (310) 555-0123",
    },
    { db: db as never },
  );

  assert.equal(result.linked, true);
  assert.equal(state.conversations[0].leadId, "lead-1");
  assert.equal(state.conversations[0].leadDemoProfileId, "22222222-2222-2222-2222-222222222222");
  assert.equal(state.conversations[0].organizationId, "11111111-1111-1111-1111-111111111111");
});

test("extractElevenLabsConversationFields joins transcript array text in order", () => {
  const fields = extractElevenLabsConversationFields({
    conversation_id: "conv-transcript",
    transcript: [
      { role: "agent", message: "Thanks for calling." },
      { role: "user", text: "I want whitening." },
    ],
  });

  assert.equal(fields.transcript, "agent: Thanks for calling.\nuser: I want whitening.");
});

test("handleElevenLabsPostCallWebhook tolerates missing optional fields", async () => {
  const { db, state } = makeDb();

  const result = await handleElevenLabsPostCallWebhook({}, { db: db as never });

  assert.equal(result.stored, true);
  assert.equal(result.conversation_id, null);
  assert.equal(result.linked, false);
  assert.equal(state.conversations.length, 1);
  assert.deepEqual(state.conversations[0].rawPayloadJson, {});
});

test("handleElevenLabsPostCallWebhook updates an existing conversation_id instead of duplicating", async () => {
  const { db, state } = makeDb();

  await handleElevenLabsPostCallWebhook(
    {
      conversation_id: "conv-upsert",
      summary: "Initial summary.",
    },
    { db: db as never },
  );
  await handleElevenLabsPostCallWebhook(
    {
      conversation_id: "conv-upsert",
      summary: "Updated summary.",
      analysis: { transcript: "Updated transcript." },
    },
    { db: db as never },
  );

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].summaryText, "Updated summary.");
  assert.equal(state.conversations[0].transcript, "Updated transcript.");
});

test("verifyElevenLabsWebhookRequest rejects wrong shared secret when configured", () => {
  const request = new Request("http://localhost/api/webhooks/elevenlabs/post-call", {
    method: "POST",
    headers: { "x-elevenlabs-webhook-secret": "wrong" },
  });

  assert.equal(verifyElevenLabsWebhookRequest(request, "{}", { secret: "expected" }), false);
});
