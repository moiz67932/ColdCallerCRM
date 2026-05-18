import { NextRequest, NextResponse } from "next/server";

import { jsonError } from "@/lib/http";
import { handleElevenLabsPostCallWebhook, verifyElevenLabsWebhookRequest } from "@/lib/elevenlabs/post-call-webhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("Invalid JSON payload.", 400);
  }

  // ElevenLabs tools use ELEVENLABS_TOOL_SECRET Bearer auth. Post-call webhooks
  // are authenticated separately with ElevenLabs-Signature HMAC over the raw body.
  if (!verifyElevenLabsWebhookRequest(request, rawBody)) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const result = await handleElevenLabsPostCallWebhook(payload);

    return NextResponse.json({
      ok: true,
      stored: result.stored,
      conversation_id: result.conversation_id,
      linked: result.linked,
    });
  } catch (error) {
    console.error("Unexpected ElevenLabs post-call webhook error.", error);
    return jsonError("Unexpected ElevenLabs post-call webhook error.", 500);
  }
}
