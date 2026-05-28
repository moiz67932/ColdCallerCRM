import { normalizePhoneDigits } from "@/lib/phone";
import type { VoiceContextCompact } from "@/lib/elevenlabs/voice-context";
import type { ActiveDemoBindingMatchType } from "@/lib/elevenlabs/demo-binding-resolver";
import { getSharedDemoVoiceContextWithBackendPricing, portiveFaqText, portivePolicyText } from "@/lib/elevenlabs/shared-demo-context";

type JsonRecord = Record<string, unknown>;
type DynamicVariableValue = string | number | boolean;
type ConversationInitiationResponse = {
  type: "conversation_initiation_client_data";
  dynamic_variables: Record<string, DynamicVariableValue>;
};

type ConversationInitiationDeps = {
  db?: unknown;
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

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function emptyDynamicVariables(contextError: string, precallMatchType: ActiveDemoBindingMatchType | "error"): Record<string, DynamicVariableValue> {
  return {
    active_context_resolved: false,
    context_error: contextError,
    clinic_name: "",
    service_categories_short: "",
    service_menu_short: "",
    service_menu_spoken_short: "",
    services_by_category_text: "",
    safe_service_names_text: "",
    facials_list_text: "",
    facials_list_spoken_short: "",
    injectables_list_text: "",
    injectables_list_spoken_short: "",
    laser_list_text: "",
    laser_list_spoken_short: "",
    skin_list_text: "",
    skin_list_spoken_short: "",
    wellness_list_text: "",
    wellness_list_spoken_short: "",
    body_list_text: "",
    body_list_spoken_short: "",
    waxing_brows_list_text: "",
    lashes_list_text: "",
    pricing_lookup_text: "",
    services_with_pricing_and_deposits_text: "",
    bookable_services_with_deposits_text: "",
    exact_service_pricing_text: "",
    deposit_policy_text: "",
    voice_quality_score: 0,
    voice_context_warnings: contextError,
    location_short: "",
    hours_short: "",
    booking_cta: "",
    clinic_timezone: "",
    faqs_short: "",
    policy_short: "",
    lead_id: "",
    binding_id: "",
    lead_demo_profile_id: "",
    precall_match_type: precallMatchType,
    match_type: precallMatchType,
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

function pricingServiceCount(context: VoiceContextCompact) {
  return context.services_with_pricing_and_deposits_text
    .split(".")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .length;
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
    service_categories_short: truncate(input.context.service_categories_short, 300),
    service_menu_short: truncate(input.context.service_menu_short, 300),
    service_menu_spoken_short: truncate(input.context.service_menu_spoken_short || input.context.service_menu_short, 300),
    services_by_category_text: truncate(input.context.services_by_category_text, 4000),
    safe_service_names_text: truncate(input.context.safe_service_names_text || safeServiceNamesText(input.context), 1200),
    facials_list_text: truncate(input.context.facials_list_text, 1400),
    facials_list_spoken_short: truncate(input.context.facials_list_spoken_short, 300),
    injectables_list_text: truncate(input.context.injectables_list_text, 1400),
    injectables_list_spoken_short: truncate(input.context.injectables_list_spoken_short, 300),
    laser_list_text: truncate(input.context.laser_list_text, 1400),
    laser_list_spoken_short: truncate(input.context.laser_list_spoken_short, 300),
    skin_list_text: truncate(input.context.skin_list_text, 1400),
    skin_list_spoken_short: truncate(input.context.skin_list_spoken_short, 300),
    wellness_list_text: truncate(input.context.wellness_list_text, 1400),
    wellness_list_spoken_short: truncate(input.context.wellness_list_spoken_short, 300),
    body_list_text: truncate(input.context.body_list_text, 1400),
    body_list_spoken_short: truncate(input.context.body_list_spoken_short, 300),
    waxing_brows_list_text: truncate(input.context.waxing_brows_list_text, 700),
    lashes_list_text: truncate(input.context.lashes_list_text, 700),
    pricing_lookup_text: truncate(input.context.pricing_lookup_text, 700),
    services_with_pricing_and_deposits_text: truncate(input.context.services_with_pricing_and_deposits_text, 4000),
    bookable_services_with_deposits_text: truncate(input.context.bookable_services_with_deposits_text, 4000),
    exact_service_pricing_text: truncate(input.context.exact_service_pricing_text, 4000),
    deposit_policy_text: truncate(input.context.deposit_policy_text, 500),
    voice_quality_score: input.context.voice_quality_score,
    voice_context_warnings: truncate(input.context.voice_context_warnings, 500),
    location_short: truncate(input.context.location_short, 300),
    hours_short: truncate(input.context.hours_short, 300),
    booking_cta: truncate(input.context.booking_cta, 300),
    clinic_timezone: truncate(input.context.timezone ?? "", 100),
    faqs_short: truncate(portiveFaqText(), 900),
    policy_short: truncate(portivePolicyText(), 500),
    lead_id: String(input.leadId ?? ""),
    binding_id: String(input.bindingId ?? ""),
    lead_demo_profile_id: String(input.leadDemoProfileId ?? ""),
    context_error: "",
    precall_match_type: input.matchType,
    match_type: input.matchType,
  };
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
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const input = normalizeConversationInitiationInput(body);
  const callerDigits = normalizePhoneDigits(input.caller_number);
  const calledDigits = normalizePhoneDigits(input.called_number);

  try {
    const context = await getSharedDemoVoiceContextWithBackendPricing();
    const servicesWithPricingAndDepositsText = context.services_with_pricing_and_deposits_text;

    console.info("ElevenLabs conversation-initiation shared demo context.", {
      route: "/api/elevenlabs/hooks/conversation-initiation",
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      normalized_caller_digits: callerDigits,
      normalized_called_digits: calledDigits,
      match_type: "shared_demo_context",
      binding_id: null,
      lead_id: null,
      has_services_with_pricing_and_deposits_text: Boolean(servicesWithPricingAndDepositsText.trim()),
      services_with_pricing_and_deposits_text_length: servicesWithPricingAndDepositsText.length,
      deposit_policy_text: context.deposit_policy_text,
      pricing_service_count: pricingServiceCount(context),
      clinic_name: context.clinic_name,
      duration_ms: Math.round(nowMs() - startedAt),
    });

    return response(
      compactContextDynamicVariables({
        context,
        leadId: "",
        bindingId: "",
        leadDemoProfileId: "",
        matchType: "called_number_fallback",
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
