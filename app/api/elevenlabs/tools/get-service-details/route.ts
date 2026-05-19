import { NextRequest, NextResponse } from "next/server";

import { requireEnv } from "@/lib/env";
import { getElevenLabsServiceDetails } from "@/lib/elevenlabs/get-service-details";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

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
    return toolFailureResponse("Invalid JSON payload.", null, null);
  }

  if (!isRecord(body)) {
    return toolFailureResponse("Invalid request body.", null, null);
  }

  const input = {
    conversation_id: firstString(body.conversation_id, atPath(body, ["data", "conversation_id"])) ?? "unknown",
    agent_id: firstString(body.agent_id, atPath(body, ["data", "agent_id"])) ?? "unknown",
    caller_number: firstString(body.caller_number, body.caller_id, atPath(body, ["metadata", "caller_number"])),
    called_number: firstString(body.called_number, body.destination_number, body.inbound_number, atPath(body, ["metadata", "called_number"])),
    service_name: firstString(body.service_name, body.service, body.query, atPath(body, ["metadata", "service_name"])),
  };

  if (!input.caller_number || !input.called_number || !input.service_name) {
    return toolFailureResponse("caller_number, called_number, and service_name are required.", input.conversation_id, input.agent_id);
  }

  try {
    const result = await getElevenLabsServiceDetails({
      conversation_id: input.conversation_id,
      agent_id: input.agent_id,
      caller_number: input.caller_number,
      called_number: input.called_number,
      service_name: input.service_name,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Unexpected ElevenLabs get-service-details tool error.", error);
    return toolFailureResponse("Unexpected get-service-details tool error.", input.conversation_id, input.agent_id);
  }
}
