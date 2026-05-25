import { createHash } from "node:crypto";

import { after } from "next/server";
import { NextRequest } from "next/server";

import { prisma } from "@/lib/workstation-db";
import { parseTelnyxEvent } from "@/lib/telnyx/events";
import { verifyTelnyxSignature } from "@/lib/telnyx/signature";
import { processMessagingWebhookEvent } from "@/lib/telnyx/webhook-processor";
import { failJson, okJson } from "@/lib/api/paid-appointment-response";

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

    return failJson(
      { errorCode: "VALIDATION_FAILED", step: "parse_telnyx_webhook", message: "Malformed webhook payload" },
      { status: 400 },
    );
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
      return failJson(
        {
          errorCode: "INVALID_TELNYX_SIGNATURE",
          step: "verify_signature",
          message: "Invalid Telnyx webhook signature.",
          safeDetails: { reason: signatureResult.reason },
        },
        { status: 401 },
      );
    }

    after(() => {
      void processMessagingWebhookEvent(stored.id, parsedEvent);
    });

    return okJson(
      { accepted: true, event_type: parsedEvent.data.event_type },
      { step: "telnyx_webhook_accepted", message: "Telnyx messaging webhook accepted." },
    );
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("duplicate")) {
      return okJson(
        { accepted: true, duplicate: true, event_type: parsedEvent.data.event_type },
        { step: "telnyx_webhook_duplicate_ignored", message: "Duplicate Telnyx messaging webhook ignored." },
      );
    }

    return failJson(
      { errorCode: "TELNYX_WEBHOOK_STORE_FAILED", step: "store_telnyx_webhook", message: "Unable to store Telnyx webhook." },
      { status: 500 },
    );
  }
}
