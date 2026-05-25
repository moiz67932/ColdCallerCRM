import "server-only";

import crypto from "crypto";

import { env, requireEnv } from "@/lib/env";

export const SQUARE_SIGNATURE_HEADER = "x-square-hmacsha256-signature";

export type SquareWebhookConfig = {
  signatureKey: string;
  notificationUrl?: string;
};

export type VerifySquareWebhookSignatureInput = {
  rawBody: string;
  signatureHeader: string | null;
  notificationUrl: string;
  signatureKey?: string;
};

export type NormalizedSquareWebhookEvent = {
  eventId: string | null;
  eventType: string | null;
  merchantId: string | null;
  createdAt: string | null;
  dataId: string | null;
  object: unknown;
  raw: unknown;
};

export type SquarePaymentWebhookIds = {
  paymentId: string | null;
  orderId: string | null;
  status: string | null;
};

type SquareWebhookEvent = {
  event_id?: string;
  type?: string;
  merchant_id?: string;
  created_at?: string;
  data?: {
    id?: string;
    object?: {
      payment?: {
        id?: string;
        order_id?: string;
        status?: string;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export function getSquareWebhookConfig(): SquareWebhookConfig {
  return {
    signatureKey: requireEnv("SQUARE_WEBHOOK_SIGNATURE_KEY").trim(),
    notificationUrl: env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim() || undefined,
  };
}

export function verifySquareWebhookSignature(input: VerifySquareWebhookSignatureInput): boolean {
  const signatureKey = input.signatureKey?.trim() || requireEnv("SQUARE_WEBHOOK_SIGNATURE_KEY").trim();
  const notificationUrl = input.notificationUrl.trim();
  const signatureHeader = input.signatureHeader?.trim();

  if (!notificationUrl) {
    throw new Error("Missing Square webhook notification URL.");
  }

  if (!signatureHeader) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", signatureKey)
    .update(`${notificationUrl}${input.rawBody}`, "utf8")
    .digest("base64");

  return safeCompareBase64(expectedSignature, signatureHeader);
}

export function parseSquareWebhookEvent(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid Square webhook JSON payload.");
  }
}

export function normalizeSquareWebhookEvent(event: unknown): NormalizedSquareWebhookEvent {
  const squareEvent = asSquareWebhookEvent(event);

  return {
    eventId: squareEvent.event_id ?? null,
    eventType: squareEvent.type ?? null,
    merchantId: squareEvent.merchant_id ?? null,
    createdAt: squareEvent.created_at ?? null,
    dataId: squareEvent.data?.id ?? null,
    object: squareEvent.data?.object ?? null,
    raw: event,
  };
}

export function isSquarePaymentUpdatedEvent(event: unknown): boolean {
  return asSquareWebhookEvent(event).type === "payment.updated";
}

export function extractSquarePaymentIdsFromEvent(event: unknown): SquarePaymentWebhookIds {
  const squareEvent = asSquareWebhookEvent(event);
  const payment = squareEvent.data?.object?.payment;

  return {
    paymentId: payment?.id ?? squareEvent.data?.id ?? null,
    orderId: payment?.order_id ?? null,
    status: payment?.status ?? null,
  };
}

function safeCompareBase64(expectedSignature: string, signatureHeader: string): boolean {
  let expected: Buffer;
  let actual: Buffer;

  try {
    expected = Buffer.from(expectedSignature, "base64");
    actual = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

function asSquareWebhookEvent(event: unknown): SquareWebhookEvent {
  if (!event || typeof event !== "object") {
    return {};
  }

  return event as SquareWebhookEvent;
}
