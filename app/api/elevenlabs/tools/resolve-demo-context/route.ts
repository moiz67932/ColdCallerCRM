import { NextRequest, NextResponse } from "next/server";

import { requireEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { resolveElevenLabsDemoContext } from "@/lib/elevenlabs/resolve-demo-context";
import { normalizePhoneDigits } from "@/lib/phone";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;
type NormalizedResolveInput = {
  conversation_id: string;
  agent_id: string;
  caller_number: string | null;
  called_number: string | null;
};
type ResolverInput = {
  conversation_id: string;
  agent_id: string;
  caller_number: string;
  called_number: string;
};

// ElevenLabs tool calls are configured with Bearer auth using ELEVENLABS_TOOL_SECRET.
// Post-call webhooks use ElevenLabs-Signature HMAC verification instead.
function getBearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

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

function missingCallContextResponse(conversationId: string | null, agentId: string | null) {
  return NextResponse.json({
    ok: false,
    status: "missing_call_context",
    resolved: false,
    reason: "caller_number or called_number missing",
    agent_instruction: "Do not answer clinic specific questions. Say the active phone demo could not be resolved from this test context.",
    conversation_id: conversationId,
    agent_id: agentId,
  });
}

function toolFailureResponse(reason: string, conversationId: string | null, agentId: string | null) {
  return NextResponse.json({
    ok: false,
    status: "tool_error",
    resolved: false,
    reason,
    conversation_id: conversationId,
    agent_id: agentId,
  });
}

function normalizeResolveInput(body: JsonRecord): NormalizedResolveInput {
  const callerNumber = firstString(
    body.caller_number,
    body.caller_id,
    body.phone_number,
    body.phone_e164,
    atPath(body, ["metadata", "caller_number"]),
    atPath(body, ["metadata", "caller_id"]),
    atPath(body, ["metadata", "phone_number"]),
    atPath(body, ["conversation_initiation_client_data", "dynamic_variables", "system__caller_id"]),
    atPath(body, ["data", "metadata", "caller_id"]),
  );
  const callerCameFromPhoneE164 = callerNumber === firstString(body.phone_e164);
  const calledNumber = firstString(
    body.called_number,
    body.destination_number,
    body.inbound_number,
    atPath(body, ["metadata", "called_number"]),
    atPath(body, ["metadata", "destination_number"]),
    atPath(body, ["metadata", "inbound_number"]),
    atPath(body, ["conversation_initiation_client_data", "dynamic_variables", "system__called_number"]),
    atPath(body, ["data", "metadata", "called_number"]),
    callerCameFromPhoneE164 ? undefined : body.phone_e164,
  );

  return {
    conversation_id:
      firstString(body.conversation_id, atPath(body, ["data", "conversation_id"]), atPath(body, ["conversation", "id"]), atPath(body, ["call", "conversation_id"])) ??
      "unknown",
    agent_id: firstString(body.agent_id, atPath(body, ["data", "agent_id"]), atPath(body, ["agent", "id"])) ?? "unknown",
    caller_number: callerNumber,
    called_number: calledNumber,
  };
}

function logResolveDemoContextRequest(request: NextRequest, body: unknown) {
  const record = isRecord(body) ? body : {};
  const normalized = normalizeResolveInput(record);

  console.info("ElevenLabs resolve-demo-context request.", {
    body_keys: Object.keys(record),
    caller_number: normalized.caller_number,
    called_number: normalized.called_number,
    normalized_caller_digits: normalizePhoneDigits(normalized.caller_number),
    normalized_called_digits: normalizePhoneDigits(normalized.called_number),
    agent_id: normalized.agent_id,
    conversation_id: normalized.conversation_id,
  });
}

export async function POST(request: NextRequest) {
  const expectedToken = requireEnv("ELEVENLABS_TOOL_SECRET");
  const token = getBearerToken(request);

  if (!token || token !== expectedToken) {
    return jsonError("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.warn("ElevenLabs resolve-demo-context received invalid JSON.");
    return toolFailureResponse("Invalid JSON payload.", null, null);
  }

  logResolveDemoContextRequest(request, body);

  if (!isRecord(body)) {
    return toolFailureResponse("Invalid request body.", null, null);
  }

  const input = normalizeResolveInput(body);

  if (!input.caller_number || !input.called_number) {
    return missingCallContextResponse(input.conversation_id, input.agent_id);
  }

  const resolverInput: ResolverInput = {
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    caller_number: input.caller_number,
    called_number: input.called_number,
  };

  try {
    const result = await resolveElevenLabsDemoContext(resolverInput);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Unexpected ElevenLabs resolve-demo-context tool error.", error);
    return toolFailureResponse("Unexpected resolve-demo-context tool error.", resolverInput.conversation_id, resolverInput.agent_id);
  }
}
