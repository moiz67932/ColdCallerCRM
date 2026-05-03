import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { logInfo } from "@/lib/logger";
import { prisma } from "@/lib/workstation-db";
import { parseTelnyxEvent } from "@/lib/telnyx/events";
import { verifyTelnyxSignature } from "@/lib/telnyx/signature";
import { processVoiceWebhookEvent } from "@/lib/telnyx/webhook-processor";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("telnyx-signature-ed25519");
  const timestampHeader = request.headers.get("telnyx-timestamp");

  let parsedEvent;

  try {
    parsedEvent = parseTelnyxEvent(rawBody);
  } catch {
    const eventId = `raw-${createHash("sha256").update(`${timestampHeader ?? "no-ts"}|${rawBody}`).digest("hex")}`;

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
    `raw-${createHash("sha256").update(`${timestampHeader ?? "no-ts"}|${rawBody}`).digest("hex")}`;

  const callControlId =
    typeof parsedEvent.data.payload?.call_control_id === "string"
      ? parsedEvent.data.payload.call_control_id
      : undefined;

  try {
    const stored = await prisma.telnyxWebhookEvent.create({
      data: {
        eventId,
        eventType: parsedEvent.data.event_type,
        callControlId,
        payloadJson: parsedEvent,
        signatureVerified: signatureResult.verified,
        processingError: signatureResult.verified ? null : signatureResult.reason,
      },
    });

    if (!signatureResult.verified) {
      return NextResponse.json({ accepted: false, error: signatureResult.reason }, { status: 401 });
    }

    await processVoiceWebhookEvent(stored.id, parsedEvent);

    return NextResponse.json({ accepted: true });
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("duplicate")) {
      logInfo("Duplicate Telnyx webhook ignored", {
        eventId,
      });

      return NextResponse.json({ accepted: true, duplicate: true });
    }

    return NextResponse.json({ accepted: false }, { status: 500 });
  }
}
