import { normalizePhoneDigits } from "@/lib/phone";
import { prisma } from "@/lib/workstation-db";
import { parseVoiceContextCompact, type VoiceContextCompact } from "@/lib/elevenlabs/voice-context";
import { resolveActiveDemoBindingForCall, type ActiveDemoBindingMatchType } from "@/lib/elevenlabs/demo-binding-resolver";

type ResolveDb = typeof prisma;
type JsonRecord = Record<string, unknown>;
type DynamicVariableValue = string | number | boolean;
type ConversationInitiationResponse = {
  type: "conversation_initiation_client_data";
  dynamic_variables: Record<string, DynamicVariableValue>;
};

type ConversationInitiationDeps = {
  db?: ResolveDb;
  nowMs?: () => number;
};

type NormalizedConversationInitiationInput = {
  conversation_id: string | null;
  agent_id: string | null;
  caller_number: string | null;
  called_number: string | null;
};

const RESPONSE_TYPE = "conversation_initiation_client_data" as const;

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

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function emptyDynamicVariables(contextError: string, precallMatchType: ActiveDemoBindingMatchType | "error"): Record<string, DynamicVariableValue> {
  return {
    active_context_resolved: false,
    context_error: contextError,
    clinic_name: "",
    service_menu_short: "",
    safe_service_names_text: "",
    location_short: "",
    hours_short: "",
    booking_cta: "",
    lead_id: "",
    binding_id: "",
    lead_demo_profile_id: "",
    precall_match_type: precallMatchType,
  };
}

function response(dynamicVariables: Record<string, DynamicVariableValue>): ConversationInitiationResponse {
  return {
    type: RESPONSE_TYPE,
    dynamic_variables: dynamicVariables,
  };
}

function safeServiceNamesText(context: VoiceContextCompact) {
  return truncate(context.safe_service_names.join(", "), 800);
}

function compactContextDynamicVariables(input: {
  context: VoiceContextCompact;
  leadId: unknown;
  bindingId: unknown;
  leadDemoProfileId: unknown;
  matchType: Exclude<ActiveDemoBindingMatchType, "none">;
}): Record<string, DynamicVariableValue> {
  return {
    active_context_resolved: true,
    clinic_name: truncate(input.context.clinic_name, 200),
    service_menu_short: truncate(input.context.service_menu_short, 600),
    safe_service_names_text: safeServiceNamesText(input.context),
    location_short: truncate(input.context.location_short, 300),
    hours_short: truncate(input.context.hours_short, 300),
    booking_cta: truncate(input.context.booking_cta, 300),
    lead_id: String(input.leadId ?? ""),
    binding_id: String(input.bindingId ?? ""),
    lead_demo_profile_id: String(input.leadDemoProfileId ?? ""),
    context_error: "",
    precall_match_type: input.matchType,
  };
}

async function buildMinimalContextFromProfile(binding: JsonRecord, db: ResolveDb) {
  const leadDemoProfileId = typeof binding.leadDemoProfileId === "string" ? binding.leadDemoProfileId : null;
  if (!leadDemoProfileId) return null;

  const profile = await db.leadDemoProfile.findUnique({ where: { id: leadDemoProfileId } });
  const clinicName = cleanText(profile?.businessName);
  if (!clinicName) return null;

  return {
    clinic_name: clinicName,
    lead_id: String(binding.leadId ?? ""),
    binding_id: String(binding.id ?? ""),
    phone_e164: cleanText(binding.phoneE164),
    service_menu_short: "",
    safe_service_names: [],
    booking_cta: "Would you like to book a consultation?",
    clinic_phone: cleanText(binding.phoneE164),
    location_short: "",
    hours_short: "",
  } satisfies VoiceContextCompact;
}

export function normalizeConversationInitiationInput(body: unknown): NormalizedConversationInitiationInput {
  const dynamicVariables = atPath(body, ["dynamic_variables"]);
  const metadata = atPath(body, ["metadata"]);

  return {
    conversation_id: firstString(
      atPath(body, ["conversation_id"]),
      atPath(metadata, ["conversation_id"]),
      atPath(dynamicVariables, ["system__conversation_id"]),
    ),
    agent_id: firstString(atPath(body, ["agent_id"]), atPath(metadata, ["agent_id"]), atPath(dynamicVariables, ["system__agent_id"])),
    caller_number: firstString(
      atPath(body, ["caller_number"]),
      atPath(body, ["caller_id"]),
      atPath(body, ["from"]),
      atPath(metadata, ["caller_number"]),
      atPath(metadata, ["caller_id"]),
      atPath(dynamicVariables, ["system__caller_id"]),
    ),
    called_number: firstString(
      atPath(body, ["called_number"]),
      atPath(body, ["to"]),
      atPath(body, ["phone_number"]),
      atPath(metadata, ["called_number"]),
      atPath(metadata, ["phone_number"]),
      atPath(dynamicVariables, ["system__called_number"]),
    ),
  };
}

export async function buildElevenLabsConversationInitiationClientData(
  body: unknown,
  deps: ConversationInitiationDeps = {},
): Promise<ConversationInitiationResponse> {
  const db = deps.db ?? prisma;
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const input = normalizeConversationInitiationInput(body);
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  try {
    const lookup = await resolveActiveDemoBindingForCall(
      {
        callerNumber: input.caller_number,
        calledNumber: input.called_number,
        agentId: input.agent_id,
      },
      { db },
    );
    const durationMs = Math.round(nowMs() - startedAt);

    if (!lookup.binding) {
      console.info("ElevenLabs conversation-initiation lookup.", {
        route: "/api/elevenlabs/hooks/conversation-initiation",
        conversation_id: input.conversation_id,
        agent_id: input.agent_id,
        normalized_caller_digits: callerDigits,
        normalized_called_digits: calledDigits,
        match_type: "none",
        binding_id: null,
        lead_id: null,
        duration_ms: durationMs,
      });

      return response(emptyDynamicVariables("no_active_demo_binding_found", "none"));
    }

    const binding = lookup.binding as JsonRecord;
    const cachedContext = parseVoiceContextCompact(binding.voiceContextCompactJson);
    const context = cachedContext ?? (await buildMinimalContextFromProfile(binding, db));

    if (!context) {
      console.info("ElevenLabs conversation-initiation lookup.", {
        route: "/api/elevenlabs/hooks/conversation-initiation",
        conversation_id: input.conversation_id,
        agent_id: input.agent_id,
        normalized_caller_digits: callerDigits,
        normalized_called_digits: calledDigits,
        match_type: lookup.matchType,
        binding_id: binding.id ?? null,
        lead_id: binding.leadId ?? null,
        duration_ms: Math.round(nowMs() - startedAt),
      });

      return response(emptyDynamicVariables("missing_compact_context", lookup.matchType));
    }

    console.info("ElevenLabs conversation-initiation lookup.", {
      route: "/api/elevenlabs/hooks/conversation-initiation",
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      normalized_caller_digits: callerDigits,
      normalized_called_digits: calledDigits,
      match_type: lookup.matchType,
      binding_id: binding.id ?? null,
      lead_id: binding.leadId ?? null,
      duration_ms: Math.round(nowMs() - startedAt),
    });

    return response(
      compactContextDynamicVariables({
        context,
        leadId: binding.leadId,
        bindingId: binding.id,
        leadDemoProfileId: binding.leadDemoProfileId,
        matchType: lookup.matchType === "caller_and_called" ? "caller_and_called" : "called_number_fallback",
      }),
    );
  } catch (error) {
    console.error("Unexpected ElevenLabs conversation-initiation lookup error.", {
      route: "/api/elevenlabs/hooks/conversation-initiation",
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      normalized_caller_digits: callerDigits,
      normalized_called_digits: calledDigits,
      duration_ms: Math.round(nowMs() - startedAt),
      error,
    });

    return response(emptyDynamicVariables("precall_context_error", "error"));
  }
}
