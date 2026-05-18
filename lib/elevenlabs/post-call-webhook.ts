import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";

type PostCallDb = typeof prisma;
type JsonRecord = Record<string, unknown>;

type HandleOptions = {
  db?: PostCallDb;
  now?: Date;
};

type VerifyOptions = {
  secret?: string;
  now?: Date;
  toleranceSeconds?: number;
};

export type ExtractedElevenLabsConversationFields = {
  conversationId: string | null;
  elevenlabsAgentId: string | null;
  callerE164: string | null;
  calledE164: string | null;
  status: "received" | "started" | "completed" | "failed" | "unknown";
  transcript: string | null;
  summaryText: string | null;
  summaryJson: JsonRecord;
  analysisJson: JsonRecord;
  metadataJson: JsonRecord;
  rawPayloadJson: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type HandleElevenLabsPostCallWebhookResult = {
  ok: true;
  stored: true;
  conversation_id: string | null;
  linked: boolean;
  row: JsonRecord | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return null;
}

function atPath(source: unknown, path: string[]) {
  let current = source;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeOptionalPhone(value: string | null) {
  return value ? normalizePhoneNumber(value) : null;
}

function parseTimestamp(value: unknown) {
  const raw = firstString(value);
  if (!raw) return null;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function transcriptText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();

  if (!Array.isArray(value)) return null;

  const lines = value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (!isRecord(entry)) return "";

      const text = firstString(entry.text, entry.message, entry.content, entry.transcript);
      if (!text) return "";

      const speaker = firstString(entry.speaker, entry.role);
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean);

  return lines.length ? lines.join("\n") : null;
}

function deriveStatus(payload: unknown): ExtractedElevenLabsConversationFields["status"] {
  const text = [
    firstString(atPath(payload, ["event"]), atPath(payload, ["type"]), atPath(payload, ["event_type"]), atPath(payload, ["status"])),
    firstString(atPath(payload, ["data", "event"]), atPath(payload, ["data", "type"]), atPath(payload, ["data", "status"])),
    firstString(atPath(payload, ["conversation", "status"]), atPath(payload, ["call", "status"])),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return "received";
  if (/\b(fail|failed|error|errored|cancelled|canceled)\b/.test(text)) return "failed";
  if (/\b(complete|completed|post_call|post-call|transcription)\b/.test(text)) return "completed";
  if (/\b(start|started|initiated|in_progress|in-progress)\b/.test(text)) return "started";
  return "unknown";
}

function summaryParts(payload: unknown) {
  const rawSummary = atPath(payload, ["summary"]) ?? atPath(payload, ["analysis", "summary"]) ?? atPath(payload, ["data", "analysis", "summary"]);

  if (typeof rawSummary === "string") {
    return { summaryText: rawSummary.trim() || null, summaryJson: {} };
  }

  if (isRecord(rawSummary)) {
    return {
      summaryText: firstString(rawSummary.text, rawSummary.summary, rawSummary.value),
      summaryJson: rawSummary,
    };
  }

  return { summaryText: null, summaryJson: {} };
}

function extractAnalysisJson(payload: unknown) {
  const analysis = atPath(payload, ["analysis"]) ?? atPath(payload, ["data", "analysis"]);
  const dataCollectionResults = atPath(payload, ["data_collection_results"]) ?? atPath(payload, ["data", "data_collection_results"]);

  return {
    ...(isRecord(analysis) ? analysis : {}),
    ...(dataCollectionResults !== undefined ? { data_collection_results: dataCollectionResults } : {}),
  };
}

export function extractElevenLabsConversationFields(payload: unknown): ExtractedElevenLabsConversationFields {
  const callerRaw = firstString(
    atPath(payload, ["caller_number"]),
    atPath(payload, ["user_id"]),
    atPath(payload, ["metadata", "caller_id"]),
    atPath(payload, ["metadata", "phone_number"]),
    atPath(payload, ["conversation_initiation_client_data", "dynamic_variables", "system__caller_id"]),
    atPath(payload, ["data", "metadata", "caller_id"]),
  );
  const calledRaw = firstString(
    atPath(payload, ["called_number"]),
    atPath(payload, ["metadata", "called_number"]),
    atPath(payload, ["conversation_initiation_client_data", "dynamic_variables", "system__called_number"]),
  );
  const callerE164 = normalizeOptionalPhone(callerRaw);
  const calledE164 = normalizeOptionalPhone(calledRaw);
  const { summaryText, summaryJson } = summaryParts(payload);

  const metadataJson: JsonRecord = {
    extracted: {
      callerRaw,
      calledRaw,
      callerNormalized: callerE164,
      calledNormalized: calledE164,
    },
    notes: [
      ...(callerRaw && !callerE164 ? ["caller_number_not_normalized"] : []),
      ...(calledRaw && !calledE164 ? ["called_number_not_normalized"] : []),
    ],
  };

  return {
    conversationId: firstString(
      atPath(payload, ["conversation_id"]),
      atPath(payload, ["data", "conversation_id"]),
      atPath(payload, ["conversation", "id"]),
      atPath(payload, ["call", "conversation_id"]),
    ),
    elevenlabsAgentId: firstString(atPath(payload, ["agent_id"]), atPath(payload, ["data", "agent_id"]), atPath(payload, ["agent", "id"])),
    callerE164,
    calledE164,
    status: deriveStatus(payload),
    transcript: transcriptText(atPath(payload, ["transcript"]) ?? atPath(payload, ["data", "transcript"]) ?? atPath(payload, ["analysis", "transcript"])),
    summaryText,
    summaryJson,
    analysisJson: extractAnalysisJson(payload),
    metadataJson,
    rawPayloadJson: payload ?? {},
    startedAt: parseTimestamp(
      atPath(payload, ["started_at"]) ?? atPath(payload, ["start_time"]) ?? atPath(payload, ["data", "started_at"]) ?? atPath(payload, ["conversation", "started_at"]),
    ),
    endedAt: parseTimestamp(atPath(payload, ["ended_at"]) ?? atPath(payload, ["end_time"]) ?? atPath(payload, ["data", "ended_at"]) ?? atPath(payload, ["conversation", "ended_at"])),
  };
}

function omitUndefined(input: JsonRecord) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function findActiveBinding(db: PostCallDb, callerE164: string | null, calledE164: string | null) {
  if (!callerE164 || !calledE164) return null;

  return db.elevenlabsDemoBinding.findFirst({
    where: {
      callerE164,
      phoneE164: calledE164,
      status: "active",
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function handleElevenLabsPostCallWebhook(payload: unknown, options: HandleOptions = {}): Promise<HandleElevenLabsPostCallWebhookResult> {
  const db = options.db ?? prisma;
  const receivedAt = options.now ?? new Date();
  const fields = extractElevenLabsConversationFields(payload);

  const existing = fields.conversationId
    ? await db.elevenlabsConversation.findUnique({
        where: { conversationId: fields.conversationId },
      })
    : null;
  const binding = existing?.leadId ? null : await findActiveBinding(db, fields.callerE164, fields.calledE164);

  const leadId = binding?.leadId ?? existing?.leadId;
  const leadDemoProfileId = binding?.leadDemoProfileId ?? existing?.leadDemoProfileId;
  const organizationId = binding?.organizationId ?? existing?.organizationId;
  const linked = Boolean(leadId || leadDemoProfileId);

  const data = omitUndefined({
    conversationId: fields.conversationId ?? undefined,
    organizationId,
    leadId,
    leadDemoProfileId,
    elevenlabsAgentId: fields.elevenlabsAgentId ?? existing?.elevenlabsAgentId,
    callerE164: fields.callerE164 ?? existing?.callerE164,
    calledE164: fields.calledE164 ?? existing?.calledE164,
    status: fields.status,
    transcript: fields.transcript ?? existing?.transcript,
    summaryText: fields.summaryText ?? existing?.summaryText,
    summaryJson: fields.summaryJson,
    analysisJson: fields.analysisJson,
    metadataJson: {
      ...fields.metadataJson,
      linked,
      bindingId: binding?.id ?? null,
    },
    rawPayloadJson: fields.rawPayloadJson,
    startedAt: fields.startedAt ?? existing?.startedAt,
    endedAt: fields.endedAt ?? existing?.endedAt,
    receivedAt,
  });

  const row = fields.conversationId
    ? await db.elevenlabsConversation.upsert({
        where: { conversationId: fields.conversationId },
        create: data,
        update: data,
      })
    : await db.elevenlabsConversation.create({ data });

  return {
    ok: true,
    stored: true,
    conversation_id: fields.conversationId,
    linked,
    row: isRecord(row) ? row : null,
  };
}

function parseElevenLabsSignature(signature: string | null) {
  if (!signature) return null;

  const parts = Object.fromEntries(
    signature.split(",").map((part) => {
      const [key, ...valueParts] = part.split("=");
      return [key.trim(), valueParts.join("=").trim()];
    }),
  );

  return {
    timestamp: parts.t,
    signature: parts.v0,
  };
}

function secureCompare(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyElevenLabsWebhookRequest(request: Request, rawBody = "", options: VerifyOptions = {}) {
  const secret = options.secret ?? env.ELEVENLABS_WEBHOOK_SECRET;

  if (!secret) {
    console.warn("ELEVENLABS_WEBHOOK_SECRET is not configured; accepting ElevenLabs webhook without shared-secret verification.");
    return true;
  }

  const parsed = parseElevenLabsSignature(request.headers.get("elevenlabs-signature"));
  if (!parsed?.timestamp || !parsed.signature) return false;

  const timestamp = Number(parsed.timestamp);
  if (!Number.isFinite(timestamp)) return false;

  const toleranceSeconds = options.toleranceSeconds ?? 30 * 60;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (timestamp < nowSeconds - toleranceSeconds || timestamp > nowSeconds + toleranceSeconds) return false;

  const expectedSignature = `v0=${createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`, "utf8").digest("hex")}`;

  return secureCompare(expectedSignature, `v0=${parsed.signature}`);
}
