import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { logInfo } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { prisma } from "@/lib/workstation-db";
import { parseTelnyxEvent } from "@/lib/telnyx/events";
import { verifyTelnyxSignature } from "@/lib/telnyx/signature";
import { processVoiceWebhookEvent } from "@/lib/telnyx/webhook-processor";

export const runtime = "nodejs";

function getStringPayloadValue(payload: Record<string, unknown> | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function getVoiceWebhookReceiptContext(parsedEvent: ReturnType<typeof parseTelnyxEvent>, eventId: string) {
  const payload = parsedEvent.data.payload;

  return {
    eventId,
    event_type: parsedEvent.data.event_type,
    occurred_at: parsedEvent.data.occurred_at,
    payload: {
      call_control_id: getStringPayloadValue(payload, "call_control_id"),
      call_leg_id: getStringPayloadValue(payload, "call_leg_id"),
      call_session_id: getStringPayloadValue(payload, "call_session_id"),
      connection_id: getStringPayloadValue(payload, "connection_id"),
      client_state: getStringPayloadValue(payload, "client_state"),
      from: getStringPayloadValue(payload, "from"),
      to: getStringPayloadValue(payload, "to"),
      sip_address: getStringPayloadValue(payload, "sip_address"),
      stream_url: getStringPayloadValue(payload, "stream_url"),
      stream_id: getStringPayloadValue(payload, "stream_id"),
      stream_track: getStringPayloadValue(payload, "stream_track"),
    },
    sip_transfer_targets: {
      to: getStringPayloadValue(payload, "to"),
      sip_address: getStringPayloadValue(payload, "sip_address"),
      target_sip_uri: getStringPayloadValue(payload, "target_sip_uri"),
      transfer_to: getStringPayloadValue(payload, "transfer_to"),
      refer_to: getStringPayloadValue(payload, "refer_to"),
    },
    media_streaming_state: {
      eventIsStreaming: parsedEvent.data.event_type.startsWith("streaming."),
      streamId: getStringPayloadValue(payload, "stream_id"),
      streamUrl: getStringPayloadValue(payload, "stream_url"),
      streamTrack: getStringPayloadValue(payload, "stream_track"),
      streamCodec: getStringPayloadValue(payload, "stream_codec"),
    },
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("telnyx-signature-ed25519");
  const timestampHeader = request.headers.get("telnyx-timestamp");

  let parsedEvent;

  try {
    parsedEvent = parseTelnyxEvent(rawBody);
  } catch {
    const eventId = `raw-${createHash("sha256").update(rawBody).digest("hex")}`;

    try {
      await prisma.telnyxWebhookEvent.create({
        data: {
          eventId,
          eventType: "unknown.unparsed",
          payloadJson: {
            rawBody,
          },
          signatureVerified: false,
          processingError: "Malformed webhook payload",
        },
      });
    } catch {
      // Ignore duplicate malformed payload inserts.
    }

    return NextResponse.json({ accepted: false, error: "Malformed webhook payload" }, { status: 400 });
  }

  const signatureResult = verifyTelnyxSignature({
    rawBody,
    signatureHeader,
    timestampHeader,
  });

  const eventId =
    parsedEvent.data.id ??
    `raw-${createHash("sha256").update(rawBody).digest("hex")}`;

  const callControlId =
    typeof parsedEvent.data.payload?.call_control_id === "string"
      ? parsedEvent.data.payload.call_control_id
      : undefined;

  try {
    logInfo("Telnyx voice webhook received", {
      ...getVoiceWebhookReceiptContext(parsedEvent, eventId),
      signatureVerified: signatureResult.verified,
      signatureError: signatureResult.verified ? undefined : signatureResult.reason,
    });

    if (!signatureResult.verified) {
      return NextResponse.json({ accepted: false, error: signatureResult.reason }, { status: 401 });
    }
    // Verify before insertion: unsigned deliveries cannot poison a valid event ID.
    // A conflict is retried unless the event was actually processed successfully.
    const db = getSupabaseAdmin();
    const { error: insertError } = await db.from("workstation_telnyx_webhook_events").upsert({
      event_id: eventId, event_type: parsedEvent.data.event_type, call_control_id: callControlId,
      payload_json: parsedEvent, signature_verified: true,
    }, { onConflict: "event_id", ignoreDuplicates: true });
    if (insertError) throw new Error(insertError.message);
    const { data: stored, error: readError } = await db.from("workstation_telnyx_webhook_events")
      .select("id,signature_verified").eq("event_id", eventId).single();
    if (readError || !stored) throw new Error(readError?.message ?? "Webhook persistence failed");
    if (!stored.signature_verified) {
      const { error } = await db.from("workstation_telnyx_webhook_events").update({
        signature_verified: true, payload_json: parsedEvent, processing_error: null,
      }).eq("id", stored.id);
      if (error) throw new Error(error.message);
    }
    parsedEvent.data.id = eventId;

    await processVoiceWebhookEvent(stored.id, parsedEvent);

    return NextResponse.json({ accepted: true });
  } catch {
    return NextResponse.json({ accepted: false }, { status: 500 });
  }
}
